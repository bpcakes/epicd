import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closureFixture, publishVerified, trackerAction } from "./fixtures/tracker-closure.js";
import {
  check,
  fixture,
  git,
  resource,
  waitFor,
  type ReviewTrackerSetup,
} from "./fixtures/review.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { reconcileTracker, registerTrackerCapabilities } from "../src/kernel/tracker.js";
import type { KernelAction } from "../src/domain/orchestration.js";
import { KernelBeads } from "../src/adapters/kernel-beads.js";
import { NamespaceStopUnprovenError } from "../src/adapters/pid-namespace.js";
import { KernelGitError } from "../src/adapters/kernel-git.js";
import { digestJson } from "../src/domain/repository-policy.js";

const close = (revision: string, taskId = "demo.1"): KernelAction => ({
  kind: "request_beads_transition",
  taskId,
  revision,
  transition: "close_task",
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform !== "linux")("verified task closure", () => {
  it("preserves unknown client stop through nested publication locks instead of accepting task closure", async () => {
    const s = await closureFixture("sha1");
    const { commit } = await publishVerified(s);
    const graph = vi.spyOn(s.transport, "graph");
    vi.spyOn(s.transport, "close").mockRejectedValueOnce(
      new NamespaceStopUnprovenError("Unknown close namespace stop"),
    );
    expect((await s.dispatch(close(commit.revision!))).status).toBe("indeterminate");
    const pending = s.journal.tracker.pending(s.authority.runId)!;
    expect(pending).toMatchObject({ ioStopped: false, outcome: null, mutationDispatched: true });
    expect(graph).toHaveBeenCalledOnce();
    expect(s.readTracker().status).toBe("in_progress");
    await expect(s.adapter.reconcile(s.authority, pending.trackerOperationId)).rejects.toThrow(
      "Independently prove",
    );
  });
  it.each(["sha1", "sha256"] as const)(
    "closes only the claimed, independently verified and published %s task",
    async (format) => {
      const s = await closureFixture(format),
        run = s.authority.runId;
      const { commit, publication } = await publishVerified(s);
      writeFileSync(join(s.source, "app.txt"), "user work\n");
      const index = readFileSync(join(s.source, ".git/index"));
      const headLog = readFileSync(join(s.source, ".git/logs/HEAD"));
      const closeCommand = s.transport.close.bind(s.transport);
      vi.spyOn(s.transport, "close").mockImplementationOnce(async (...args) => {
        for (const ref of [publication.canonicalRef!, publication.publicRef!]) {
          for (const name of [
            `refs/heads/epicd/${run}`,
            `refs/epicd/publications/${publication.publicationId}`,
          ])
            expect(() =>
              execFileSync(
                "git",
                [
                  "-c",
                  "core.hooksPath=/dev/null",
                  "-C",
                  ref.repository.root.path,
                  "update-ref",
                  name,
                  s.head,
                  commit.revision!,
                ],
                { stdio: ["ignore", "pipe", "pipe"] },
              ),
            ).toThrow(/cannot lock ref/);
        }
        return closeCommand(...args);
      });
      const id = resource(await s.dispatch(close(commit.revision!))).resourceId;
      const record = s.journal.tracker.record(run, id);
      expect(record).toMatchObject({
        kind: "close_task",
        outcome: "closed",
        mutationDispatched: true,
        ioStopped: true,
        closure: {
          publicationId: publication.publicationId,
          refsVerified: true,
          intervention: false,
        },
      });
      expect(s.readTracker()).toMatchObject({
        status: "closed",
        assignee: `epicd:${run}`,
        close_reason: record.closure!.reason,
        closed_by_session: record.operationId,
      });
      expect(git(s.source, "rev-parse", `refs/heads/epicd/${run}`)).toBe(commit.revision);
      expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
      expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("user work\n");
      expect(readFileSync(join(s.source, ".git/index"))).toEqual(index);
      expect(readFileSync(join(s.source, ".git/logs/HEAD"))).toEqual(headLog);
      const commands = s.trackerCommands().filter((args) => args[0] === "close");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain("--transition-comment");
      expect(commands[0]).not.toContain("--force");
      expect(commands[0]).not.toContain("--bypass-policy");
      expect(s.reopen().orchestration.tracker.record(run, id)).toEqual(record);
      if (format === "sha1") {
        const db = new Database(s.path);
        try {
          const tables = ["tracker_operations", "tracker_snapshots", "agent_assignments"] as const;
          const originals = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
          s.store.releaseLease(run, s.authority.ownerToken);
          db.prepare("UPDATE runs SET state_json = 'invalid' WHERE run_id = ?").run(run);
          s.store.quarantineInvalidRun(run);
          tables.forEach((table, index) => {
            const rows = db
              .prepare(
                "SELECT row_json FROM quarantined_orchestration WHERE run_id = ? AND source_table = ? ORDER BY rowid",
              )
              .all(run, table) as { row_json: string }[];
            expect(rows.map((row) => JSON.parse(row.row_json))).toEqual(originals[index]);
          });
          expect(db.pragma("foreign_key_check")).toEqual([]);
        } finally {
          db.close();
        }
      }
    },
    30000,
  );

  it("rejects an unverified task without invoking close", async () => {
    const s = await closureFixture();
    expect((await s.dispatch(close(s.head))).status).toBe("rejected");
    expect(s.readTracker().status).toBe("in_progress");
    expect(s.trackerCommands().some((args) => args[0] === "close")).toBe(false);
  }, 15000);

  it("cannot retroactively attach a later claim to an older implementation assignment", async () => {
    const s = await closureFixture("sha1", false);
    expect(
      s.journal.agents.assignment(s.authority.runId, s.writer.assignmentId).trackerClaim,
    ).toBeUndefined();
    const { commit } = await publishVerified(s);
    expect(await s.dispatch(close(commit.revision!))).toMatchObject({
      status: "rejected",
      code: "closure_claim_mismatch",
    });
    expect(s.trackerCommands().some((args) => args[0] === "close")).toBe(false);
  }, 30000);

  it("rejects the wrong revision, another task and a later revoked exact review", async () => {
    const s = await closureFixture();
    const { candidate, commit } = await publishVerified(s);
    expect((await s.dispatch(close(s.head))).status).toBe("rejected");
    expect((await s.dispatch(close(commit.revision!, "another-task"))).status).toBe("rejected");
    await s.review(candidate, { verdict: "blocked" }, [], commit.revision);
    expect(await s.dispatch(close(commit.revision!))).toMatchObject({
      status: "rejected",
      code: "closure_not_verified",
    });
    expect(s.trackerCommands().some((args) => args[0] === "close")).toBe(false);
    expect(s.readTracker().status).toBe("in_progress");
  }, 30000);

  it.each(["canonicalRef", "publicRef"] as const)(
    "preserves changed %s state and never sends close",
    async (destination) => {
      const s = await closureFixture();
      const { commit, publication } = await publishVerified(s);
      const repository = publication[destination]!.repository.root.path;
      git(
        repository,
        "update-ref",
        `refs/heads/epicd/${s.authority.runId}`,
        s.head,
        commit.revision!,
      );
      expect((await s.dispatch(close(commit.revision!))).status).toBe("failed");
      expect(s.trackerCommands().some((args) => args[0] === "close")).toBe(false);
      expect(git(repository, "rev-parse", `refs/heads/epicd/${s.authority.runId}`)).toBe(s.head);
      expect(s.readTracker().status).toBe("in_progress");
    },
    30000,
  );

  it("recognizes a lost CLI response and replays only the recorded action result", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    const original = s.transport.close.bind(s.transport);
    vi.spyOn(s.transport, "close").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("Lost close response after confirmed command stop");
    });
    const decision = s.decision(close(commit.revision!));
    const running = await s.kernel.execute(decision, s.authority);
    if (running.status !== "running") throw new Error("Not running");
    const result = (await s.kernel.operation(running.operationId))!;
    const record = s.journal.tracker.record(s.authority.runId, resource(result).resourceId);
    expect(record).toMatchObject({
      outcome: "closed",
      failure: "Lost close response after confirmed command stop",
    });
    expect(await s.kernel.execute(decision, s.authority)).toEqual(result);
    expect((await s.dispatch(close(commit.revision!))).status).toBe("rejected");
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(1);
  }, 30000);

  it.each([
    { closed_by_session: "other-operation" },
    { close_reason: "Foreign close" },
    { parent: false },
    { description: "New requirements" },
  ])(
    "does not accept a closed status after tracker interference %j",
    async (changes) => {
      const s = await closureFixture();
      const { commit } = await publishVerified(s);
      const original = s.transport.close.bind(s.transport);
      vi.spyOn(s.transport, "close").mockImplementationOnce(async (...args) => {
        await original(...args);
        s.writeTracker(changes);
      });
      expect((await s.dispatch(close(commit.revision!))).status).toBe("failed");
      expect(s.readTracker()).toMatchObject({ status: "closed", ...changes });
      expect(s.journal.tracker.operations(s.authority.runId).at(-1)?.outcome).toBe("conflict");
      expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(1);
    },
    30000,
  );

  it("reconciles a lost stopped result without repeating close", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    vi.spyOn(s.journal.tracker, "finish").mockImplementationOnce(() => {
      throw new Error("Lost settlement");
    });
    expect((await s.dispatch(close(commit.revision!))).status).toBe("indeterminate");
    const pending = s.journal.tracker.pending(s.authority.runId)!;
    expect(pending.ioStopped).toBe(true);
    s.newLease();
    const store = s.reopen();
    const kernel = new ActionKernel(store.orchestration);
    registerTrackerCapabilities(kernel, s.transport);
    resource(
      await trackerAction(kernel, s.authority, {
        kind: "reconcile_tracker_operation",
        trackerOperationId: pending.trackerOperationId,
      }),
    );
    expect(
      store.orchestration.tracker.record(s.authority.runId, pending.trackerOperationId).outcome,
    ).toBe("closed");
    expect(store.orchestration.action(s.authority.runId, pending.actionId)?.status).toBe(
      "succeeded",
    );
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(1);
  }, 30000);

  it("settles an unused close intent after lease replacement and permits a fresh guarded attempt", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    vi.spyOn(s.adapter, "execute").mockImplementationOnce(async () => {
      throw new Error("Controller stopped before transport admission");
    });
    expect((await s.dispatch(close(commit.revision!))).status).toBe("indeterminate");
    const pending = s.journal.tracker.pending(s.authority.runId)!;
    expect(pending).toMatchObject({
      dispatched: false,
      mutationDispatched: false,
      ioStopped: false,
    });
    s.newLease();
    resource(
      await s.dispatch({
        kind: "reconcile_tracker_operation",
        trackerOperationId: pending.trackerOperationId,
      }),
    );
    expect(s.journal.tracker.record(s.authority.runId, pending.trackerOperationId)).toMatchObject({
      outcome: "not_closed",
      ioStopped: true,
    });
    expect(s.journal.action(s.authority.runId, pending.actionId)?.status).toBe("failed");
    expect(s.trackerCommands().some((args) => args[0] === "close")).toBe(false);
    resource(await s.dispatch(close(commit.revision!)));
    expect(s.readTracker().status).toBe("closed");
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(1);
  }, 30000);

  it("preserves a close-policy diagnostic without treating exit zero as task closure", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    s.writeTracker({ blocked_close: true });
    expect((await s.dispatch(close(commit.revision!))).status).toBe("failed");
    const record = s.journal.tracker.operations(s.authority.runId).at(-1)!;
    expect(record).toMatchObject({ outcome: "not_closed", ioStopped: true });
    expect(record.closure?.commandReport).toContain("Policy requires an additional gate");
    expect(s.readTracker().status).toBe("in_progress");
  }, 30000);

  it("reconciles an already-stopped close after operator pause without replaying the mutation", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    const original = s.transport.close.bind(s.transport);
    vi.spyOn(s.transport, "close").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      s.journal.changeStatus(s.authority, "paused");
      return result;
    });
    expect((await s.dispatch(close(commit.revision!))).status).toBe("indeterminate");
    const pending = s.journal.tracker.pending(s.authority.runId)!;
    expect(pending).toMatchObject({
      ioStopped: true,
      outcome: null,
      closure: { intervention: false },
    });
    expect(s.readTracker().status).toBe("closed");
    // Cold/bootstrap inspection may run while paused; it must not fail the
    // original action merely because approval still awaits an active controller.
    const inspected = await reconcileTracker(
      s.kernel,
      s.adapter,
      s.authority,
      pending.trackerOperationId,
    );
    expect(inspected.outcome).toBeNull();
    expect(s.journal.action(s.authority.runId, pending.actionId)?.status).toBe("indeterminate");
    s.journal.changeStatus(s.authority, "active");
    resource(
      await s.dispatch({
        kind: "reconcile_tracker_operation",
        trackerOperationId: pending.trackerOperationId,
      }),
    );
    expect(s.journal.tracker.record(s.authority.runId, pending.trackerOperationId).outcome).toBe(
      "closed",
    );
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(1);
  }, 30000);

  it("never infers unknown old tracker or Git process stop from closed refs or a new lease", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    const original = s.transport.close.bind(s.transport);
    let release!: () => void,
      entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(s.transport, "close").mockImplementationOnce(async (...args) => {
      entered = true;
      await gate;
      return original(...args);
    });
    const operation = s.dispatch(close(commit.revision!)).catch((error) => error);
    try {
      await waitFor(() => entered);
      const pending = s.journal.tracker.pending(s.authority.runId)!;
      await expect(
        s.adapter.execute(s.authority, pending.trackerOperationId, new AbortController().signal),
      ).rejects.toThrow("write-once");
      expect(s.journal.tracker.pending(s.authority.runId)?.ioStopped).toBe(false);
      s.newLease();
      await expect(s.adapter.reconcile(s.authority, pending.trackerOperationId)).rejects.toThrow(
        "Independently prove",
      );
    } finally {
      release();
    }
    expect(await operation).toBeInstanceOf(Error);
    expect(s.trackerCommands().some((args) => args[0] === "close")).toBe(false);
    expect(s.readTracker().status).toBe("in_progress");
  }, 30000);

  it("rejects changed tracker ownership before close and preserves a race during the CLI mutation", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    s.writeTracker({ assignee: "human" });
    expect((await s.dispatch(close(commit.revision!))).status).toBe("failed");
    expect(s.journal.tracker.operations(s.authority.runId).at(-1)).toMatchObject({
      mutationDispatched: false,
      outcome: "not_closed",
    });
    expect(s.trackerCommands().some((args) => args[0] === "close")).toBe(false);
    s.writeTracker({ assignee: `epicd:${s.authority.runId}` });
    resource(await s.dispatch({ kind: "refresh_tracker" }));
    const original = s.transport.close.bind(s.transport);
    vi.spyOn(s.transport, "close").mockImplementationOnce(async (...args) => {
      s.writeTracker({ assignee: "human" });
      return original(...args);
    });
    expect((await s.dispatch(close(commit.revision!))).status).toBe("failed");
    expect(s.readTracker()).toMatchObject({ status: "closed", assignee: "human" });
    expect(s.journal.tracker.operations(s.authority.runId).at(-1)?.outcome).toBe("conflict");
  }, 30000);

  it("recovers a lost verified-ref acknowledgement without repeating the Beads mutation", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    const original = s.adapter.git.withPublishedRefs.bind(s.adapter.git);
    let completed = false;
    vi.spyOn(s.adapter.git, "withPublishedRefs").mockImplementation(async (...args) => {
      await original(...args);
      if (!completed) {
        completed = true;
        throw new KernelGitError(0, "Lost read-only transaction acknowledgement");
      }
    });
    expect((await s.dispatch(close(commit.revision!))).status).toBe("indeterminate");
    const pending = s.journal.tracker.pending(s.authority.runId)!;
    expect(pending).toMatchObject({
      ioStopped: true,
      closure: { refsVerified: false, intervention: false },
    });
    resource(
      await s.dispatch({
        kind: "reconcile_tracker_operation",
        trackerOperationId: pending.trackerOperationId,
      }),
    );
    expect(s.journal.tracker.record(s.authority.runId, pending.trackerOperationId).outcome).toBe(
      "closed",
    );
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(1);
  }, 30000);

  it("awaits nested Git and tracker process stop before reconciling cancellation", async () => {
    const s = await closureFixture();
    const { commit } = await publishVerified(s);
    s.writeTracker({ hang: true });
    const running = await s.kernel.execute(s.decision(close(commit.revision!)), s.authority);
    if (running.status !== "running") throw new Error("Not running");
    await waitFor(() => s.trackerCommands().some((args) => args[0] === "close"));
    s.kernel.interruptAll();
    expect((await s.kernel.operation(running.operationId))?.status).toBe("indeterminate");
    const pending = s.journal.tracker.pending(s.authority.runId)!;
    expect(pending.ioStopped).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(existsSync(join(s.source, ".beads/late-close"))).toBe(false);
    s.writeTracker({ hang: false });
    resource(
      await s.dispatch({
        kind: "reconcile_tracker_operation",
        trackerOperationId: pending.trackerOperationId,
      }),
    );
    expect(s.journal.tracker.record(s.authority.runId, pending.trackerOperationId).outcome).toBe(
      "not_closed",
    );
    expect(s.readTracker().status).toBe("in_progress");
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(1);
  }, 30000);
});

