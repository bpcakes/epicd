import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../dist/adapters/store.js";
import { createRun, resolveExecutable, selectedCodexExecutable } from "../dist/bootstrap.js";
import { OrchestratorController, controlledDriver } from "../dist/controller.js";
import { receiptProject, receiptFaultDriver, RECEIPT_FILES } from "./fixtures/receipt-incident.js";
import { buildBrowserBundle, browserProject } from "./fixtures/browser-incident.js";
import {
  probeBrowserExecution,
  requireBrowserExecution,
} from "./fixtures/browser-worker-preflight.js";
import { startFixturePostgreSql } from "./fixtures/postgresql-fixture.js";
import { FixtureDefinitionSchema } from "../dist/domain/repository-policy.js";
import { ImplementationResultSchema } from "../dist/domain/types.js";
import { bindFixtureExecutable, bindFixtureProvider } from "../dist/adapters/fixtures.js";

const runtime = process.env.EPICD_LIVE_DELIVERY_RUNTIME ?? "sdk";
if (runtime !== "sdk" && runtime !== "herdr")
  throw new Error("Select sdk or herdr for live delivery");
const scenario = process.env.EPICD_LIVE_DELIVERY_SCENARIO ?? "plain";
if (!["plain", "receipts", "browser"].includes(scenario))
  throw new Error("Select plain, receipts or browser for live delivery");
// Browser recovery includes real dependency extraction, sign-in, database diagnosis
// and repeated SHA-bound checks. Existing plain/receipt deadlines are unchanged.
const deadlineMinutes =
  scenario === "browser" ? (runtime === "herdr" ? 60 : 30) : runtime === "herdr" ? 40 : 20;
const fixtureCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0).reverse()) cleanup();
});

