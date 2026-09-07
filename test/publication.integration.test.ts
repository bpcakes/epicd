import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixture, check, git, resource, success, target, waitFor } from "./fixtures/review.js";
import { PublicationAdapter } from "../src/adapters/publication.js";
import { PublicationGitError, PUBLICATION_LOCK_REF } from "../src/adapters/publication-git.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import Database from "better-sqlite3";
import type { CandidateIdentity } from "../src/domain/delivery.js";

async function verified(s: Awaited<ReturnType<typeof fixture>>) {
  const candidate = await s.capture(await s.define());
  await s.validate(candidate, await s.copy(candidate));
  await s.review(candidate);
  const commitId = resource(
    await s.dispatch({ kind: "request_commit", ...candidate, subject: "Green implementation" }),
  ).resourceId;
  const commit = s.journal.commits.record(s.authority.runId, commitId);
  await s.validate(candidate, await s.copy(candidate, commit.revision));
  const review = await s.review(candidate, {}, [], commit.revision);
  expect(s.journal.reviews.approval(s.authority.runId, candidate, "exact_revision")).toBe(
    review.evidence.evidenceId,
  );
  return { candidate, commit, review };
}
const request = (candidate: CandidateIdentity, revision: string, previous: string) => ({
  kind: "request_publish" as const,
  ...candidate,
  revision,
  expectedPreviousRevision: previous,
});

