import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as lifetime from "../src/adapters/command-lifetime.js";
import { CommitIORequestSchema, assertCommitWorker } from "../src/adapters/commit-io.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { reconcileCommit } from "../src/kernel/commits.js";
import { fixture, git } from "./fixtures/review.js";

describe.skipIf(process.platform !== "linux")("private commit writer lifetime", () => {
  it("fences a bound but undispatched writer and rejects its delayed launch without inventing a commit", async () => {
    const f = await fixture();
    const candidate = await f.capture(await f.define());
    expect(await f.validate(candidate, await f.copy(candidate))).toMatchObject({
      outcome: "succeeded",
      satisfiesCheck: true,
    });
    const review = await f.review(candidate);
    expect(f.journal.reviews.approval(f.authority.runId, candidate)).toBe(
      review.evidence.evidenceId,
    );
    const start = lifetime.startDurableCommand;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation(() => {
      throw new Error("Lost caller before fixed writer dispatch");
    });
    try {
      const result = await f.dispatch({
        kind: "request_commit",
        ...candidate,
        subject: "One write intent",
      });
      expect(result.status).toBe("indeterminate");
      expect(fault).toHaveBeenCalledOnce();
      const [intent, launch] = fault.mock.calls[0]!;
      fault.mockRestore();
      const record = f.journal.commits.records(f.authority.runId)[0]!;
      const operation = f.journal.agents.workspaceOperation(
        f.authority.runId,
        record.workspaceOperationId,
      );
      expect(operation).toMatchObject({
        kind: "commit",
        status: "failed",
        execution: intent,
        executionStop: { kind: "not_started", code: null, reason: "cancelled" },
      });
      expect(record).toMatchObject({ status: "preparing", revision: null, sourceIntact: false });
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, record)).toBeNull();
      const delayed = start(intent, launch);
      delayed.child.stdout!.resume();
      delayed.child.stderr!.resume();
      await expect(delayed.result).rejects.toThrow("supervisor failed");
      expect(f.journal.commits.records(f.authority.runId)).toEqual([record]);
      expect(git(f.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    } finally {
      fault.mockRestore();
    }
  });

  it("recovers the original stop receipt after SIGKILL at journal acknowledgement without rewriting or exact-SHA approval", async () => {
    const f = await fixture();
    f.preserveArtifacts();
    process.stdout.write(`Retained commit caller crash fixture: ${f.root}\n`);
    const candidate = await f.capture(await f.define());
    expect(await f.validate(candidate, await f.copy(candidate))).toMatchObject({
      satisfiesCheck: true,
    });
    expect((await f.review(candidate)).result.status).toBe("succeeded");
    writeFileSync(join(f.source, "app.txt"), "user's staged content\n");
    git(f.source, "add", "app.txt");
    const index = readFileSync(join(f.source, ".git/index"));
    writeFileSync(join(f.source, "app.txt"), "user's unstaged content\n");
    const child = spawn(process.execPath, [resolve("test/fixtures/commit-kernel-caller.mjs")], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    let diagnostics = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        stateFile: f.store.storageIdentity(),
        workspaceRoot: join(f.root, "managed"),
        authority: f.authority,
        decision: f.decision({
          kind: "request_commit",
          ...candidate,
          subject: "Recover this one object",
        }),
      }),
    );
    try {
      expect(await closed, diagnostics).toEqual([null, "SIGKILL"]);
      const pending = f.journal.commits.records(f.authority.runId)[0]!;
      expect(pending).toMatchObject({ status: "writing", sourceIntact: false });
      const operation = f.journal.agents.workspaceOperation(
        f.authority.runId,
        pending.workspaceOperationId,
      );
      expect(operation.execution).not.toBeNull();
      expect(operation.stopEvidence).toBeNull();
      expect(operation.executionStop).toBeNull();
      const receipt = await lifetime.readCommandStop(operation.execution!);
      expect(receipt).toMatchObject({ kind: "stopped", code: 0, reason: null, error: null });
      const bytes = git(f.workspace.path, "cat-file", "commit", pending.revision!);
      f.newLease();
      const journal = f.reopen().orchestration;
      journal.markInterruptedActions(f.authority);
      const manager = new WorkspaceManager(journal, join(f.root, "managed"));
      const settled = await reconcileCommit(journal, manager, f.authority, pending.commitId);
      expect(settled).toMatchObject({
        status: "created",
        revision: pending.revision,
        sourceIntact: true,
      });
      expect(
        journal.agents.workspaceOperation(f.authority.runId, pending.workspaceOperationId)
          .executionStop,
      ).toEqual(receipt);
      expect(await reconcileCommit(journal, manager, f.authority, pending.commitId)).toEqual(
        settled,
      );
      expect(git(f.workspace.path, "cat-file", "commit", pending.revision!)).toBe(bytes);
      expect(
        git(f.workspace.path, "for-each-ref", "--format=%(objectname)", "refs/epicd/commits/"),
      ).toBe(pending.revision);
      expect(journal.reviews.approval(f.authority.runId, candidate, "exact_revision")).toBeNull();
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, pending)).toBeNull();
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
      expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
      expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user's unstaged content\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  });

  it("keeps exclusion when a completed writer's receipt is unavailable, despite an intact commit ref", async () => {
    const f = await fixture();
    const candidate = await f.capture(await f.define());
    expect(await f.validate(candidate, await f.copy(candidate))).toMatchObject({
      satisfiesCheck: true,
    });
    expect((await f.review(candidate)).result.status).toBe("succeeded");
    const fault = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValue(null);
    try {
      expect(
        (await f.dispatch({ kind: "request_commit", ...candidate, subject: "Not proof of stop" }))
          .status,
      ).toBe("indeterminate");
      const pending = f.journal.commits.records(f.authority.runId)[0]!;
      expect(pending).toMatchObject({ status: "writing", sourceIntact: false });
      expect(git(f.workspace.path, "rev-parse", `refs/epicd/commits/${pending.commitId}`)).toBe(
        pending.revision,
      );
      await expect(
        reconcileCommit(f.journal, f.manager, f.authority, pending.commitId),
      ).rejects.toThrow("no independent stop receipt");
      expect(
        f.journal.agents.activeWorkspaceOperation(f.authority.runId, pending)?.operationId,
      ).toBe(pending.workspaceOperationId);
      expect(() =>
        f.journal.agents.finishWorkspaceOperation(
          f.authority,
          pending.workspaceOperationId,
          "succeeded",
          "The ref exists",
        ),
      ).toThrow("no independent stop receipt");
      fault.mockRestore();
      expect(
        await reconcileCommit(f.journal, f.manager, f.authority, pending.commitId),
      ).toMatchObject({ status: "created", sourceIntact: true });
    } finally {
      fault.mockRestore();
    }
  });

  it("rejects changed worker request bindings before the writer touches Git", async () => {
    const f = await fixture();
    const candidate = await f.capture(await f.define());
    expect(await f.validate(candidate, await f.copy(candidate))).toMatchObject({
      satisfiesCheck: true,
    });
    expect((await f.review(candidate)).result.status).toBe("succeeded");
    let admission: { original: string; rejected: boolean[] } | undefined;
    const fault = vi
      .spyOn(lifetime, "startDurableCommand")
      .mockImplementation((_intent, launch) => {
        const request = CommitIORequestSchema.parse(JSON.parse(launch.extraInput!));
        const original = assertCommitWorker(f.journal, request).status;
        const rejected = [
          { ...request, workspaceRoot: `${request.workspaceRoot}/different` },
          { ...request, stateFile: { ...request.stateFile, inode: "0" } },
          { ...request, authority: { ...request.authority, leaseId: "foreign-lease" } },
          {
            ...request,
            target: {
              kind: "application" as const,
              commitId: "00000000-0000-4000-8000-000000000001",
            },
          },
        ].map((changed) => {
          try {
            assertCommitWorker(f.journal, changed);
            return false;
          } catch {
            return true;
          }
        });
        admission = { original, rejected };
        throw new Error("Stop after testing pre-I/O admission");
      });
    try {
      expect(
        (
          await f.dispatch({
            kind: "request_commit",
            ...candidate,
            subject: "Exact worker binding",
          })
        ).status,
      ).toBe("indeterminate");
      expect(fault).toHaveBeenCalledOnce();
      expect(admission).toEqual({ original: "preparing", rejected: [true, true, true, true] });
      expect(f.journal.commits.records(f.authority.runId)[0]).toMatchObject({
        revision: null,
        status: "preparing",
      });
      expect(git(f.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
    } finally {
      fault.mockRestore();
    }
  });
});
