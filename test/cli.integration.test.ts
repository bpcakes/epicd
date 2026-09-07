import { initialRun } from "./fixtures/orchestration/state.js";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RunStateSchema, type RunState } from "../src/domain/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { repo: string; stateRoot: string; statePath: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "epicd-cli-test-"));
  tempDirs.push(root);
  const repoInput = join(root, "repo");
  const stateRoot = join(root, "state");
  const statePath = join(stateRoot, "epicd", "epicd.sqlite3");
  const bin = join(root, "bin");
  mkdirSync(repoInput);
  mkdirSync(bin);
  execFileSync("git", ["init", "--quiet", repoInput]);
  const repo = realpathSync(repoInput);
  return { repo, stateRoot, statePath, bin };
}

function state(repoPath: string, runId: string): RunState {
  return RunStateSchema.parse({
    ...initialRun(),
    runId,
    agentNamespace: "0123456789abcdef0123",
    repoPath,
    epicId: `epic-${runId}`,
    epicTitle: `Epic ${runId}`,
    model: null,
    phase: "complete",
    currentBeadId: null,
    currentBeadTitle: null,
    baseRevision: null,
    epicBaseRevision: "abc123",
    candidateRevision: null,
    completedTasks: 1,
    totalTasks: 1,
    reviewPass: 0,
    pendingFindings: [],
    recentOutcomes: [],
    lastReviewSummary: null,
    resumePhase: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function runCli(setup: ReturnType<typeof fixture>, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve("src/cli.tsx"), "--repo", setup.repo, ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${setup.bin}:${process.env.PATH ?? ""}`,
        XDG_STATE_HOME: setup.stateRoot,
      },
      encoding: "utf8",
    },
  );
}

describe("CLI integration", () => {
  it.each([
    ["--model", "gpt-test", "--model-inherit"],
    ["--reasoning", "high", "--reasoning-inherit"],
  ])("rejects conflicting run-wide fallback options", (flag, value, reset) => {
    const setup = fixture();

    const result = runCli(setup, [flag, value, reset, "status"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`option '${reset}' cannot be used with option '${flag} <`);
  });

  it("renders human and JSON status, including a null Herdr effective model", () => {
    const setup = fixture();
    const store = new StateStore(setup.statePath);
    const persisted = state(setup.repo, "status-run");
    persisted.runtime = "herdr";
    persisted.agentSessions.review = {
      status: "active",
      sessionId: "herdr-review",
      contract: {
        runtime: "herdr",
        requested: { model: null, reasoningEffort: "xhigh" },
        effective: { model: null, reasoningEffort: "xhigh" },
      },
    };
    persisted.lastError = "cleanup completion could not be recorded";
    store.create(persisted);
    store.close();

    const human = runCli(setup, ["status"]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("epic-status-run (status-run)");
    expect(human.stdout).toContain("complete · herdr");
    expect(human.stdout).toContain("session recovery: review (active)");
    expect(human.stdout).toContain("last error: cleanup completion could not be recorded");

    const json = runCli(setup, ["status", "--json"]);
    expect(json.status).toBe(0);
    const statuses = JSON.parse(json.stdout) as Array<{
      agentSessions: {
        review: { sessionId: string; contract: { effective: { model: string | null } } };
      };
    }>;
    expect(statuses[0]?.agentSessions.review.contract.effective.model).toBeNull();
    expect(statuses[0]?.agentSessions.review.sessionId).toBe("herdr-review");
    expect(statuses[0]).not.toHaveProperty("reviewThreadId");
  });

  it("omits corrupt rows from JSON status and exits unsuccessfully", () => {
    const setup = fixture();
    const store = new StateStore(setup.statePath);
    const persisted = state(setup.repo, "invalid-status");
    store.create(persisted);
    store.close();
    const database = new Database(setup.statePath);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", persisted.runId);
    database.close();

    const result = runCli(setup, ["status", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toContain("invalid persisted state");
    expect(result.stderr).toContain("omitted from JSON status");
  });

  it("wires force-unlock through owner and lease identity checks", () => {
    const setup = fixture();
    const store = new StateStore(setup.statePath);
    const persisted = state(setup.repo, "unlock-run");
    store.create(persisted);
    const lease = store.acquireLease(persisted.runId);
    store.close();

    const result = runCli(setup, [
      "unlock",
      persisted.runId,
      "--owner-pid",
      String(process.pid),
      "--lease-id",
      lease.leaseId,
      "--force",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Released the controller lease");
    const inspected = new StateStore(setup.statePath);
    expect(inspected.controllerLease(persisted.runId)).toBeNull();
    inspected.close();
  });

  it("wires explicit cleanup abandonment", () => {
    const setup = fixture();
    const store = new StateStore(setup.statePath);
    const persisted = state(setup.repo, "cleanup-run");
    persisted.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];
    persisted.lastError = "cleanup controller failed";
    store.create(persisted);
    store.close();

    const result = runCli(setup, ["cleanup", persisted.runId, "--abandon"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Abandoned 1 cleanup action(s)");
    const inspected = new StateStore(setup.statePath);
    expect(inspected.get(persisted.runId)?.pendingAgentCleanup).toEqual([]);
    expect(inspected.get(persisted.runId)?.lastError).toBeNull();
    inspected.close();
  });

  it("clears a completed cleanup diagnostic with no resource actions left", () => {
    const setup = fixture();
    const store = new StateStore(setup.statePath);
    const persisted = state(setup.repo, "cleanup-diagnostic");
    persisted.lastError = "cleanup completion could not be recorded";
    store.create(persisted);
    store.close();

    const result = runCli(setup, ["cleanup", persisted.runId, "--abandon"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Cleared the completed cleanup diagnostic");
    const inspected = new StateStore(setup.statePath);
    expect(inspected.get(persisted.runId)?.lastError).toBeNull();
    inspected.close();
  });

  it("exits successfully after a headless resume leaves external Herdr cleanup pending", () => {
    const setup = fixture();
    const herdr = join(setup.bin, "herdr");
    const closeLog = join(setup.bin, "herdr-close-log");
    writeFileSync(
      herdr,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("herdr test");
else if (args[0] === "agent" && args[1] === "list") {
  console.log(JSON.stringify({result:{agents:[{name:"ed-0123456789abcdef0123-i-fixture",tab_id:"cleanup-tab"}]}}));
} else if (args[0] === "tab" && args[1] === "close" && args[2] === "cleanup-tab") {
  fs.appendFileSync(${JSON.stringify(closeLog)}, JSON.stringify(args) + "\\n");
  process.exit(1);
} else process.exit(2);
`,
    );
    chmodSync(herdr, 0o755);
    const store = new StateStore(setup.statePath);
    const persisted = state(setup.repo, "cleanup-resume");
    persisted.runtime = "herdr";
    persisted.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];
    store.create(persisted);
    store.close();

    const result = runCli(setup, ["resume", persisted.epicId, "--no-tui"]);

    expect(result.status).toBe(0);
    expect(
      readFileSync(closeLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toContainEqual(["tab", "close", "cleanup-tab"]);
    const inspected = new StateStore(setup.statePath);
    expect(inspected.get(persisted.runId)).toMatchObject({
      phase: "complete",
      pendingAgentCleanup: [{ kind: "run", runtime: "herdr" }],
      lastError: null,
    });
    inspected.close();
  });

  it("wires invalid-run quarantine without deleting forensic state", () => {
    const setup = fixture();
    const store = new StateStore(setup.statePath);
    const persisted = state(setup.repo, "quarantine-run");
    store.create(persisted);
    store.addEvent(persisted.runId, "warning", "test.forensic", "Preserve this event");
    store.close();
    const database = new Database(setup.statePath);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", persisted.runId);
    database.close();

    const result = runCli(setup, ["quarantine", persisted.runId, "--force"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Quarantined invalid run quarantine-run");
    const inspected = new Database(setup.statePath);
    expect(
      inspected.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(persisted.runId),
    ).toBeUndefined();
    expect(
      inspected.prepare("SELECT 1 FROM quarantined_runs WHERE run_id = ?").get(persisted.runId),
    ).toBeDefined();
    expect(
      inspected
        .prepare("SELECT kind, message FROM quarantined_events WHERE run_id = ?")
        .all(persisted.runId),
    ).toEqual([{ kind: "test.forensic", message: "Preserve this event" }]);
    inspected.close();
  });

  it("accepts a local Codex executable override and reports a missing one", () => {
    const setup = fixture();
    const missing = join(setup.repo, "missing-codex");

    const result = runCli(setup, ["--codex-path", missing, "doctor", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`Configured Codex executable does not exist: ${missing}`);
  });

  it.each(["run", "resume"] as const)(
    "applies a Codex executable override to %s preflight",
    (command) => {
      const setup = fixture();
      const epicId = "epic-command-override";
      const missing = join(setup.repo, "missing-command-codex");
      if (command === "resume") {
        const store = new StateStore(setup.statePath);
        const persisted = state(setup.repo, "command-override");
        persisted.epicId = epicId;
        persisted.phase = "blocked";
        persisted.resumePhase = "selecting";
        persisted.lastError = "retry me";
        store.create(persisted);
        store.close();
      }

      const result = runCli(setup, ["--codex-path", missing, command, epicId, "--no-tui"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Configured Codex executable does not exist: ${missing}`);
    },
  );

  it("fails the runtime check when a bare Codex override is not on PATH", () => {
    const setup = fixture();

    const result = runCli(setup, [
      "--codex-path",
      "definitely-missing-epicd-codex-command",
      "doctor",
      "--json",
    ]);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "Codex SDK runtime",
        status: "fail",
        message: expect.stringContaining("ENOENT"),
      }),
    );
  });

  it("rejects a Codex executable override for Herdr", () => {
    const setup = fixture();

    const result = runCli(setup, [
      "--runtime",
      "herdr",
      "--codex-path",
      "/unused/codex",
      "doctor",
      "--json",
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--codex-path applies only to the sdk runtime");
  });
});