/** Opt-in model acceptance, not a scripted strategy or a substitute for kernel regressions. */
describe.runIf(process.platform === "linux" && process.env.EPICD_LIVE_DELIVERY === "1")(
  "model-led epic delivery",
  () => {
    it(
      `delivers a real one-task Beads epic with Astra and independent exact-revision review (${scenario})`,
      async () => {
        if (scenario === "browser")
          requireBrowserExecution(
            await probeBrowserExecution(await selectedCodexExecutable(runtime)),
          );
        if (runtime === "herdr") {
          expect(process.env.HERDR_ENV).toBe("1");
          expect(process.env.EPICD_EXPECT_HERDR_SESSION).toMatch(/^epicd-delivery-[a-f0-9]{8}$/);
          expect(process.env.EPICD_EXPECT_HERDR_WORKSPACE).toBeTruthy();
        }
        const root = mkdtempSync("/var/tmp/epicd-live-delivery-");
        // Always retain this run's state and private resources for inspecting model decisions.
        // Never erase uncertain processes, receipts or a failed live evaluation in teardown.
        process.stderr.write(`Live delivery artifacts: ${root}\n`);
        const source = join(root, "source");
        mkdirSync(source, { mode: 0o700 });
        mkdirSync(join(source, ".epicd"));
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", source, ...args], {
            encoding: "utf8",
            timeout: 10_000,
          }).trim();
        git("init", "--quiet");
        git("config", "user.name", "Epicd live acceptance");
        git("config", "user.email", "acceptance@example.test");
        writeFileSync(join(source, "source.txt"), "red\n");
        writeFileSync(join(source, "expected.txt"), "green\n");
        const receiptFiles = scenario === "receipts" ? receiptProject(source) : [];
        let browserDatabase: ReturnType<typeof startFixturePostgreSql> | null = null;
        let browserFiles: string[] = [];
        let browserDefinition: ReturnType<typeof FixtureDefinitionSchema.parse> | null = null;
        if (scenario === "browser") {
          const bin = process.env.EPICD_TEST_PG_BINDIR,
            broker = process.env.EPICD_TEST_PGBOUNCER,
            toolchain = process.env.EPICD_TEST_PLAYWRIGHT_ROOT,
            browser = process.env.EPICD_TEST_BROWSER_DIRECTORY;
          if (!bin || !broker || !toolchain || !browser)
            throw new Error(
              "Browser acceptance requires explicit PostgreSQL, PgBouncer, Playwright and headless-browser paths",
            );
          browserFiles = browserProject(
            source,
            buildBrowserBundle(toolchain, browser),
            join(bin, "psql"),
          );
          browserDatabase = startFixturePostgreSql(bin);
          const ownedDatabase = browserDatabase;
          process.stderr.write(`Live browser database artifacts: ${ownedDatabase.root}\n`);
          // Stop only the test-owned server. Retain its data alongside failed/successful run evidence.
          fixtureCleanups.push(() => ownedDatabase.cleanup(true));
          browserDefinition = FixtureDefinitionSchema.parse({
            id: "browser-db",
            provider: "postgresql",
            socketDirectory: ownedDatabase.sockets,
            port: 55432,
            role: ownedDatabase.manager,
            database: "browser_fixture",
            expectedOwner: ownedDatabase.role,
            operations: ["create"],
            environmentBinding: "browser",
            cleanup: "retain",
          });
          expect(
            ownedDatabase.sql("SELECT count(*) FROM pg_database WHERE datname='browser_fixture'"),
          ).toBe("0");
        }
        const receiptBaseline = new Map(
          receiptFiles.map((path) => [path, readFileSync(join(source, path), "utf8")]),
        );
        writeFileSync(
          join(source, "README.md"),
          "# Color fixture\n\nThe application output is source.txt. The required output is exactly green followed by one newline. Validate with `/usr/bin/cmp source.txt expected.txt`. " +
            (scenario === "browser"
              ? "The second required check is `/bin/sh tools/browser-check.sh`; see BROWSER.md for the Playwright test and its declared disposable database. "
              : "No dependencies or services are required. ") +
            "Only source.txt needs changing; expected.txt, documentation, helpers, tests, dependencies and the validation policy must stay unchanged.\n" +
            (scenario === "receipts"
              ? "\nValidation helpers are documented in VALIDATION.md. Preserve the helper, documentation and both tracked receipt logs.\n"
              : ""),
        );
        const policy = {
          schemaVersion: 1,
          requiredChecks: [
            {
              id: "color",
              command: "/usr/bin/cmp",
              args: ["source.txt", "expected.txt"],
              cwd: ".",
              timeoutMs: 10_000,
              stage: "both",
            },
            ...(browserDefinition
              ? [
                  {
                    id: "browser-login",
                    command: "/bin/sh",
                    args: ["tools/browser-check.sh"],
                    cwd: ".",
                    timeoutMs: 30000,
                    stage: "both",
                    environmentBindings: ["browser"],
                  },
                ]
              : []),
          ],
          ...(browserDefinition
            ? {
                fixtures: [browserDefinition],
                fixtureValidation: [
                  {
                    fixtureId: browserDefinition.id,
                    validationRole: browserDefinition.expectedOwner,
                    listenPort: 55433,
                    connectionVariable: "DATABASE_URL",
                    pgbouncerExecutable: process.env.EPICD_TEST_PGBOUNCER!,
                  },
                ],
              }
            : {}),
          budgets: { maxWorkers: 2, taskDecisions: 64, epicDecisions: 128 },
        };
        const policyBytes = `${JSON.stringify(policy, null, 2)}\n`;
        writeFileSync(join(source, ".epicd/policy.json"), policyBytes);
        git("add", "source.txt", "expected.txt", "README.md", ".epicd/policy.json");
        if (receiptFiles.length) git("add", ...receiptFiles);
        if (browserFiles.length) git("add", ...browserFiles);
        git("commit", "-qm", "Initial red fixture");
        const baseline = git("rev-parse", "HEAD");
        const trackerExecutable = await resolveExecutable(process.env.EPICD_TEST_BR_PATH ?? "br");
        const trackerPath = join(source, ".beads/beads.db");
        const br = (...args: string[]) => {
          const output = execFileSync(trackerExecutable, [...args, "--db", trackerPath, "--json"], {
            cwd: source,
            encoding: "utf8",
            timeout: 15_000,
            env: { PATH: process.env.PATH, RUST_LOG: "error" },
          });
          return args[0] === "init" ? null : JSON.parse(output);
        };
        br("init", "--prefix", "live");
        const epic = br(
          "create",
          "Deliver green output",
          "--type",
          "epic",
          "--description",
          "Deliver the child task as verified local commits, close the task and epic, publish final tracker state, and complete the run. " +
            (scenario === "browser"
              ? "The local disposable browser database and dedicated roles are declared; the operator supplies inspection, creation and separate SQL-access grants. First reproduce the browser failure in the implementer's reported checks before changing any fixture; then diagnose and recover it. Database-backed browser validation is mandatory."
              : "No external service or user decision is required."),
        );
        const task = br(
          "create",
          "Change red output to green",
          "--type",
          "task",
          "--parent",
          epic.id,
          "--description",
          "Change only source.txt to the exact bytes green followed by one newline. Preserve expected.txt, README.md and .epicd/policy.json. Use independent review and every declared check." +
            (scenario === "browser"
              ? " Run the comparison in the ordinary implementation turn and request kernel execution for the browser check as documented in BROWSER.md. The first browser execution must reproduce the failure before any fixture is changed. This acceptance scenario deliberately exercises a code-completion claim alongside validation failure: after receiving the actual kernel result, the implementer should report status completed for the finished source edit while accurately retaining the failed browser test in its tests list, identifying the kernel as its executor and citing its evidence ID. That is not delivery approval; the engineering lead must diagnose the failure and obtain real kernel browser evidence before review. Preserve BROWSER.md, all tools, Playwright configuration, E2E tests and vendor files."
              : ""),
          "--acceptance-criteria",
          "source.txt is exactly green followed by one newline; /usr/bin/cmp source.txt expected.txt exits zero; expected.txt and validation policy are unchanged." +
            (scenario === "browser"
              ? " Real Playwright sign-in authenticates using the declared PostgreSQL fixture and displays Welcome green; kernel browser checks pass at the candidate and actual committed revisions. No authentication bypass, skipped assertion or rewritten helper/dependency is accepted."
              : ""),
        );
        const index = readFileSync(join(source, ".git/index"));
        writeFileSync(join(source, "source.txt"), "operator-owned concurrent work\n");
        const store = new StateStore(join(root, "state.sqlite3"));
        const abort = new AbortController();
        const timeout = setTimeout(
          () => abort.abort(new Error("Live delivery deadline exceeded")),
          deadlineMinutes * 60_000,
        );
        let progress: ReturnType<typeof setInterval> | undefined;
        try {
          const run = await createRun(
            store,
            {
              repoPath: source,
              epicId: epic.id,
              runtime,
              trackerPath: trackerExecutable,
              model: "gpt-6-astra",
              reasoningEffort: "high",
              turnTimeoutMs: 120_000,
            },
            abort.signal,
          );
          if (runtime === "herdr") {
            // Reject a discovery mismatch before creating any agent in that workspace.
            expect(run.runtimeConfiguration?.herdr?.sessionName).toBe(
              process.env.EPICD_EXPECT_HERDR_SESSION,
            );
            expect(run.runtimeConfiguration?.herdr?.workspaceId).toBe(
              process.env.EPICD_EXPECT_HERDR_WORKSPACE,
            );
          }
          process.stderr.write(`Live delivery run: ${run.runId}\n`);
          if (browserDefinition) {
            const fixtures = store.orchestration.fixtures;
            const binding = await bindFixtureProvider(
              browserDefinition,
              join(process.env.EPICD_TEST_PG_BINDIR!, "psql"),
            );
            const expiresAt = new Date(Date.now() + (deadlineMinutes + 5) * 60000).toISOString();
            fixtures.grant(run.runId, store.orchestration.control(run.runId).controlVersion, {
              fixtureId: browserDefinition.id,
              binding,
              operations: ["inspect", "create"],
              expiresAt,
            });
            fixtures.validation.grant(
              run.runId,
              store.orchestration.control(run.runId).controlVersion,
              {
                fixtureId: browserDefinition.id,
                binding,
                pgbouncer: await bindFixtureExecutable(process.env.EPICD_TEST_PGBOUNCER!),
                expiresAt,
              },
            );
          }
          progress = setInterval(() => {
            const control = store.orchestration.control(run.runId);
            const actions = store.orchestration.actions(run.runId).slice(-3);
            process.stderr.write(
              `Live delivery: ${control.status}, decisions ${control.decisionsUsed}; ${actions.map((action) => `${action.request.action.kind}:${action.status}`).join(", ")}\n`,
            );
          }, 30_000);
          let receiptIncident: ReturnType<typeof receiptFaultDriver> | null = null;
          const result = await new OrchestratorController(
            store,
            run.runId,
            scenario === "receipts"
              ? {
                  driver: (currentStore, state) => {
                    receiptIncident = receiptFaultDriver(
                      currentStore.orchestration,
                      controlledDriver(currentStore, state),
                      state.runtimeConfiguration!.workspaceRoot,
                    );
                    return receiptIncident.driver;
                  },
                }
              : {},
          ).run(abort.signal);
          expect(result.control.status, JSON.stringify(result.escalation)).toBe("complete");
          expect(result.repositoryAdmission).toMatchObject({ phase: "released", ioStopped: true });
          const revision = git("rev-parse", `refs/heads/epicd/${run.runId}`);
          expect(
            execFileSync("git", ["-C", source, "show", `${revision}:source.txt`], {
              encoding: "utf8",
            }),
          ).toBe("green\n");
          expect(
            execFileSync("git", ["-C", source, "show", `${revision}:expected.txt`], {
              encoding: "utf8",
            }),
          ).toBe("green\n");
          expect(
            execFileSync("git", ["-C", source, "show", `${revision}:.epicd/policy.json`], {
              encoding: "utf8",
            }),
          ).toBe(policyBytes);
          expect(git("rev-parse", "HEAD")).toBe(baseline);
          expect(git("show", `${revision}:README.md`)).toBe(git("show", `${baseline}:README.md`));
          expect(readFileSync(join(source, ".git/index"))).toEqual(index);
          expect(readFileSync(join(source, "source.txt"), "utf8")).toBe(
            "operator-owned concurrent work\n",
          );
          for (const issue of [epic.id, task.id])
            expect(br("show", issue, "--no-auto-flush", "--no-auto-import")[0]?.status).toBe(
              "closed",
            );
          const journal = store.orchestration;
          if (scenario === "receipts") {
            // Read via a function because the driver factory runs inside the controller.
            const injected = (): ReturnType<typeof receiptFaultDriver> | null => receiptIncident;
            const fault = injected()?.fault;
            expect(fault, "The receipt incident must actually occur").toBeTruthy();
            if (!fault) throw new Error("Receipt fault never ran");
            const failedReview = journal.reviews
              .records(run.runId)
              .find((review) => review.workspaceId === fault.identity.workspaceId);
            expect(failedReview).toBeDefined();
            const failedEvidence = journal.reviews.evidence(run.runId, failedReview!.evidenceId);
            expect(failedEvidence).toMatchObject({
              status: "finished",
              sourceIntact: false,
              report: null,
            });
            expect(journal.agents.turn(run.runId, fault.identity).resultEligible).toBe(false);
            for (const delta of fault.deltas)
              expect(readFileSync(join(fault.workspacePath, delta.path), "utf8")).toBe(delta.after);
            for (const [path, bytes] of receiptBaseline) {
              expect(
                execFileSync("git", ["-C", source, "show", `${revision}:${path}`], {
                  encoding: "utf8",
                }),
              ).toBe(bytes);
              expect(readFileSync(join(source, path), "utf8")).toBe(bytes);
            }
            expect(
              journal
                .actions(run.runId)
                .some(
                  (action) =>
                    action.request.action.kind === "inspect_repo" &&
                    action.request.action.workspaceId === fault.identity.workspaceId &&
                    action.status === "succeeded",
                ),
            ).toBe(true);
            const retained = journal.diagnostics.read(run.runId, fault.artifactId, 0, 65536);
            for (const path of RECEIPT_FILES) expect(retained.text).toContain(path);
          }
          const turns = journal.agents.turns(run.runId);
          if (browserDefinition) {
            const actions = journal.actions(run.runId);
            const failedTurn = turns.find((turn) => {
              if (
                journal.agents.assignment(run.runId, turn.identity.assignmentId).purpose !==
                "implementation"
              )
                return false;
              const parsed = ImplementationResultSchema.safeParse(turn.result);
              return (
                turn.resultEligible &&
                parsed.success &&
                parsed.data.status === "completed" &&
                parsed.data.tests.some(
                  (check) =>
                    check.outcome === "failed" &&
                    /browser|playwright/i.test(check.command + " " + check.detail),
                )
              );
            });
            expect(
              failedTurn,
              "A real implementer must report completed with a failed browser check; no report is injected",
            ).toBeDefined();
            if (!failedTurn) throw new Error("The browser incident did not occur");
            // The worker is not the browser executor. Require a real kernel result,
            // its stopped source assignment, and the exact evidence ID supplied to
            // and truthfully cited by the provider's subsequent completed-code report.
            const incident = actions
              .filter((record) => record.request.action.kind === "run_diagnostic_check")
              .map((record) =>
                journal.delivery.validationForOperation(run.runId, record.operationId),
              )
              .find((evidence) => {
                if (!evidence || evidence.outcome?.status !== "failed") return false;
                const candidate = journal.delivery.candidate(run.runId, evidence);
                return (
                  candidate.source.kind === "implementation" &&
                  candidate.source.assignmentId === failedTurn.identity.assignmentId &&
                  candidate.workspaceId === failedTurn.identity.workspaceId &&
                  candidate.workspaceGeneration === failedTurn.identity.workspaceGeneration &&
                  evidence.outcome.endedAt <= failedTurn.createdAt &&
                  JSON.stringify(failedTurn.prompt).includes(evidence.evidenceId) &&
                  ImplementationResultSchema.parse(failedTurn.result).tests.some(
                    (check) =>
                      check.outcome === "failed" &&
                      check.detail.includes(evidence.evidenceId) &&
                      /kernel/i.test(check.detail),
                  )
                );
              });
            expect(
              incident,
              "The actual failed kernel execution must be handed back to its implementer",
            ).toBeDefined();
            if (!incident) throw new Error("Missing kernel-to-worker browser evidence handoff");
            expect(incident).toMatchObject({
              purpose: "diagnostic",
              check: {
                command: "/bin/sh",
                args: ["tools/browser-check.sh"],
                cwd: ".",
                environmentBindings: [],
              },
              sourceUnchanged: true,
              environmentVerified: true,
              fixtureAccessIds: [],
              outcome: { status: "failed", processTreeStopped: true },
            });
            expect(incident.outcome!.stderr).toContain("Browser fixture authentication failed");
            expect(incident.outcome!.stderr).toContain("database URL is unavailable");
            expect(incident.outcome!.stdout).toContain("1 failed");
            expect(journal.delivery.satisfiesCheck(run.runId, incident.evidenceId)).toBe(false);
            const incidentSource = journal.delivery.candidate(run.runId, incident);
            if (incidentSource.source.kind !== "implementation")
              throw new Error("Expected implementation candidate");
            const sourceTurnId = incidentSource.source.turnId;
            const sourceTurn = turns.find((turn) => turn.identity.turnId === sourceTurnId);
            expect(sourceTurn?.stopEvidence).toBeTruthy();
            expect(sourceTurn!.updatedAt <= incident.createdAt).toBe(true);
            expect(
              execFileSync(
                "git",
                [
                  "-C",
                  journal.agents.workspace(run.runId, incident).path,
                  "show",
                  `${incident.revision}:source.txt`,
                ],
                { encoding: "utf8", timeout: 10000 },
              ),
            ).toBe("green\n");
            expect(
              actions.some(
                (record) =>
                  record.status === "succeeded" &&
                  record.request.action.kind === "continue_agent" &&
                  record.request.action.agentId === failedTurn.identity.agentId &&
                  record.createdAt >= failedTurn.updatedAt,
              ),
            ).toBe(true);
            for (const path of ["BROWSER.md", "playwright.config.cjs"])
              expect(
                actions.some(
                  (record) =>
                    record.status === "succeeded" &&
                    record.request.action.kind === "inspect_repo" &&
                    record.request.action.operation === "read" &&
                    record.request.action.path === path,
                ),
              ).toBe(true);
            expect(
              actions.some(
                (record) =>
                  record.request.action.kind === "inspect_fixture" &&
                  record.result?.status === "succeeded" &&
                  record.result.result.kind === "inspection" &&
                  JSON.parse(record.result.result.text).status === "database_absent",
              ),
            ).toBe(true);
            expect(journal.fixtures.creations(run.runId)).toMatchObject([
              { fixtureId: browserDefinition.id, generation: 1, status: "owned" },
            ]);
            expect(journal.fixtures.creations(run.runId)[0]!.createdAt > failedTurn.updatedAt).toBe(
              true,
            );
            const browserEvidence = actions
              .filter((record) => record.request.action.kind === "run_validation")
              .flatMap((record) => {
                const evidence = journal.delivery.validationForOperation(
                  run.runId,
                  record.operationId,
                );
                return evidence?.fixtureAccessIds.length ? [evidence] : [];
              });
            for (const phase of ["pre_commit", "exact_revision"])
              expect(
                browserEvidence.some(
                  (evidence) =>
                    evidence.phase === phase &&
                    evidence.sourceUnchanged &&
                    evidence.environmentVerified &&
                    evidence.outcome?.status === "succeeded" &&
                    evidence.outcome.stdout.includes("1 passed"),
                ),
              ).toBe(true);
            const firstGreen = browserEvidence.find(
              (evidence) =>
                evidence.outcome?.status === "succeeded" && evidence.environmentVerified,
            )!;
            for (const review of journal.reviews.records(run.runId))
              if (review.turnIdentity)
                expect(review.createdAt >= firstGreen.outcome!.endedAt).toBe(true);
            expect(
              journal.fixtures.validation
                .uses(run.runId)
                .every((use) => use.localStopped && use.remoteStopped),
            ).toBe(true);
            for (const path of browserFiles) {
              expect(git("rev-parse", `${revision}:${path}`)).toBe(
                git("rev-parse", `${baseline}:${path}`),
              );
              expect(git("hash-object", "--no-filters", path)).toBe(
                git("rev-parse", `${baseline}:${path}`),
              );
            }
            expect(browserDatabase!.sql("SELECT username FROM e2e_users", "browser_fixture")).toBe(
              "fixture-user",
            );
          }
          const agents = journal.agents.instances(run.runId);
          expect(agents.every((agent) => agent.contract.runtime === runtime)).toBe(true);
          if (runtime === "herdr") {
            expect(run.runtimeConfiguration?.herdr?.sessionName).toBe(
              process.env.EPICD_EXPECT_HERDR_SESSION,
            );
            expect(run.runtimeConfiguration?.herdr?.workspaceId).toBe(
              process.env.EPICD_EXPECT_HERDR_WORKSPACE,
            );
            expect(
              turns
                .filter((turn) => turn.resultEligible)
                .every((turn) => turn.launch?.native !== null && turn.launch?.native !== undefined),
            ).toBe(true);
            expect(turns.every((turn) => turn.sdkUsage === null)).toBe(true);
            expect(agents.every((agent) => agent.provider?.runtime === "herdr")).toBe(true);
          }
          expect(
            turns.some(
              (turn) =>
                journal.agents.assignment(run.runId, turn.identity.assignmentId).purpose ===
                  "final_review" && turn.resultEligible,
            ),
          ).toBe(true);
          expect(turns.every((turn) => turn.stopEvidence !== null)).toBe(true);
          expect(
            journal.agents
              .instances(run.runId)
              .filter((agent) => agent.role === "orchestrator")
              .every((agent) => agent.contract.effective.model === "gpt-6-astra"),
          ).toBe(true);
          const coordinators = journal.agents
            .instances(run.runId)
            .filter((agent) => agent.role === "orchestrator");
          expect(coordinators.length).toBeGreaterThan(1);
          expect(
            coordinators
              .slice(0, -1)
              .every((agent) => agent.status === "released" && agent.revokedReason === null),
          ).toBe(true);
          expect(new Set(coordinators.map((agent) => agent.provider?.sessionId)).size).toBe(
            coordinators.length,
          );
          expect(journal.publications.repository(run.runId)?.publishedRevision).toBe(revision);
        } finally {
          clearTimeout(timeout);
          if (progress) clearInterval(progress);
          store.close();
        }
      },
      (deadlineMinutes + (scenario === "browser" ? 5 : 1)) * 60_000,
    );
  },
);
