import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import * as lifetime from "../src/adapters/command-lifetime.js";
import { fixture, git, resource } from "./fixtures/review.js";
import { PublicationAdapter } from "../src/adapters/publication.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import {
  PublicationRecordSchema,
  publicationView,
  publicationInspectionView,
} from "../src/domain/publication.js";
import {
  assertPublicationWorker,
  PublicationIORequestSchema,
} from "../src/adapters/publication-io.js";

async function verified(f: Awaited<ReturnType<typeof fixture>>) {
  const candidate = await f.capture(await f.define());
  await f.validate(candidate, await f.copy(candidate));
  await f.review(candidate);
  const commitId = resource(
    await f.dispatch({ kind: "request_commit", ...candidate, subject: "Green implementation" }),
  ).resourceId;
  const commit = f.journal.commits.record(f.authority.runId, commitId);
  await f.validate(candidate, await f.copy(candidate, commit.revision));
  await f.review(candidate, {}, [], commit.revision);
  return { candidate, commit };
}

describe.skipIf(process.platform !== "linux")("complete publication worker lifetime", () => {
  it("fences an undispatched publication worker without publishing, then permits a fresh request", async () => {
    const f = await fixture(),
      { candidate, commit } = await verified(f);
    const index = readFileSync(join(f.source, ".git/index"));
    const start = lifetime.startDurableCommand;
    let failedLaunches = 0;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation((intent, launch) => {
      if (
        launch.args.some((arg) => arg.endsWith("/publication-io-cli.js")) &&
        JSON.parse(launch.extraInput!).phase === "publish"
      ) {
        failedLaunches++;
        throw new Error("Controller failed before publication worker dispatch");
      }
      return start(intent, launch);
    });
    const action = {
      kind: "request_publish" as const,
      ...candidate,
      revision: commit.revision!,
      expectedPreviousRevision: f.head,
    };
    const decision = f.decision(action);
    try {
      const running = await f.kernel.execute(decision, f.authority);
      if (running.status !== "running") throw new Error("Publication was not admitted");
      const result = await f.kernel.operation(running.operationId)!;
      expect(result.status).toBe("failed");
      expect(failedLaunches).toBe(1);
      expect(f.journal.publications.records(f.authority.runId)[0]).toMatchObject({
        outcome: "not_published",
        ioStopped: true,
        publicApplied: false,
      });
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
      expect(git(f.source, "for-each-ref", "refs/heads/epicd/")).toBe("");
      expect(await f.kernel.execute(decision, f.authority)).toEqual(result);
      expect(failedLaunches).toBe(1);
      const [unused, launch] = fault.mock.calls.find(
        ([, launch]) =>
          launch.args.some((arg) => arg.endsWith("/publication-io-cli.js")) &&
          JSON.parse(launch.extraInput!).phase === "publish",
      )!;
      fault.mockRestore();
      const delayed = start(unused, launch);
      delayed.child.stdout!.resume();
      delayed.child.stderr!.resume();
      await expect(delayed.result).rejects.toThrow("supervisor failed");
      expect(git(f.source, "for-each-ref", "refs/heads/epicd/")).toBe("");
      const fresh = resource(await f.dispatch(action));
      expect(f.journal.publications.record(f.authority.runId, fresh.resourceId).outcome).toBe(
        "published",
      );
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
      expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
    } finally {
      fault.mockRestore();
    }
  });

  it("preserves a failed canonical copy and allocates fresh custody only for a new publication request", async () => {
    const f = await fixture(),
      { candidate, commit } = await verified(f);
    const db = new Database(f.path);
    const action = {
      kind: "request_publish" as const,
      ...candidate,
      revision: commit.revision!,
      expectedPreviousRevision: f.head,
    };
    try {
      db.exec(
        "CREATE TRIGGER deny_canonical_readiness BEFORE UPDATE ON workspace_creations WHEN json_extract(NEW.record_json,'$.purpose')='delivery' AND json_extract(NEW.record_json,'$.workerResult.status')='created' BEGIN SELECT RAISE(ABORT, 'Canonical readiness not retained'); END",
      );
      expect((await f.dispatch(action)).status).toBe("failed");
      const before = f.journal.publications.repository(f.authority.runId)!;
      const copy = f.journal.agents.workspaceForOperation(
        f.authority.runId,
        before.creationOperationId,
      )!;
      expect(copy).toMatchObject({
        status: "reserved",
        directory: null,
        baselineFingerprint: null,
      });
      expect(f.journal.workspaceCreations.forWorkspace(f.authority.runId, copy)).toMatchObject({
        outcome: "failed",
        stop: { kind: "stopped" },
      });
      const preserved = readFileSync(join(copy.path, "app.txt"));
      expect(preserved.toString()).toBe("red\n");
      expect(before.workspace).toBeNull();
      db.exec("DROP TRIGGER deny_canonical_readiness");
      const published = resource(await f.dispatch(action));
      const after = f.journal.publications.repository(f.authority.runId)!;
      expect(after.creationOperationId).not.toBe(before.creationOperationId);
      expect(after.workspace?.workspaceId).not.toBe(copy.workspaceId);
      expect(readFileSync(join(copy.path, "app.txt"))).toEqual(preserved);
      expect(f.journal.agents.workspace(f.authority.runId, copy).status).toBe("reserved");
      expect(f.journal.publications.record(f.authority.runId, published.resourceId).outcome).toBe(
        "published",
      );
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    } finally {
      db.close();
    }
  });

  it("requires a new inspection after losing its retained observations, without repeating publication or lock removal", async () => {
    const f = await fixture(),
      { candidate, commit } = await verified(f);
    const db = new Database(f.path);
    try {
      db.exec(
        "CREATE TRIGGER deny_publication_observations BEFORE UPDATE ON publications WHEN json_extract(NEW.record_json,'$.ioAttempts[#-1].phase')='inspect' AND json_type(NEW.record_json,'$.ioAttempts[#-1].result')='object' BEGIN SELECT RAISE(ABORT, 'Inspection observations not retained'); END",
      );
      expect(
        (
          await f.dispatch({
            kind: "request_publish",
            ...candidate,
            revision: commit.revision!,
            expectedPreviousRevision: f.head,
          })
        ).status,
      ).toBe("indeterminate");
      const pending = f.journal.publications.pending(f.authority.runId)!;
      const original = pending.ioAttempts.at(-1)!;
      expect(pending).toMatchObject({ ioStopped: true, outcome: null, lock: { released: true } });
      expect(original).toMatchObject({
        phase: "inspect",
        result: null,
        stop: { kind: "stopped", code: 1 },
      });
      expect(original.settledAt).not.toBeNull();
      expect(f.journal.publications.approval(f.authority.runId, pending.publicationId)).toBeNull();
      expect(
        PublicationRecordSchema.safeParse({
          ...pending,
          outcome: "published",
          finishedAt: new Date().toISOString(),
          canonicalApplied: true,
          publicApplied: true,
        }).success,
      ).toBe(false);
      db.exec("DROP TRIGGER deny_publication_observations");
      f.newLease();
      const journal = f.reopen().orchestration;
      const adapter = new PublicationAdapter(
        journal,
        new WorkspaceManager(journal, f.manager.storageRoot()),
      );
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      try {
        const settled = await adapter.reconcile(f.authority, pending.publicationId);
        expect(settled.outcome).toBe("published");
        expect(
          launches.mock.calls.map(([, launch]) => JSON.parse(launch.extraInput!).phase),
        ).toEqual(["inspect"]);
        expect(settled.ioAttempts.find((item) => item.attemptId === original.attemptId)).toEqual(
          original,
        );
        expect(settled.lock).toEqual(pending.lock);
      } finally {
        launches.mockRestore();
      }
    } finally {
      db.close();
    }
  });

  it.each(["publish", "inspect"] as const)(
    "rejects model reconciliation while the %s action is live",
    async (phase) => {
      const f = await fixture(),
        { candidate, commit } = await verified(f);
      const prepare = lifetime.prepareCommandLifetime;
      let release!: () => void, announce!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admitted = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const fault = vi
        .spyOn(lifetime, "prepareCommandLifetime")
        .mockImplementation(async (...args) => {
          const intent = await prepare(...args);
          if (
            args[1].args.some((arg) => arg.endsWith("/publication-io-cli.js")) &&
            JSON.parse(args[1].extraInput!).phase === phase
          ) {
            announce();
            await gate;
          }
          return intent;
        });
      const started = await f.kernel.execute(
        f.decision({
          kind: "request_publish",
          ...candidate,
          revision: commit.revision!,
          expectedPreviousRevision: f.head,
        }),
        f.authority,
      );
      if (started.status !== "running") throw new Error("Publication did not start");
      const running = f.kernel.operation(started.operationId)!;
      try {
        await admitted;
        const pending = f.journal.publications.pending(f.authority.runId)!;
        const attempt = pending.ioAttempts.at(-1)!;
        expect(attempt).toMatchObject({ phase, execution: null, settledAt: null });
        expect(
          await f.dispatch({ kind: "reconcile_publication", publicationId: pending.publicationId }),
        ).toMatchObject({ status: "rejected", code: "publication_io_live" });
        expect(
          f.journal.publications.record(f.authority.runId, pending.publicationId).ioAttempts.at(-1),
        ).toEqual(attempt);
        release();
        expect((await running).status).toBe("succeeded");
      } finally {
        release();
        await running;
        fault.mockRestore();
      }
    },
  );

  it("binds the exact publication worker request and provides bounded previews without losing retained history", async () => {
    const f = await fixture(),
      { candidate, commit } = await verified(f);
    const start = lifetime.startDurableCommand;
    let checked = false,
      rejected = 0;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation((intent, launch) => {
      if (
        launch.args.some((arg) => arg.endsWith("/publication-io-cli.js")) &&
        JSON.parse(launch.extraInput!).phase === "publish"
      ) {
        const request = PublicationIORequestSchema.parse(JSON.parse(launch.extraInput!));
        const { record } = assertPublicationWorker(f.journal, request);
        checked = true;
        for (const changed of [
          { ...request, phase: "inspect" as const },
          { ...request, attemptId: "00000000-0000-4000-8000-000000000001" },
          {
            ...request,
            stateFile: { ...request.stateFile, path: `${request.stateFile.path}-other` },
          },
        ]) {
          try {
            assertPublicationWorker(f.journal, changed);
          } catch {
            rejected++;
          }
        }
        for (const changed of [
          { ...record, workspaceRoot: `${record.workspaceRoot}-other` },
          { ...record, lockNonce: "00000000-0000-4000-8000-000000000001" },
        ])
          if (!PublicationRecordSchema.safeParse(changed).success) rejected++;
      }
      return start(intent, launch);
    });
    try {
      const publication = resource(
        await f.dispatch({
          kind: "request_publish",
          ...candidate,
          revision: commit.revision!,
          expectedPreviousRevision: f.head,
        }),
      );
      expect(checked).toBe(true);
      expect(rejected).toBe(5);
      const actual = f.journal.publications.record(f.authority.runId, publication.resourceId);
      // Synthetic formatter load only: these repeated attempts are not execution/approval evidence.
      const load = {
        ...actual,
        ioAttempts: Array.from({ length: 31 }, () => ({
          ...actual.ioAttempts[1]!,
          result: { ...actual.ioAttempts[1]!.result!, failure: "x".repeat(4000) },
        })),
      };
      const full = publicationView(load),
        preview = publicationInspectionView(load);
      expect(JSON.stringify(full).length).toBeGreaterThan(65536);
      expect(JSON.stringify(preview).length).toBeLessThan(32768);
      expect(full.ioAttempts[0]?.result?.failure).toHaveLength(4000);
      expect(preview.ioAttempts[0]?.result).toMatchObject({
        failureTruncated: true,
        failurePreview: "x".repeat(300),
      });
      expect(JSON.stringify(preview)).not.toContain(
        actual.ioAttempts[0]!.execution!.directory.path,
      );
    } finally {
      fault.mockRestore();
    }
  });

  it.each([
    { phase: "publish", crashPoint: "before_ack" },
    { phase: "publish", crashPoint: "after_ack" },
    { phase: "inspect", crashPoint: "before_ack" },
    { phase: "inspect", crashPoint: "after_ack" },
  ] as const)(
    "recovers $phase after controller SIGKILL $crashPoint without replaying writes or changing user work",
    async ({ phase, crashPoint }) => {
      const f = await fixture(),
        { candidate, commit } = await verified(f);
      f.preserveArtifacts();
      process.stdout.write(
        `Retained publication caller crash fixture (${phase}/${crashPoint}): ${f.root}\n`,
      );
      writeFileSync(join(f.source, "app.txt"), "user staged bytes\n");
      git(f.source, "add", "app.txt");
      const index = readFileSync(join(f.source, ".git/index"));
      writeFileSync(join(f.source, "app.txt"), "user unstaged bytes\n");
      const child = spawn(
        process.execPath,
        [resolve("test/fixtures/publication-kernel-caller.mjs")],
        { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], shell: false },
      );
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
          authority: f.authority,
          workspaceRoot: f.manager.storageRoot(),
          phase,
          crashPoint,
          decision: f.decision({
            kind: "request_publish",
            ...candidate,
            revision: commit.revision!,
            expectedPreviousRevision: f.head,
          }),
        }),
      );
      try {
        expect(await closed, diagnostics).toEqual([null, "SIGKILL"]);
        const pending = f.journal.publications.pending(f.authority.runId)!;
        const attempt = pending.ioAttempts.at(-1)!;
        const receipt = await lifetime.readCommandStop(attempt.execution!);
        expect(attempt.phase).toBe(phase);
        expect(receipt).toMatchObject({ kind: "stopped", code: 0, reason: null, error: null });
        expect(attempt).toMatchObject({
          result: { failure: null, intervention: false },
          settledAt: null,
        });
        expect(attempt.stop).toEqual(crashPoint === "after_ack" ? receipt : null);
        expect(pending).toMatchObject({ outcome: null, ioStopped: false });
        for (const id of attempt.workspaceOperations)
          expect(
            f.journal.agents.workspaceOperation(f.authority.runId, id).stopEvidence,
          ).toBeNull();
        if (phase === "inspect")
          expect(attempt.result).toMatchObject({
            canonical: { outcome: "applied" },
            user: { outcome: "applied" },
          });
        const branch = `refs/heads/epicd/${f.authority.runId}`;
        expect(git(f.source, "rev-parse", branch)).toBe(commit.revision);
        f.newLease();
        const journal = f.reopen().orchestration;
        journal.markInterruptedActions(f.authority);
        const adapter = new PublicationAdapter(
          journal,
          new WorkspaceManager(journal, f.manager.storageRoot()),
        );
        const launches = vi.spyOn(lifetime, "startDurableCommand");
        try {
          const settled = await adapter.reconcile(f.authority, pending.publicationId);
          expect(settled).toMatchObject({
            outcome: "published",
            ioStopped: true,
            publicApplied: true,
            canonicalApplied: true,
            intervention: false,
            lock: { released: true },
          });
          expect(
            launches.mock.calls.map(([, launch]) => JSON.parse(launch.extraInput!).phase),
          ).toEqual(phase === "publish" ? ["inspect"] : []);
          expect(await adapter.reconcile(f.authority, pending.publicationId)).toEqual(settled);
          expect(
            settled.ioAttempts.find((item) => item.attemptId === attempt.attemptId)?.stop,
          ).toEqual(receipt);
          for (const id of settled.workspaceOperations)
            expect(
              journal.agents.workspaceOperation(f.authority.runId, id).stopEvidence,
            ).not.toBeNull();
          expect(
            journal.publications.approval(f.authority.runId, pending.publicationId),
          ).not.toBeNull();
          expect(git(f.source, "rev-parse", branch)).toBe(commit.revision);
          expect(git(f.source, "cat-file", "commit", commit.revision!)).toBe(
            commit.objectContent!.trim(),
          );
          expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
          expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
          expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user unstaged bytes\n");
          const view = JSON.stringify(publicationView(settled));
          expect(view).not.toContain(attempt.execution!.directory.path);
          expect(view).not.toContain(attempt.controllerLeaseId);
        } finally {
          launches.mockRestore();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    },
  );

  it.each(["publish", "inspect"] as const)(
    "keeps all %s exclusions while its independent receipt is unavailable",
    async (phase) => {
      const f = await fixture(),
        { candidate, commit } = await verified(f);
      const recover = lifetime.recoverCommandStop;
      const fault = vi.spyOn(lifetime, "recoverCommandStop").mockImplementation((intent) => {
        const attempt = f.journal.publications.pending(f.authority.runId)?.ioAttempts.at(-1);
        return attempt?.phase === phase && attempt.execution?.ioId === intent.ioId
          ? Promise.resolve(null)
          : recover(intent);
      });
      try {
        const result = await f.dispatch({
          kind: "request_publish",
          ...candidate,
          revision: commit.revision!,
          expectedPreviousRevision: f.head,
        });
        expect(result.status).toBe("indeterminate");
        const record = f.journal.publications.pending(f.authority.runId)!;
        const attempt = record.ioAttempts.at(-1)!;
        expect(attempt).toMatchObject({
          phase,
          result: { failure: null },
          stop: null,
          settledAt: null,
        });
        expect(record.ioStopped).toBe(false);
        for (const id of attempt.workspaceOperations) {
          expect(
            f.journal.agents.workspaceOperation(f.authority.runId, id).stopEvidence,
          ).toBeNull();
          expect(() =>
            f.journal.agents.finishWorkspaceOperation(
              f.authority,
              id,
              "succeeded",
              "Refs look complete",
            ),
          ).toThrow("complete publication worker");
        }
        await expect(f.publication.reconcile(f.authority, record.publicationId)).rejects.toThrow(
          "Independently prove",
        );
        expect(f.journal.publications.approval(f.authority.runId, record.publicationId)).toBeNull();
        fault.mockRestore();
        f.newLease();
        const journal = f.reopen().orchestration;
        const adapter = new PublicationAdapter(
          journal,
          new WorkspaceManager(journal, f.manager.storageRoot()),
        );
        expect(await adapter.reconcile(f.authority, record.publicationId)).toMatchObject({
          outcome: "published",
          ioStopped: true,
        });
        expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
      } finally {
        fault.mockRestore();
      }
    },
  );
});