describe.skipIf(process.platform !== "linux" || !process.env.EPICD_TEST_BR_PATH)(
  "installed Beads verified closure",
  () => {
    it("closes a real task only after claim-bound implementation, exact review and publication", async () => {
      const executable = realpathSync(process.env.EPICD_TEST_BR_PATH!);
      let taskId!: string;
      const tracker: ReviewTrackerSetup = {
        async initialize(source) {
          const fixtureHome = join(dirname(source), "br-home");
          mkdirSync(fixtureHome);
          const br = (args: string[]) => {
            const output = execFileSync(executable, [...args, "--json"], {
              cwd: source,
              env: { PATH: process.env.PATH, HOME: fixtureHome, RUST_LOG: "error" },
              encoding: "utf8",
              timeout: 30000,
            });
            return args[0] === "init" ? null : JSON.parse(output);
          };
          br(["init", "--prefix", "demo"]);
          const epic = br([
            "create",
            "Green epic",
            "--type",
            "epic",
            "--description",
            "Deliver green behavior",
          ]);
          const task = br([
            "create",
            "Green task",
            "--description",
            "Implement green behavior",
            "--acceptance-criteria",
            "The application check passes",
          ]);
          br(["dep", "add", task.id, epic.id, "--type", "parent-child"]);
          taskId = task.id;
          return { epicId: epic.id, taskId };
        },
        async claim({ kernel, authority }) {
          registerTrackerCapabilities(kernel, new KernelBeads(executable));
          resource(
            await trackerAction(kernel, authority, {
              kind: "request_beads_transition",
              taskId,
              transition: "claim",
              revision: null,
            }),
          );
        },
      };
      const s = await fixture(check, "sha1", tracker);
      const { commit } = await publishVerified(s);
      const id = resource(await s.dispatch(close(commit.revision!, taskId))).resourceId;
      const record = s.journal.tracker.record(s.authority.runId, id);
      expect(record.outcome).toBe("closed");
      const task = s.journal.tracker
        .snapshot(s.authority.runId, record.afterSnapshotId!)
        .graph.issues.find((issue) => issue.id === taskId)!;
      expect(task).toMatchObject({
        status: "closed",
        closedBySession: record.operationId,
        closeReason: record.closure!.reason,
      });
      expect(record.closure!.reason).toContain(commit.revision);
      expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
    }, 45000);
  },
);
