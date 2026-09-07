import { initialRun } from "./fixtures/orchestration/state.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { RunAlreadyControlledError, StateStore } from "../src/adapters/store.js";
import { RunStateSchema } from "../src/domain/types.js";

const tempDirs: string[] = [];
// ESM imports need file URLs on Windows; resolve from this module rather than the shell's cwd.
const storeModuleUrl = new URL("../src/adapters/store.ts", import.meta.url).href;

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function state(runId: string, epicId = "epic") {
  return RunStateSchema.parse({
    ...initialRun(),
    runId,
    agentNamespace: "0123456789abcdef0123",
    repoPath: "/repo",
    epicId,
    epicTitle: "Epic",
    model: null,
    phase: "selecting",
    currentBeadId: null,
    currentBeadTitle: null,
    baseRevision: null,
    epicBaseRevision: "abc123",
    candidateRevision: null,
    completedTasks: 0,
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

describe("controller leases across processes", () => {
  it("rejects a live controller and reclaims its lease after the process dies", async () => {
    const directory = mkdtempSync(join(tmpdir(), "epicd-process-lease-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const runId = "cross-process-run";
    const store = new StateStore(databasePath);
    store.create(state(runId));

    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { StateStore } from ${JSON.stringify(storeModuleUrl)};
         const store = new StateStore(process.argv[1]);
         const lease = store.acquireLease(process.argv[2]);
         console.log(JSON.stringify({ pid: process.pid, leaseId: lease.leaseId }));
         process.stdin.resume();`,
        databasePath,
        runId,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "close");
    try {
      const [line] = (await Promise.race([
        once(lines, "line"),
        closed.then(() => {
          throw new Error("Lease fixture exited before reporting its owner");
        }),
      ])) as [string];
      const owner = JSON.parse(line) as { pid: number; leaseId: string };

      expect(owner.pid).toBe(child.pid);
      expect(() => store.acquireLease(runId)).toThrow(RunAlreadyControlledError);
      expect(store.controllerLease(runId)).toMatchObject({
        pid: owner.pid,
        leaseId: owner.leaseId,
        alive: true,
      });
      expect(() =>
        store.addEvent(runId, "warning", "run.pause_requested", "Foreign pause"),
      ).toThrow(RunAlreadyControlledError);
      expect(store.events(runId)).toEqual([]);

      child.kill("SIGKILL");
      await closed;
      store.addEvent(runId, "info", "admin.event", "Controller stopped");
      expect(store.controllerLease(runId)).toBeNull();
      const replacement = store.acquireLease(runId);
      expect(replacement.leaseId).not.toBe(owner.leaseId);
      store.releaseLease(runId, replacement.ownerToken);
    } finally {
      child.kill("SIGKILL");
      await closed;
      lines.close();
      store.close();
    }
  });

  it("serializes competing run creation into one winner and one actionable conflict", async () => {
    const directory = mkdtempSync(join(tmpdir(), "epicd-process-create-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const initializer = new StateStore(databasePath);
    initializer.close();
    const childSource = `import { StateStore } from ${JSON.stringify(storeModuleUrl)};
const store = new StateStore(process.argv[1]);
const state = JSON.parse(process.argv[2]);
console.log("ready");
process.stdin.once("data", () => {
  try {
    store.create(state);
    console.log(JSON.stringify({ok:true,runId:state.runId}));
  } catch (error) {
    console.log(JSON.stringify({ok:false,message:error instanceof Error ? error.message : String(error)}));
  } finally {
    store.close();
    process.stdin.destroy();
  }
});`;
    const children = [state("create-a", "epic-a"), state("create-b", "epic-b")].map((run) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          childSource,
          databasePath,
          JSON.stringify(run),
        ],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      return { child, lines: createInterface({ input: child.stdout }) };
    });
    await Promise.all(children.map(({ lines }) => once(lines, "line")));
    const outcomeLines = children.map(({ lines }) => once(lines, "line"));
    const closed = children.map(({ child }) => once(child, "close"));
    for (const { child } of children) child.stdin.write("create\n");
    const outcomes = (await Promise.all(outcomeLines)).map(
      ([line]) => JSON.parse(line as string) as { ok: boolean; runId?: string; message?: string },
    );
    await Promise.all(closed);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("is already owned by"),
      }),
    ]);
    const store = new StateStore(databasePath);
    expect(store.list("/repo")).toHaveLength(1);
    store.close();
  });
});
