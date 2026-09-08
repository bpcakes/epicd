import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import * as lifetime from "../src/adapters/command-lifetime.js";
import { PublicationAdapter } from "../src/adapters/publication.js";
import { reconcileTrackerCommit } from "../src/kernel/tracker-commits.js";
import { closureFixture, publishVerified, publishTracker } from "./fixtures/tracker-closure.js";
import { git, resource } from "./fixtures/review.js";

type Setup = Awaited<ReturnType<typeof closureFixture>>;
async function trackerRequest(s: Setup) {
  const exported = resource(await s.dispatch({ kind: "export_tracker" }));
  return {
    kind: "request_tracker_commit" as const,
    trackerOperationId: exported.resourceId,
    publicationId: s.journal.publications.repository(s.authority.runId)!.lastPublishedId!,
  };
}
async function reserveTracker(s: Setup) {
  const accepted = s.journal.acceptAction(s.authority, s.decision(await trackerRequest(s)));
  if (accepted.kind !== "accepted") throw new Error("Expected admitted tracker commit");
  s.journal.startAction(s.authority, accepted.action.actionId);
  return s.journal.trackerCommits.reserve(s.authority, accepted.action.actionId);
}

describe.skipIf(process.platform !== "linux")("tracker-only delivery lineage", () => {
  it.each(["sha1", "sha256"] as const)(
    "publishes only exported JSONL on the actual %s delivery branch",
    async (format) => {
      const s = await closureFixture(format),
        run = s.authority.runId;
      const application = await publishVerified(s);
      const index = readFileSync(join(s.source, ".git/index"));
      const trackerFile = readFileSync(join(s.source, ".beads/issues.jsonl"));
      writeFileSync(join(s.source, "user-work.txt"), "preserve user work\n");
      const publication = await publishTracker(s);
      expect(publication.provenance.kind).toBe("tracker");
      expect(publication.revision).not.toBe(application.commit.revision);
      expect(git(s.source, "rev-parse", `refs/heads/epicd/${run}`)).toBe(publication.revision);
      expect(git(s.source, "rev-parse", `${publication.revision}^`)).toBe(
        application.commit.revision,
      );
      expect(
        git(s.source, "diff", "--name-only", application.commit.revision!, publication.revision),
      ).toBe(".beads/issues.jsonl");
      const committed = s.journal.trackerCommits.records(run)[0]!;
      expect(committed.applicationTree).toBe(application.commit.applicationTree);
      expect(git(s.source, "show", `${publication.revision}:.beads/issues.jsonl`)).toBe(
        s.journal.tracker.exportBytes(run, committed.exportOperationId).trim(),
      );
      expect(s.journal.reviews.records(run).length).toBe(2);
      expect(
        s.journal.publications.trackerDescendsFrom(
          run,
          publication.publicationId,
          application.publication.publicationId,
        ),
      ).toBe(true);
      expect(s.journal.trackerCommits.pending(run)).toBeNull();
      expect(readFileSync(join(s.source, ".git/index"))).toEqual(index);
      expect(readFileSync(join(s.source, ".beads/issues.jsonl"))).toEqual(trackerFile);
      expect(readFileSync(join(s.source, "user-work.txt"), "utf8")).toBe("preserve user work\n");
      expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
      resource(
        await s.dispatch({
          kind: "request_beads_transition",
          taskId: "demo.1",
          transition: "close_task",
          revision: publication.revision,
        }),
      );
      const closedTracker = await publishTracker(s);
      expect(git(s.source, "rev-parse", `${closedTracker.revision}^`)).toBe(publication.revision);
      expect(
        s.journal.publications.trackerDescendsFrom(
          run,
          closedTracker.publicationId,
          application.publication.publicationId,
        ),
      ).toBe(true);
      const base = s.journal.commits.implementationBase(run, application.commit.commitId);
      expect(base.revision).toBe(closedTracker.revision);
      const next = resource(
        await s.dispatch({
          kind: "create_implementation_workspace",
          baseCommitId: application.commit.commitId,
        }),
      );
      expect(
        s.journal.agents.workspace(run, {
          workspaceId: next.resourceId,
          workspaceGeneration: next.generation,
        }).baselineRevision,
      ).toBe(closedTracker.revision);
    },
    45000,
  );

  it("rejects a stale parent and fences new work while a tracker object awaits publication", async () => {
    const s = await closureFixture();
    const app = await publishVerified(s);
    const exported = resource(await s.dispatch({ kind: "export_tracker" }));
    expect(
      (
        await s.dispatch({
          kind: "request_tracker_commit",
          trackerOperationId: exported.resourceId,
          publicationId: "00000000-0000-4000-8000-000000000000",
        })
      ).status,
    ).toBe("rejected");
    const created = resource(
      await s.dispatch({
        kind: "request_tracker_commit",
        trackerOperationId: exported.resourceId,
        publicationId: app.publication.publicationId,
      }),
    );
    expect(
      (
        await s.dispatch({
          kind: "create_implementation_workspace",
          baseCommitId: app.commit.commitId,
        })
      ).status,
    ).toBe("rejected");
    expect(
      (
        await s.dispatch({
          kind: "request_publish_tracker",
          trackerCommitId: created.resourceId,
          expectedPreviousRevision: s.head,
        })
      ).status,
    ).toBe("rejected");
    expect(s.journal.publications.repository(s.authority.runId)!.publishedRevision).toBe(
      app.commit.revision,
    );
  }, 45000);

  it("replays the same decision without creating another tracker object", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await publishVerified(s);
    const decision = s.decision(await trackerRequest(s));
    const write = vi.spyOn(s.manager, "writeTrackerCommit");
    const started = await s.kernel.execute(decision, s.authority);
    if (started.status !== "running") throw new Error("Expected asynchronous construction");
    const completed = await s.kernel.operation(started.operationId)!;
    expect(completed.status).toBe("succeeded");
    expect(await s.kernel.execute(decision, s.authority)).toEqual(completed);
    expect(write).toHaveBeenCalledTimes(1);
    expect(s.journal.trackerCommits.records(run)).toHaveLength(1);
    const record = s.journal.trackerCommits.records(run)[0]!;
    const canonical = s.journal.agents.workspace(run, record).path;
    expect(
      git(canonical, "for-each-ref", "--format=%(objectname)", "refs/epicd/tracker-commits/"),
    ).toBe(record.revision);
  }, 45000);

  it("rechecks the tracker fence for an application publication admitted before construction", async () => {
    const s = await closureFixture();
    const app = await publishVerified(s);
    const accepted = s.journal.acceptAction(
      s.authority,
      s.decision({
        kind: "request_publish",
        ...app.candidate,
        revision: app.commit.revision!,
        expectedPreviousRevision: app.commit.revision!,
      }),
    );
    if (accepted.kind !== "accepted") throw new Error("Expected early admission");
    s.journal.startAction(s.authority, accepted.action.actionId);
    await reserveTracker(s);
    expect(() => s.journal.publications.reserve(s.authority, accepted.action.actionId)).toThrow(
      "pending tracker commit",
    );
    expect(s.journal.publications.pending(s.authority.runId)).toBeNull();
    expect(
      await s.dispatch({
        kind: "interrupt_action",
        actionId: "not-a-run-action",
        reason: "Check interruption admission while tracker commit work is pending",
      }),
    ).toMatchObject({ status: "rejected", code: "unknown_action" });
  }, 45000);

  it("settles an unused dispatch gate without Git writes and refuses to publish it", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const app = await publishVerified(s);
    const intent = await reserveTracker(s);
    expect(
      (
        await s.dispatch({
          kind: "request_publish_tracker",
          trackerCommitId: intent.trackerCommitId,
          expectedPreviousRevision: app.commit.revision!,
        })
      ).status,
    ).toBe("rejected");
    s.newLease();
    const write = vi.spyOn(s.manager, "writeTrackerCommit");
    resource(
      await s.dispatch({
        kind: "reconcile_tracker_commit",
        trackerCommitId: intent.trackerCommitId,
      }),
    );
    expect(s.journal.trackerCommits.record(run, intent.trackerCommitId)).toMatchObject({
      status: "failed",
      dispatched: false,
      revision: null,
    });
    expect(
      s.journal.agents.workspaceOperation(run, intent.workspaceOperationId).stopEvidence,
    ).toBeTruthy();
    expect(
      s.journal.actions(run).find((action) => action.operationId === intent.operationId)?.status,
    ).toBe("failed");
    expect(write).not.toHaveBeenCalled();
    expect(s.journal.trackerCommits.pending(run)).toBeNull();
    expect(git(s.source, "rev-parse", `refs/heads/epicd/${run}`)).toBe(app.commit.revision);
  }, 45000);

  it("cold-recovers an exact retained object after lost settlement without rewriting it", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await publishVerified(s);
    const intent = await reserveTracker(s);
    await s.manager.writeTrackerCommit(s.authority, intent);
    const pending = s.journal.trackerCommits.record(run, intent.trackerCommitId);
    expect(pending.status).toBe("writing");
    const canonical = s.journal.agents.workspace(run, pending).path;
    const raw = git(canonical, "cat-file", "commit", pending.revision!);
    s.newLease();
    const journal = s.reopen().orchestration;
    const manager = new WorkspaceManager(journal, join(s.root, "managed"));
    const write = vi.spyOn(manager, "writeTrackerCommit");
    const settled = await reconcileTrackerCommit(
      journal,
      manager,
      s.authority,
      pending.trackerCommitId,
    );
    expect(settled).toMatchObject({
      status: "created",
      revision: pending.revision,
      sourceIntact: true,
    });
    expect(
      await reconcileTrackerCommit(journal, manager, s.authority, pending.trackerCommitId),
    ).toEqual(settled);
    expect(write).not.toHaveBeenCalled();
    expect(git(canonical, "cat-file", "commit", pending.revision!)).toBe(raw);
  }, 45000);

  it("does not infer stop from a matching object and ref after the lease changes", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await publishVerified(s);
    const intent = await reserveTracker(s);
    // Model a crash after the adapter finished Git but before its stop record reached SQLite.
    const finish = vi.spyOn(s.journal.agents, "finishWorkspaceOperation").mockImplementation(() => {
      throw new Error("Lost durable stop acknowledgement");
    });
    const acknowledge = vi
      .spyOn(s.journal.agents, "recordWorkspaceExecutionStop")
      .mockImplementation(() => {
        throw new Error("Lost durable stop acknowledgement");
      });
    try {
      await expect(s.manager.writeTrackerCommit(s.authority, intent)).rejects.toThrow(
        "Lost durable stop",
      );
    } finally {
      finish.mockRestore();
      acknowledge.mockRestore();
    }
    const pending = s.journal.trackerCommits.record(run, intent.trackerCommitId);
    expect(
      git(
        s.journal.agents.workspace(run, pending).path,
        "rev-parse",
        `refs/epicd/tracker-commits/${pending.trackerCommitId}`,
      ),
    ).toBe(pending.revision);
    s.newLease();
    // A real supervisor now retains proof outside SQLite. Make that proof
    // unavailable to the reconciler as well; a matching ref remains insufficient.
    const unavailable = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValue(null);
    try {
      await expect(
        reconcileTrackerCommit(s.journal, s.manager, s.authority, pending.trackerCommitId),
      ).rejects.toThrow(/independent.*stop|Independently prove/i);
    } finally {
      unavailable.mockRestore();
    }
    expect(s.journal.agents.activeWorkspaceOperation(run, pending)?.operationId).toBe(
      pending.workspaceOperationId,
    );
    expect(
      (
        await s.dispatch({
          kind: "request_publish_tracker",
          trackerCommitId: pending.trackerCommitId,
          expectedPreviousRevision: pending.parentRevision,
        })
      ).status,
    ).toBe("rejected");
  }, 45000);

  it("preserves an unretained object after a ref-write failure and never publishes it", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await publishVerified(s);
    const request = await trackerRequest(s);
    const write = s.manager.writeTrackerCommit.bind(s.manager);
    const fault = vi
      .spyOn(s.manager, "writeTrackerCommit")
      .mockImplementation(async (authority, intent, signal) => {
        const directory = join(
          s.journal.agents.workspace(run, intent).path,
          ".git/refs/epicd/tracker-commits",
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${intent.trackerCommitId}.lock`), "fixture-owned lock\n", {
          flag: "wx",
        });
        await write(authority, intent, signal);
      });
    try {
      expect((await s.dispatch(request)).status).toBe("failed");
    } finally {
      fault.mockRestore();
    }
    const record = s.journal.trackerCommits.records(run)[0]!;
    expect(record).toMatchObject({ status: "failed", sourceIntact: false });
    expect(record.failure).toContain("without its retention ref");
    expect(
      git(s.journal.agents.workspace(run, record).path, "cat-file", "-t", record.revision!),
    ).toBe("commit");
    expect(
      (
        await s.dispatch({
          kind: "request_publish_tracker",
          trackerCommitId: record.trackerCommitId,
          expectedPreviousRevision: record.parentRevision,
        })
      ).status,
    ).toBe("rejected");
  }, 45000);

  it("refuses an export superseded by a later live tracker observation", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await publishVerified(s);
    const request = await trackerRequest(s);
    s.writeTracker({ epic_description: "New acceptance requirement" });
    resource(await s.dispatch({ kind: "refresh_tracker" }));
    expect(await s.dispatch(request)).toMatchObject({ status: "rejected", code: "tracker_commit" });
    expect(s.journal.trackerCommits.records(run)).toEqual([]);
  }, 45000);

  it("rolls back the intent and workspace exclusion when its audit write fails", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await publishVerified(s);
    const decision = s.decision(await trackerRequest(s));
    const accepted = s.journal.acceptAction(s.authority, decision);
    if (accepted.kind !== "accepted") throw new Error("Expected admission");
    s.journal.startAction(s.authority, accepted.action.actionId);
    const operations = () => {
      const db = new Database(s.path);
      try {
        return db
          .prepare("SELECT * FROM workspace_operations WHERE run_id = ? ORDER BY rowid")
          .all(run);
      } finally {
        db.close();
      }
    };
    const before = operations();
    const version = s.journal.control(run).controlVersion;
    const original = s.journal.appendObservation.bind(s.journal);
    const fault = vi
      .spyOn(s.journal, "appendObservation")
      .mockImplementation((authority, event) => {
        if (event.kind === "tracker_commit.reserved") throw new Error("Audit unavailable");
        return original(authority, event);
      });
    try {
      expect(() => s.journal.trackerCommits.reserve(s.authority, accepted.action.actionId)).toThrow(
        "Audit unavailable",
      );
    } finally {
      fault.mockRestore();
    }
    expect(s.journal.trackerCommits.records(run)).toEqual([]);
    expect(operations()).toEqual(before);
    expect(s.journal.control(run).controlVersion).toBe(version);
    const db = new Database(s.path);
    try {
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  }, 45000);

  it("cold-reconciles tracker publication when source and canonical custody are the same workspace", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await publishVerified(s);
    const created = resource(await s.dispatch(await trackerRequest(s)));
    const commit = s.journal.trackerCommits.record(run, created.resourceId);
    vi.spyOn(s.publication, "reconcile").mockRejectedValueOnce(
      new Error("Lost publication result"),
    );
    expect(
      (
        await s.dispatch({
          kind: "request_publish_tracker",
          trackerCommitId: commit.trackerCommitId,
          expectedPreviousRevision: commit.parentRevision,
        })
      ).status,
    ).toBe("indeterminate");
    const pending = s.journal.publications.records(run).at(-1)!;
    expect(pending).toMatchObject({ outcome: null, ioStopped: true });
    s.newLease();
    const journal = s.reopen().orchestration;
    const adapter = new PublicationAdapter(
      journal,
      new WorkspaceManager(journal, join(s.root, "managed")),
    );
    const settled = await adapter.reconcile(s.authority, pending.publicationId);
    expect(settled).toMatchObject({ outcome: "published", lock: { released: true } });
    expect(await adapter.reconcile(s.authority, pending.publicationId)).toEqual(settled);
    expect(journal.trackerCommits.pending(run)).toBeNull();
    expect(git(s.source, "rev-parse", `refs/heads/epicd/${run}`)).toBe(commit.revision);
    const db = new Database(s.path);
    try {
      const raw = db.prepare("SELECT * FROM tracker_commits WHERE run_id = ?").get(run);
      s.store.releaseLease(run, s.authority.ownerToken);
      db.prepare("UPDATE runs SET state_json = 'broken' WHERE run_id = ?").run(run);
      s.store.quarantineInvalidRun(run);
      const retained = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id = ? AND source_table = 'tracker_commits'",
        )
        .pluck()
        .get(run);
      expect(JSON.parse(retained as string)).toEqual(raw);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(git(s.source, "rev-parse", `refs/heads/epicd/${run}`)).toBe(commit.revision);
    } finally {
      db.close();
    }
  }, 45000);
});