describe.skipIf(process.platform !== "linux")("durable verified publication capability", () => {
  it.each(["sha1", "sha256"] as const)(
    "publishes an exact %s verified object through canonical custody and preserves the user's checkout",
    async (format) => {
      const s = await fixture(check, format);
      const run = s.authority.runId;
      const { candidate, commit } = await verified(s);
      writeFileSync(join(s.source, "app.txt"), "user staged\n");
      git(s.source, "add", "app.txt");
      writeFileSync(join(s.source, "app.txt"), "user unstaged\n");
      const index = readFileSync(join(s.source, ".git/index"));
      const result = resource(await s.dispatch(request(candidate, commit.revision!, s.head)));
      const record = s.journal.publications.record(run, result.resourceId);
      expect(record).toMatchObject({
        outcome: "published",
        canonicalApplied: true,
        publicApplied: true,
        ioStopped: true,
        lock: { released: true },
        intervention: false,
      });
      const custody = s.journal.publications.repository(run)!;
      expect(custody).toMatchObject({
        privateRevision: commit.revision,
        publishedRevision: commit.revision,
      });
      const branch = `refs/heads/epicd/${run}`;
      expect(git(s.source, "rev-parse", branch)).toBe(commit.revision);
      expect(
        git(custody.canonicalRepository!.root.path, "cat-file", "commit", commit.revision!),
      ).toBe(commit.objectContent.trim());
      expect(git(s.source, "cat-file", "commit", commit.revision!)).toBe(
        commit.objectContent.trim(),
      );
      expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
      expect(readFileSync(join(s.source, ".git/index"))).toEqual(index);
      expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("user unstaged\n");
      expect(await s.publication.git.inspectLock(custody.userRepository!)).toBeNull();
      expect(record.packs).toHaveLength(2);
      expect(record.packs.every((pack) => pack.retained)).toBe(true);
      const inspected = success(
        await s.dispatch({ kind: "inspect_publication", publicationId: record.publicationId }),
      );
      expect(JSON.stringify(inspected)).not.toContain(record.lockNonce);
      expect(JSON.stringify(inspected)).not.toContain(s.authority.leaseId);
      expect(s.reopen().orchestration.publications.record(run, record.publicationId)).toEqual(
        record,
      );
    },
    20000,
  );

  it("rejects synthetic/pre-commit-only or revoked actual-SHA evidence without writing the repository", async () => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    await s.review(candidate);
    const id = resource(
      await s.dispatch({ kind: "request_commit", ...candidate, subject: "Green" }),
    ).resourceId;
    const commit = s.journal.commits.record(s.authority.runId, id);
    expect(await s.dispatch(request(candidate, commit.revision!, s.head))).toMatchObject({
      status: "rejected",
      code: "publication_not_verified",
    });
    await s.validate(candidate, await s.copy(candidate, commit.revision));
    await s.review(candidate, {}, [], commit.revision);
    expect(await s.dispatch(request(candidate, commit.revision!, randomUUID()))).toMatchObject({
      status: "rejected",
      code: "publication_base_stale",
    });
    const bad = await s.copy(candidate, commit.revision);
    writeFileSync(join(bad.path, "app.txt"), "contaminated\n");
    await s.validate(candidate, bad);
    expect(await s.dispatch(request(candidate, commit.revision!, s.head))).toMatchObject({
      status: "rejected",
      code: "publication_not_verified",
    });
    expect(git(s.source, "for-each-ref", `refs/heads/epicd/`)).toBe("");
    expect(s.journal.publications.records(s.authority.runId)).toEqual([]);
  }, 15000);

  it("blocks evidence-changing actions during publication while inspection and messages remain available", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = s.publication.git.updateRefs.bind(s.publication.git);
    vi.spyOn(s.publication.git, "updateRefs").mockImplementation(async (...args) => {
      entered = true;
      await gate;
      return original(...args);
    });
    const operation = s.dispatch(request(candidate, commit.revision!, s.head));
    try {
      await waitFor(() => entered);
      const pending = s.journal.publications.pending(s.authority.runId)!;
      await expect(
        s.publication.publish(s.authority, pending.publicationId, new AbortController().signal),
      ).rejects.toThrow("write-once");
      expect(s.journal.publications.pending(s.authority.runId)?.ioStopped).toBe(false);
      const planId = s.journal.delivery.candidate(s.authority.runId, candidate).validationPlanId;
      expect(
        await s.dispatch({
          kind: "capture_candidate",
          ...target(s.workspace),
          taskId: "demo.1",
          validationPlanId: planId,
        }),
      ).toMatchObject({ status: "rejected", code: "publication_unsettled" });
      expect(
        await s.dispatch({
          kind: "create_implementation_workspace",
          baseCommitId: commit.commitId,
        }),
      ).toMatchObject({ status: "rejected", code: "publication_unsettled" });
      expect((await s.dispatch({ kind: "inspect_run" })).status).toBe("succeeded");
      expect(
        (
          await s.dispatch({
            kind: "message_agent",
            agentId: s.writer.agentId,
            agentGeneration: s.writer.agentGeneration,
            message: "Keep the implementation stable",
          })
        ).status,
      ).toBe("succeeded");
      expect(() =>
        s.journal.agents.prepareTurn(
          s.authority,
          s.writer,
          randomUUID(),
          "Change behavior",
          {},
          s.journal.control(s.authority.runId).controlVersion,
        ),
      ).toThrow("Publication excludes new worker turns");
    } finally {
      release();
    }
    expect((await operation).status).toBe("succeeded");
  }, 20000);

  it("recognizes a lost Git result after confirmed I/O stop without a second publication write", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    const original = s.publication.git.updateRefs.bind(s.publication.git);
    let publicWrites = 0;
    vi.spyOn(s.publication.git, "updateRefs").mockImplementation(async (...args) => {
      await original(...args);
      if (args[0].repository.root.path === s.source) {
        publicWrites++;
        throw new Error("Lost result after ref commit");
      }
    });
    const decision = s.decision(request(candidate, commit.revision!, s.head));
    const running = await s.kernel.execute(decision, s.authority);
    if (running.status !== "running") throw new Error(JSON.stringify(running));
    const result = await s.kernel.operation(running.operationId)!;
    expect(result.status).toBe("succeeded");
    expect(await s.kernel.execute(decision, s.authority)).toEqual(result);
    expect(publicWrites).toBe(1);
    expect(s.journal.publications.records(s.authority.runId)[0]).toMatchObject({
      outcome: "published",
      failure: "Lost result after ref commit",
    });
  }, 20000);

  it("preserves an unrelated lock and a preexisting unowned run branch", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    git(s.source, "update-ref", PUBLICATION_LOCK_REF, s.head);
    expect((await s.dispatch(request(candidate, commit.revision!, s.head))).status).toBe("failed");
    expect(git(s.source, "rev-parse", PUBLICATION_LOCK_REF)).toBe(s.head);
    expect(s.journal.publications.records(s.authority.runId)[0]?.lock).toMatchObject({
      acquired: false,
      released: true,
      releaseDisposition: "other_owner",
    });
    git(s.source, "update-ref", "--no-deref", "-d", PUBLICATION_LOCK_REF, s.head);
    git(s.source, "update-ref", `refs/heads/epicd/${s.authority.runId}`, s.head);
    expect((await s.dispatch(request(candidate, commit.revision!, s.head))).status).toBe("failed");
    expect(git(s.source, "rev-parse", `refs/heads/epicd/${s.authority.runId}`)).toBe(s.head);
    expect(s.journal.publications.records(s.authority.runId).at(-1)).toMatchObject({
      outcome: "conflict",
      publicApplied: false,
    });
  }, 20000);

  it.each(["absent", "other_owner"] as const)(
    "preserves physical publication but rejects delivery eligibility when the owned lock is %s before cleanup",
    async (replacement) => {
      const s = await fixture();
      const { candidate, commit } = await verified(s);
      const original = s.publication.git.releaseLock.bind(s.publication.git);
      vi.spyOn(s.publication.git, "releaseLock").mockImplementation(async (...args) => {
        if (replacement === "absent")
          git(s.source, "update-ref", "--no-deref", "-d", PUBLICATION_LOCK_REF, args[1]);
        else git(s.source, "update-ref", "--no-deref", PUBLICATION_LOCK_REF, s.head, args[1]);
        return original(...args);
      });
      expect((await s.dispatch(request(candidate, commit.revision!, s.head))).status).toBe(
        "failed",
      );
      const record = s.journal.publications.records(s.authority.runId)[0]!;
      expect(record).toMatchObject({
        outcome: "conflict",
        publicApplied: true,
        canonicalApplied: true,
        intervention: true,
        lock: { acquired: true, released: true, releaseDisposition: replacement },
      });
      expect(s.journal.publications.approval(s.authority.runId, record.publicationId)).toBeNull();
      expect(await s.publication.git.inspectLock(record.publicRef!.repository)).toBe(
        replacement === "absent" ? null : s.head,
      );
      expect(git(s.source, "rev-parse", `refs/heads/epicd/${s.authority.runId}`)).toBe(
        commit.revision,
      );
    },
    20000,
  );

  it("recovers a lost lock-release acknowledgement without replaying publication", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    const original = s.publication.git.releaseLock.bind(s.publication.git);
    vi.spyOn(s.publication.git, "releaseLock").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("Lost release acknowledgement after stopped Git process");
    });
    const writes = vi.spyOn(s.publication.git, "updateRefs");
    await s.dispatch(request(candidate, commit.revision!, s.head));
    const pending = s.journal.publications.pending(s.authority.runId)!;
    expect(pending).toMatchObject({
      outcome: null,
      ioStopped: true,
      intervention: false,
      lock: { acquired: true, releaseRequested: true, released: false },
    });
    resource(
      await s.dispatch({ kind: "reconcile_publication", publicationId: pending.publicationId }),
    );
    expect(s.journal.publications.record(s.authority.runId, pending.publicationId)).toMatchObject({
      outcome: "published",
      lock: { released: true, releaseDisposition: "absent" },
    });
    expect(writes).toHaveBeenCalledTimes(2);
  }, 20000);

  it("creates subsequent implementation work from canonical custody and never assigns that custody to an agent", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    resource(await s.dispatch(request(candidate, commit.revision!, s.head)));
    const repository = s.journal.publications.repository(s.authority.runId)!;
    const base = s.journal.commits.implementationBase(s.authority.runId, commit.commitId);
    expect(base.sourcePath).toBe(repository.canonicalRepository!.root.path);
    // The original assignment's object storage is no longer the only source of delivery history.
    renameSync(join(s.workspace.path, ".git"), join(s.root, "preserved-original-metadata"));
    const copy = resource(
      await s.dispatch({ kind: "create_implementation_workspace", baseCommitId: commit.commitId }),
    );
    const workspace = s.journal.agents.workspace(s.authority.runId, {
      workspaceId: copy.resourceId,
      workspaceGeneration: copy.generation,
    });
    expect(workspace.baselineRevision).toBe(commit.revision);
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(commit.revision);
    const old = s.journal.agents.assignment(s.authority.runId, s.writer.assignmentId);
    expect(() =>
      s.journal.agents.reserveAgent(
        s.authority,
        {
          ...target(repository.workspace!),
          role: "implementation",
          purpose: "implementation",
          taskId: old.taskId,
          candidateId: null,
          instructions: "Do not write custody",
          confinementProfile: "fixture-only",
          contract: s.writer.contract,
        },
        s.journal.control(s.authority.runId).controlVersion,
      ),
    ).toThrow("never assigned to an agent");
  }, 20000);

  it("recovers a cold result loss only after the original I/O was recorded stopped", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    vi.spyOn(s.publication, "reconcile").mockRejectedValueOnce(
      new Error("Crash before settlement"),
    );
    expect((await s.dispatch(request(candidate, commit.revision!, s.head))).status).toBe(
      "indeterminate",
    );
    const pending = s.journal.publications.records(s.authority.runId)[0]!;
    expect(pending).toMatchObject({ outcome: null, ioStopped: true, lock: { released: false } });
    s.newLease();
    const journal = s.reopen().orchestration;
    const adapter = new PublicationAdapter(
      journal,
      new WorkspaceManager(journal, join(s.root, "managed")),
    );
    const recovered = await adapter.reconcile(s.authority, pending.publicationId);
    expect(recovered).toMatchObject({ outcome: "published", lock: { released: true } });
    expect(await adapter.reconcile(s.authority, pending.publicationId)).toEqual(recovered);
    expect(git(s.source, "rev-parse", `refs/heads/epicd/${s.authority.runId}`)).toBe(
      commit.revision,
    );
  }, 20000);

  it("recovers an unused dispatch gate across lease replacement without inferring stop from Git", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    const accepted = s.journal.acceptAction(
      s.authority,
      s.decision(request(candidate, commit.revision!, s.head)),
    );
    if (accepted.kind === "rejected") throw new Error("Expected admission");
    s.journal.startAction(s.authority, accepted.action.actionId);
    const record = s.journal.publications.reserve(s.authority, accepted.action.actionId);
    expect(record).toMatchObject({ dispatched: false, ioStopped: false });
    s.newLease();
    const result = resource(
      await s.dispatch({ kind: "reconcile_publication", publicationId: record.publicationId }),
    );
    expect(s.journal.publications.record(s.authority.runId, result.resourceId)).toMatchObject({
      outcome: "not_published",
      dispatched: false,
      ioStopped: true,
    });
    expect(s.journal.action(s.authority.runId, accepted.action.actionId)?.status).toBe("failed");
    expect(git(s.source, "for-each-ref", "refs/heads/epicd/")).toBe("");
  }, 20000);

  it("lets the orchestrator retry a settled inspection failure and settles the original action without a second write", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    const writes = vi.spyOn(s.publication.git, "updateRefs");
    vi.spyOn(s.publication.git, "observeRefs").mockRejectedValueOnce(
      new Error("Transient inspection failure"),
    );
    const decision = s.decision(request(candidate, commit.revision!, s.head));
    const running = await s.kernel.execute(decision, s.authority);
    if (running.status !== "running") throw new Error("Expected publication dispatch");
    expect((await s.kernel.operation(running.operationId)!).status).toBe("indeterminate");
    const pending = s.journal.publications.pending(s.authority.runId)!;
    expect(pending).toMatchObject({ ioStopped: true, outcome: null, intervention: false });
    resource(
      await s.dispatch({ kind: "reconcile_publication", publicationId: pending.publicationId }),
    );
    expect(s.journal.publications.record(s.authority.runId, pending.publicationId).outcome).toBe(
      "published",
    );
    expect((await s.kernel.execute(decision, s.authority)).status).toBe("succeeded");
    expect(writes).toHaveBeenCalledTimes(2); // one private transaction, one user transaction
  }, 20000);

  it("never infers unknown old I/O stopped from the absence of a branch or a replacement lease", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = s.publication.git.updateRefs.bind(s.publication.git);
    vi.spyOn(s.publication.git, "updateRefs").mockImplementation(async (...args) => {
      entered = true;
      await gate;
      return original(...args);
    });
    const operation = s
      .dispatch(request(candidate, commit.revision!, s.head))
      .catch((error: unknown) => error);
    try {
      await waitFor(() => entered);
      s.newLease();
      const pending = s.journal.publications.records(s.authority.runId)[0]!;
      await expect(s.publication.reconcile(s.authority, pending.publicationId)).rejects.toThrow(
        "Independently prove",
      );
      expect(s.journal.publications.pending(s.authority.runId)?.ioStopped).toBe(false);
      expect(git(s.source, "for-each-ref", "refs/heads/epicd/")).toBe("");
    } finally {
      release();
    }
    expect(await operation).toBeInstanceOf(Error);
    expect(s.journal.publications.pending(s.authority.runId)?.ioStopped).toBe(false);
    const pending = s.journal.publications.pending(s.authority.runId)!;
    expect(await s.publication.git.inspectLock(pending.publicRef!.repository)).toBe(
      pending.lock!.revision,
    );
  }, 20000);

  it("retries a known non-publication using retained objects without replacing the earlier pack owner", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    const original = s.publication.git.updateRefs.bind(s.publication.git);
    let failed = false;
    vi.spyOn(s.publication.git, "updateRefs").mockImplementation(async (...args) => {
      if (args[0].repository.root.path === s.source && !failed) {
        failed = true;
        throw new Error("Settled transient ref command failure");
      }
      return original(...args);
    });
    expect((await s.dispatch(request(candidate, commit.revision!, s.head))).status).toBe("failed");
    const earlier = s.journal.publications.records(s.authority.runId)[0]!;
    expect(earlier).toMatchObject({
      outcome: "not_published",
      canonicalApplied: true,
      lock: { released: true },
    });
    const priorPack = earlier.packs.find((pack) => pack.destination === "user")!;
    const keep = join(s.source, `.git/objects/pack/pack-${priorPack.record.packHash}.keep`);
    const before = readFileSync(keep);
    const id = resource(await s.dispatch(request(candidate, commit.revision!, s.head))).resourceId;
    expect(s.journal.publications.record(s.authority.runId, id)).toMatchObject({
      outcome: "published",
    });
    expect(readFileSync(keep)).toEqual(before);
    expect(
      s.journal.publications.record(s.authority.runId, id).packs[0]!.record.publicationId,
    ).toBe(earlier.publicationId);
  }, 20000);

  it.each(["partial", "intervention"] as const)(
    "retains %s effects but never turns them into usable publication evidence",
    async (fault) => {
      const s = await fixture();
      const { candidate, commit } = await verified(s);
      const original = s.publication.git.updateRefs.bind(s.publication.git);
      vi.spyOn(s.publication.git, "updateRefs").mockImplementation(async (...args) => {
        if (args[0].repository.root.path !== s.source) return original(...args);
        if (fault === "partial") {
          git(s.source, "update-ref", `refs/heads/epicd/${s.authority.runId}`, commit.revision!);
          throw new Error("Crash between ref writes");
        }
        await original(...args);
        throw new PublicationGitError("publication_conflict", "Late user worktree intervention");
      });
      expect((await s.dispatch(request(candidate, commit.revision!, s.head))).status).toBe(
        "failed",
      );
      const record = s.journal.publications.records(s.authority.runId)[0]!;
      expect(record.outcome).toBe("conflict");
      expect(record.publicApplied).toBe(fault === "intervention");
      expect(s.journal.publications.approval(s.authority.runId, record.publicationId)).toBeNull();
      expect(git(s.source, "rev-parse", `refs/heads/epicd/${s.authority.runId}`)).toBe(
        commit.revision,
      );
    },
    20000,
  );

  it("a later failed exact check revokes eligibility, not the historical physical publication", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    const id = resource(await s.dispatch(request(candidate, commit.revision!, s.head))).resourceId;
    expect(s.journal.publications.approval(s.authority.runId, id)).not.toBeNull();
    const next = await s.copy(candidate, commit.revision);
    writeFileSync(join(next.path, "app.txt"), "bad validation source\n");
    await s.validate(candidate, next);
    expect(s.journal.publications.approval(s.authority.runId, id)).toBeNull();
    expect(s.journal.publications.record(s.authority.runId, id).outcome).toBe("published");
    expect(git(s.source, "rev-parse", `refs/heads/epicd/${s.authority.runId}`)).toBe(
      commit.revision,
    );
  }, 20000);

  it("appends and independently verifies another commit, then advances the same canonical and user branches by CAS", async () => {
    const s = await fixture();
    const first = await verified(s);
    resource(await s.dispatch(request(first.candidate, first.commit.revision!, s.head)));
    const before = s.journal.publications.repository(s.authority.runId)!;
    const copy = resource(
      await s.dispatch({
        kind: "create_implementation_workspace",
        baseCommitId: first.commit.commitId,
      }),
    );
    const workspace = s.journal.agents.workspace(s.authority.runId, {
      workspaceId: copy.resourceId,
      workspaceGeneration: copy.generation,
    });
    s.journal.agents.reserveAgent(
      s.authority,
      {
        ...target(workspace),
        role: "implementation",
        purpose: "implementation",
        taskId: "demo.1",
        candidateId: null,
        instructions: "Append follow-up",
        confinementProfile: "fixture-only",
        contract: s.writer.contract,
      },
      s.journal.control(s.authority.runId).controlVersion,
    );
    writeFileSync(join(workspace.path, "follow-up.txt"), "second revision\n");
    const plan = await s.define();
    const captured = resource(
      await s.dispatch({
        kind: "capture_candidate",
        ...target(workspace),
        taskId: "demo.1",
        validationPlanId: plan,
      }),
    );
    const candidate = {
      candidateId: captured.resourceId,
      candidateGeneration: captured.generation,
    };
    await s.validate(candidate, await s.copy(candidate));
    await s.review(candidate);
    const commitId = resource(
      await s.dispatch({ kind: "request_commit", ...candidate, subject: "Follow-up" }),
    ).resourceId;
    const commit = s.journal.commits.record(s.authority.runId, commitId);
    await s.validate(candidate, await s.copy(candidate, commit.revision));
    await s.review(candidate, {}, [], commit.revision);
    resource(await s.dispatch(request(candidate, commit.revision!, first.commit.revision!)));
    const after = s.journal.publications.repository(s.authority.runId)!;
    expect(after.workspace).toEqual(before.workspace);
    expect(after.publishedRevision).toBe(commit.revision);
    expect(git(s.source, "rev-parse", `${commit.revision}^`)).toBe(first.commit.revision);
    expect(git(s.source, "show", `${commit.revision}:follow-up.txt`)).toBe("second revision");
    expect(git(s.source, "cat-file", "commit", first.commit.revision!)).toBe(
      first.commit.objectContent.trim(),
    );
  }, 25000);

  it("quarantines all current publication ownership records", async () => {
    const s = await fixture();
    const { candidate, commit } = await verified(s);
    const db = new Database(s.path);
    try {
      const id = resource(
        await s.dispatch(request(candidate, commit.revision!, s.head)),
      ).resourceId;
      const record = db.prepare("SELECT * FROM publications WHERE publication_id = ?").get(id);
      db.prepare("UPDATE runs SET state_json = 'invalid' WHERE run_id = ?").run(s.authority.runId);
      s.store.releaseLease(s.authority.runId, s.authority.ownerToken);
      s.store.quarantineInvalidRun(s.authority.runId);
      const archived = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id = ? AND source_table = 'publications'",
        )
        .get(s.authority.runId) as { row_json: string };
      expect(JSON.parse(archived.row_json)).toEqual(record);
      expect(
        db
          .prepare(
            "SELECT source_table FROM quarantined_orchestration WHERE run_id = ? AND source_table = 'delivery_repositories'",
          )
          .get(s.authority.runId),
      ).toBeDefined();
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  }, 20000);
});
