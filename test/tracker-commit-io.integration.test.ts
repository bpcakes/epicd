import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as lifetime from "../src/adapters/command-lifetime.js";
import { CommitIORequestSchema, assertCommitWorker } from "../src/adapters/commit-io.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { reconcileTrackerCommit } from "../src/kernel/tracker-commits.js";
import { closureFixture, publishVerified } from "./fixtures/tracker-closure.js";
import { git, resource } from "./fixtures/review.js";

async function prepared() {
  const f = await closureFixture();
  const application = await publishVerified(f);
  const exported = resource(await f.dispatch({ kind: "export_tracker" }));
  return {
    f,
    application,
    request: {
      kind: "request_tracker_commit" as const,
      trackerOperationId: exported.resourceId,
      publicationId: application.publication.publicationId,
    },
  };
}

describe.skipIf(process.platform !== "linux")("tracker commit writer lifetime", () => {
  it("fences an unused tracker writer and refuses its delayed dispatch without creating or publishing a commit", async () => {
    const f = await closureFixture();
    const application = await publishVerified(f);
    const exported = resource(await f.dispatch({ kind: "export_tracker" }));
    const start = lifetime.startDurableCommand;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation(() => {
      throw new Error("Lost caller before tracker writer dispatch");
    });
    try {
      expect(
        (
          await f.dispatch({
            kind: "request_tracker_commit",
            trackerOperationId: exported.resourceId,
            publicationId: application.publication.publicationId,
          })
        ).status,
      ).toBe("failed");
      expect(fault).toHaveBeenCalledOnce();
      const [intent, launch] = fault.mock.calls[0]!;
      fault.mockRestore();
      const record = f.journal.trackerCommits.records(f.authority.runId)[0]!;
      const operation = f.journal.agents.workspaceOperation(
        f.authority.runId,
        record.workspaceOperationId,
      );
      expect(record).toMatchObject({
        status: "failed",
        dispatched: false,
        revision: null,
        sourceIntact: false,
      });
      expect(operation).toMatchObject({
        kind: "commit",
        status: "failed",
        execution: intent,
        executionStop: { kind: "not_started", code: null, reason: "cancelled" },
      });
      expect(operation.stopEvidence).toContain("Independent");
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, record)).toBeNull();
      const delayed = start(intent, launch);
      delayed.child.stdout!.resume();
      delayed.child.stderr!.resume();
      await expect(delayed.result).rejects.toThrow("supervisor failed");
      expect(f.journal.trackerCommits.records(f.authority.runId)).toEqual([record]);
      expect(
        git(
          f.journal.agents.workspace(f.authority.runId, record).path,
          "for-each-ref",
          "refs/epicd/tracker-commits/",
        ),
      ).toBe("");
      expect(f.journal.publications.repository(f.authority.runId)!.publishedRevision).toBe(
        application.commit.revision,
      );
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
      expect(
        (
          await f.dispatch({
            kind: "request_publish_tracker",
            trackerCommitId: record.trackerCommitId,
            expectedPreviousRevision: record.parentRevision,
          })
        ).status,
      ).toBe("rejected");
    } finally {
      fault.mockRestore();
    }
  }, 45000);

  it("refuses to reconcile a write still owned by the live kernel without cancelling or replaying it", async () => {
    const { f, request } = await prepared();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = f.manager.writeTrackerCommit.bind(f.manager);
    const held = vi.spyOn(f.manager, "writeTrackerCommit").mockImplementation(async (...args) => {
      await barrier;
      await write(...args);
    });
    const started = await f.kernel.execute(f.decision(request), f.authority);
    if (started.status !== "running") throw new Error("Expected asynchronous tracker writer");
    const completion = f.kernel.operation(started.operationId)!;
    try {
      const record = f.journal.trackerCommits.records(f.authority.runId)[0]!;
      expect(
        await f.dispatch({
          kind: "reconcile_tracker_commit",
          trackerCommitId: record.trackerCommitId,
        }),
      ).toMatchObject({
        status: "rejected",
        code: "tracker_commit_live",
      });
      expect(f.journal.trackerCommits.record(f.authority.runId, record.trackerCommitId)).toEqual(
        record,
      );
      expect(
        f.journal.agents.activeWorkspaceOperation(f.authority.runId, record)?.operationId,
      ).toBe(record.workspaceOperationId);
      release();
      expect((await completion).status).toBe("succeeded");
      expect(held).toHaveBeenCalledOnce();
    } finally {
      release();
      await completion;
      held.mockRestore();
    }
  }, 45000);

  it.each(["before_ack", "after_ack"] as const)(
    "recovers the exact tracker writer after caller SIGKILL %s without publishing or rewriting it",
    async (crashPoint) => {
      const { f, application, request } = await prepared();
      f.preserveArtifacts();
      process.stdout.write(`Retained tracker caller crash fixture (${crashPoint}): ${f.root}\n`);
      writeFileSync(join(f.source, "app.txt"), "user's staged bytes\n");
      git(f.source, "add", "app.txt");
      const index = readFileSync(join(f.source, ".git/index"));
      writeFileSync(join(f.source, "app.txt"), "user's unstaged bytes\n");
      const trackerBytes = readFileSync(join(f.source, ".beads/issues.jsonl"));
      const child = spawn(process.execPath, [resolve("test/fixtures/commit-kernel-caller.mjs")], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      const closed = once(child, "close");
      void closed.catch(() => {});
      child.stdout.resume();
      let diagnostics = "";
      child.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-4000);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(
        JSON.stringify({
          stateFile: f.store.storageIdentity(),
          workspaceRoot: join(f.root, "managed"),
          authority: f.authority,
          decision: f.decision(request),
          crashPoint,
        }),
      );
      try {
        expect(await closed, diagnostics).toEqual([null, "SIGKILL"]);
        const pending = f.journal.trackerCommits.records(f.authority.runId)[0]!;
        expect(pending).toMatchObject({ status: "writing", sourceIntact: false });
        const operation = f.journal.agents.workspaceOperation(
          f.authority.runId,
          pending.workspaceOperationId,
        );
        expect(operation.execution).not.toBeNull();
        expect(operation.stopEvidence).toBeNull();
        const receipt = await lifetime.readCommandStop(operation.execution!);
        expect(receipt).toMatchObject({ kind: "stopped", code: 0, reason: null, error: null });
        expect(operation.executionStop).toEqual(crashPoint === "after_ack" ? receipt : null);
        const canonical = f.journal.agents.workspace(f.authority.runId, pending).path;
        const object = git(canonical, "cat-file", "commit", pending.revision!);
        f.newLease();
        const journal = f.reopen().orchestration;
        journal.markInterruptedActions(f.authority);
        const manager = new WorkspaceManager(journal, join(f.root, "managed"));
        const settled = await reconcileTrackerCommit(
          journal,
          manager,
          f.authority,
          pending.trackerCommitId,
        );
        expect(settled).toMatchObject({
          status: "created",
          revision: pending.revision,
          sourceIntact: true,
        });
        expect(
          journal.agents.workspaceOperation(f.authority.runId, pending.workspaceOperationId)
            .executionStop,
        ).toEqual(receipt);
        expect(
          await reconcileTrackerCommit(journal, manager, f.authority, pending.trackerCommitId),
        ).toEqual(settled);
        expect(git(canonical, "cat-file", "commit", pending.revision!)).toBe(object);
        expect(
          git(canonical, "for-each-ref", "--format=%(objectname)", "refs/epicd/tracker-commits/"),
        ).toBe(pending.revision);
        expect(
          git(canonical, "diff", "--name-only", pending.parentRevision, pending.revision!),
        ).toBe(".beads/issues.jsonl");
        expect(journal.publications.repository(f.authority.runId)!.publishedRevision).toBe(
          application.commit.revision,
        );
        expect(journal.reviews.records(f.authority.runId)).toHaveLength(2);
        expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
        expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
        expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user's unstaged bytes\n");
        expect(readFileSync(join(f.source, ".beads/issues.jsonl"))).toEqual(trackerBytes);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    },
    45000,
  );

  it("requires the typed tracker target and host-worker stop before settling an unused Git gate", async () => {
    const { f, request } = await prepared();
    let observed: { target: string; wrongKind: boolean; prematureStop: boolean } | undefined;
    const fault = vi
      .spyOn(lifetime, "startDurableCommand")
      .mockImplementation((_intent, launch) => {
        const input = CommitIORequestSchema.parse(JSON.parse(launch.extraInput!));
        const record = assertCommitWorker(f.journal, input);
        if (!("trackerCommitId" in record)) throw new Error("Not a tracker worker");
        let wrongKind = false,
          prematureStop = false;
        try {
          assertCommitWorker(f.journal, {
            ...input,
            target: { kind: "application", commitId: record.trackerCommitId },
          });
        } catch {
          wrongKind = true;
        }
        try {
          f.journal.trackerCommits.cancelUndispatched(f.authority, record.trackerCommitId);
        } catch {
          prematureStop = true;
        }
        observed = { target: input.target.kind, wrongKind, prematureStop };
        throw new Error("Stop after examining pre-dispatch guards");
      });
    try {
      expect((await f.dispatch(request)).status).toBe("failed");
      expect(observed).toEqual({ target: "tracker", wrongKind: true, prematureStop: true });
      expect(fault).toHaveBeenCalledOnce();
      const record = f.journal.trackerCommits.records(f.authority.runId)[0]!;
      expect(record).toMatchObject({ status: "failed", dispatched: false, revision: null });
      expect(
        f.journal.agents.workspaceOperation(f.authority.runId, record.workspaceOperationId)
          .executionStop,
      ).toMatchObject({ kind: "not_started" });
    } finally {
      fault.mockRestore();
    }
  }, 45000);
});
