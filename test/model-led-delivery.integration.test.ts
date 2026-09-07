import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../dist/adapters/store.js";
import { createRun, resolveExecutable } from "../dist/bootstrap.js";
import { OrchestratorController } from "../dist/controller.js";

/** Opt-in model acceptance, not a scripted strategy or a substitute for kernel regressions. */
describe.runIf(process.platform === "linux" && process.env.EPICD_LIVE_DELIVERY === "1")(
  "model-led epic delivery",
  () => {
    it(
      "delivers a real one-task Beads epic with Astra and independent exact-revision review",
      async () => {
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
        writeFileSync(
          join(source, "README.md"),
          "# Color fixture\n\nThe application output is source.txt. The required output is exactly green followed by one newline. Validate with `/usr/bin/cmp source.txt expected.txt`. No dependencies or services are required. Only source.txt needs changing; expected.txt and the validation policy must stay unchanged.\n",
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
          20 * 60_000,
        );
        let progress: ReturnType<typeof setInterval> | undefined;
        try {
          const run = await createRun(
            store,
            {
              repoPath: source,
              epicId: epic.id,
              runtime: "sdk",
              trackerPath: trackerExecutable,
              model: "gpt-6-astra",
              reasoningEffort: "high",
              turnTimeoutMs: 120_000,
            },
            abort.signal,
          );
          process.stderr.write(`Live delivery run: ${run.runId}\n`);
          progress = setInterval(() => {
            const control = store.orchestration.control(run.runId);
            const actions = store.orchestration.actions(run.runId).slice(-3);
            process.stderr.write(
              `Live delivery: ${control.status}, decisions ${control.decisionsUsed}; ${actions.map((action) => `${action.request.action.kind}:${action.status}`).join(", ")}\n`,
            );
          }, 30_000);
          const result = await new OrchestratorController(store, run.runId).run(abort.signal);
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
          expect(readFileSync(join(source, ".git/index"))).toEqual(index);
          expect(readFileSync(join(source, "source.txt"), "utf8")).toBe(
            "operator-owned concurrent work\n",
          );
          for (const issue of [epic.id, task.id])
            expect(br("show", issue, "--no-auto-flush", "--no-auto-import")[0]?.status).toBe(
              "closed",
            );
          const journal = store.orchestration;
          const turns = journal.agents.turns(run.runId);
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
      21 * 60_000,
    );
  },
);
