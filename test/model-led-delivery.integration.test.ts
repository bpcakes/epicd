import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../dist/adapters/store.js";
import { createRun, resolveExecutable } from "../dist/bootstrap.js";
import { OrchestratorController, controlledDriver } from "../dist/controller.js";
import { receiptProject, receiptFaultDriver, RECEIPT_FILES } from "./fixtures/receipt-incident.js";

const runtime = process.env.EPICD_LIVE_DELIVERY_RUNTIME ?? "sdk";
if (runtime !== "sdk" && runtime !== "herdr")
  throw new Error("Select sdk or herdr for live delivery");
const deadlineMinutes = runtime === "herdr" ? 40 : 20;
const scenario = process.env.EPICD_LIVE_DELIVERY_SCENARIO ?? "plain";
if (scenario !== "plain" && scenario !== "receipts")
  throw new Error("Select plain or receipts for live delivery");

/** Opt-in model acceptance, not a scripted strategy or a substitute for kernel regressions. */
describe.runIf(process.platform === "linux" && process.env.EPICD_LIVE_DELIVERY === "1")(
  "model-led epic delivery",
  () => {
    it(
      `delivers a real one-task Beads epic with Astra and independent exact-revision review (${scenario})`,
      async () => {
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
        const receiptBaseline = new Map(
          receiptFiles.map((path) => [path, readFileSync(join(source, path), "utf8")]),
        );
        writeFileSync(
          join(source, "README.md"),
          "# Color fixture\n\nThe application output is source.txt. The required output is exactly green followed by one newline. Validate with `/usr/bin/cmp source.txt expected.txt`. No dependencies or services are required. Only source.txt needs changing; expected.txt and the validation policy must stay unchanged.\n" +
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
          ],
          budgets: { maxWorkers: 2, taskDecisions: 64, epicDecisions: 128 },
        };
        const policyBytes = `${JSON.stringify(policy, null, 2)}\n`;
        writeFileSync(join(source, ".epicd/policy.json"), policyBytes);
        git("add", "source.txt", "expected.txt", "README.md", ".epicd/policy.json");
        if (receiptFiles.length) git("add", ...receiptFiles);
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
          "Deliver the child task as verified local commits, close the task and epic, publish final tracker state, and complete the run. No external service or user decision is required.",
        );
        const task = br(
          "create",
          "Change red output to green",
          "--type",
          "task",
          "--parent",
          epic.id,
          "--description",
          "Change only source.txt to the exact bytes green followed by one newline. Preserve expected.txt, README.md and .epicd/policy.json. Use independent review and the declared color check.",
          "--acceptance-criteria",
          "source.txt is exactly green followed by one newline; /usr/bin/cmp source.txt expected.txt exits zero; expected.txt and validation policy are unchanged.",
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
      (deadlineMinutes + 1) * 60_000,
    );
  },
);
