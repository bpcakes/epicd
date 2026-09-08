import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import * as lifetime from "../src/adapters/command-lifetime.js";
import { StateStore } from "../src/adapters/store.js";
import { reconcileCommit } from "../src/kernel/commits.js";
import type { CandidateIdentity } from "../src/domain/delivery.js";
import { fixture, check, finding, git, resource, success, target } from "./fixtures/review.js";

async function approved(s: Awaited<ReturnType<typeof fixture>>) {
  const candidate = await s.capture(await s.define());
  const validation = await s.validate(candidate, await s.copy(candidate));
  expect(validation).toMatchObject({ outcome: "succeeded", satisfiesCheck: true });
  const review = await s.review(candidate);
  expect(review.result.status).toBe("succeeded");
  expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBe(review.evidence.evidenceId);
  return { candidate, review };
}
async function commit(s: Awaited<ReturnType<typeof fixture>>, candidate: CandidateIdentity) {
  const created = resource(
    await s.dispatch({ kind: "request_commit", ...candidate, subject: "Implement green behavior" }),
  );
  return s.journal.commits.record(s.authority.runId, created.resourceId);
}

describe.skipIf(process.platform !== "linux")("private commit and actual-SHA verification", () => {
  it("retains candidate eligibility through healthy writer/reviewer retirement but not later revocation", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const { candidate, review } = await approved(s);
    const snapshot = s.journal.delivery.candidate(run, candidate).snapshot!;
    s.journal.agents.retireStoppedAgent(s.authority, s.writer);
    s.journal.agents.retireStoppedAgent(s.authority, review.evidence.turnIdentity!);
    expect(s.journal.reviews.approval(run, candidate)).toBe(review.evidence.evidenceId);
    const created = await commit(s, candidate);
    expect(created).toMatchObject({
      status: "created",
      fullTree: snapshot.fullTree,
      sourceIntact: true,
    });
    await s.validate(candidate, await s.copy(candidate, created.revision!));
    const exact = await s.review(candidate, {}, [], created.revision!);
    s.journal.agents.retireStoppedAgent(s.authority, exact.evidence.turnIdentity!);
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBe(
      exact.evidence.evidenceId,
    );
    s.journal.agents.revokeAgent(s.authority, s.writer, "Later source ownership violation");
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBeNull();
    expect(s.journal.commits.record(run, created.commitId)).toEqual(created);
  });

  it.each(["sha1", "sha256"] as const)(
    "commits the approved %s tree, ignores staging, then requires fresh exact-SHA evidence",
    async (format) => {
      const s = await fixture(check, format);
      const run = s.authority.runId;
      writeFileSync(join(s.source, "app.txt"), "user owned edit\n");
      git(s.source, "add", "app.txt");
      const userIndex = readFileSync(join(s.source, ".git/index"));
      const { candidate, review } = await approved(s);
      const snapshot = s.journal.delivery.candidate(run, candidate).snapshot!;
      const privateIndex = readFileSync(join(s.workspace.path, ".git/index"));
      expect(git(s.workspace.path, "write-tree")).not.toBe(snapshot.fullTree);
      const created = await commit(s, candidate);
      expect(created).toMatchObject({
        status: "created",
        sourceIntact: true,
        failure: null,
        parentRevision: s.head,
        fullTree: snapshot.fullTree,
      });
      expect(created.revision).not.toBe(snapshot.snapshotRevision);
      expect(created.revision).toHaveLength(format === "sha1" ? 40 : 64);
      expect(git(s.workspace.path, "cat-file", "commit", created.revision!)).toBe(
        created.objectContent.trim(),
      );
      expect(git(s.workspace.path, "rev-parse", `${created.revision}^{tree}`)).toBe(
        snapshot.fullTree,
      );
      expect(git(s.workspace.path, "rev-parse", `${created.revision}^`)).toBe(s.head);
      expect(git(s.workspace.path, "show", `${created.revision}:app.txt`)).toBe("green");
      expect(git(s.workspace.path, "rev-parse", "HEAD")).toBe(s.head);
      expect(readFileSync(join(s.workspace.path, ".git/index"))).toEqual(privateIndex);
      expect(readFileSync(join(s.source, ".git/index"))).toEqual(userIndex);
      expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("user owned edit\n");
      expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
      expect(git(s.source, "for-each-ref", "refs/heads/epicd/")).toBe("");
      const exactCopy = await s.copy(candidate, created.revision!);
      expect(exactCopy).toMatchObject({
        purpose: "verification",
        baselineRevision: created.revision,
      });
      const prior = s.journal.delivery.preCommitEvidence(run, candidate).evidence;
      const missing = await s.review(candidate, {}, [], created.revision!);
      expect(missing.result.status).toBe("succeeded");
      expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBeNull();
      const validated = await s.validate(candidate, exactCopy);
      expect(validated).toMatchObject({ satisfiesCheck: true });
      if (validated.kind !== "validation") throw new Error("Expected validation");
      expect(s.journal.delivery.evidence(run, validated.evidenceId)).toMatchObject({
        phase: "exact_revision",
        revision: created.revision,
      });
      expect(s.journal.delivery.preCommitEvidence(run, candidate).evidence).toEqual(prior);
      const verified = await s.review(candidate, {}, [], created.revision!);
      expect(verified.evidence.turnIdentity!.agentId).not.toBe(
        review.evidence.turnIdentity!.agentId,
      );
      expect(
        s.journal.agents.turn(run, verified.evidence.turnIdentity!).prompt.assignment.purpose,
      ).toBe("verification");
      expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBe(
        verified.evidence.evidenceId,
      );
      const inspected = success(
        await s.dispatch({ kind: "inspect_commit", commitId: created.commitId }),
      );
      expect(JSON.stringify(inspected)).not.toContain(s.authority.leaseId);
      const reopened = s.reopen().orchestration;
      expect(reopened.commits.record(run, created.commitId)).toEqual(created);
      expect(reopened.reviews.approval(run, candidate, "exact_revision")).toBe(
        verified.evidence.evidenceId,
      );
    },
    15000,
  );

  it("rejects commit before independent approval and rejects arbitrary or synthetic verification SHAs", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    expect(
      await s.dispatch({ kind: "request_commit", ...candidate, subject: "Trust the implementer" }),
    ).toMatchObject({ status: "rejected", code: "commit_not_approved" });
    await s.validate(candidate, await s.copy(candidate));
    expect(
      await s.dispatch({ kind: "request_commit", ...candidate, subject: "Tests imply approval" }),
    ).toMatchObject({ status: "rejected", code: "commit_not_approved" });
    await s.review(candidate, { verdict: "changes_requested", findings: [finding] });
    expect(
      await s.dispatch({ kind: "request_commit", ...candidate, subject: "Ignore findings" }),
    ).toMatchObject({ status: "rejected", code: "commit_not_approved" });
    expect(s.journal.commits.records(run)).toEqual([]);
    for (const revision of [
      s.head,
      s.journal.delivery.candidate(run, candidate).snapshot!.snapshotRevision,
    ])
      expect(
        await s.dispatch({ kind: "create_review_workspace", ...candidate, revision }),
      ).toMatchObject({ status: "rejected", code: "commit_not_current" });
  });

  it.each(["source", "staged_new_file", "parent"])(
    "rejects %s changes after approval without creating a delivery commit",
    async (mutation) => {
      const s = await fixture();
      const { candidate } = await approved(s);
      if (mutation === "source")
        writeFileSync(join(s.workspace.path, "app.txt"), "changed after review\n");
      if (mutation === "staged_new_file") {
        writeFileSync(join(s.workspace.path, "surprise.txt"), "not approved\n");
        git(s.workspace.path, "add", "surprise.txt");
      }
      if (mutation === "parent")
        writeFileSync(
          join(s.workspace.path, ".git/HEAD"),
          `${s.journal.delivery.candidate(s.authority.runId, candidate).snapshot!.snapshotRevision}\n`,
        );
      expect(
        (
          await s.dispatch({
            kind: "request_commit",
            ...candidate,
            subject: "Commit approved tree",
          })
        ).status,
      ).toBe("failed");
      expect(s.journal.commits.records(s.authority.runId)[0]).toMatchObject({
        status: "failed",
        revision: null,
        sourceIntact: false,
      });
      expect(git(s.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
      expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
    },
  );

  it("replays the same decision without a second object and rejects a new commit request for the same candidate", async () => {
    const s = await fixture();
    const { candidate } = await approved(s);
    const decision = s.decision({
      kind: "request_commit",
      ...candidate,
      subject: "Implement green",
    });
    const running = await s.kernel.execute(decision, s.authority);
    if (running.status !== "running") throw new Error("Expected asynchronous commit");
    const completed = await s.kernel.operation(running.operationId)!;
    expect(completed.status).toBe("succeeded");
    expect(await s.kernel.execute(decision, s.authority)).toEqual(completed);
    expect(
      await s.dispatch({ kind: "request_commit", ...candidate, subject: "Duplicate commit" }),
    ).toMatchObject({ status: "rejected", code: "commit_exists" });
    expect(s.journal.commits.records(s.authority.runId)).toHaveLength(1);
    expect(
      git(s.workspace.path, "for-each-ref", "--format=%(objectname)", "refs/epicd/commits/").split(
        "\n",
      ),
    ).toHaveLength(1);
  });

  it("reconciles a retained commit after a lost result and a cold controller replacement without rewriting it", async () => {
    const s = await fixture();
    const { candidate } = await approved(s);
    const run = s.authority.runId;
    const write = s.manager.writeCandidateCommit.bind(s.manager);
    s.manager.writeCandidateCommit = async (...args) => {
      await write(...args);
      throw new Error("Injected lost result after confirmed I/O stop");
    };
    expect(
      (await s.dispatch({ kind: "request_commit", ...candidate, subject: "Durable intent" }))
        .status,
    ).toBe("indeterminate");
    const pending = s.journal.commits.records(run)[0]!;
    expect(pending).toMatchObject({ status: "writing", finishedAt: null });
    const raw = git(s.workspace.path, "cat-file", "commit", pending.revision!);
    s.newLease();
    const settled = await reconcileCommit(s.journal, s.manager, s.authority, pending.commitId);
    expect(settled).toMatchObject({
      status: "created",
      revision: pending.revision,
      sourceIntact: true,
    });
    expect(git(s.workspace.path, "cat-file", "commit", pending.revision!)).toBe(raw);
    expect(await reconcileCommit(s.journal, s.manager, s.authority, pending.commitId)).toEqual(
      settled,
    );
  });

  it("preserves an object created before a failed retention ref and never reports it as verified", async () => {
    const s = await fixture();
    const { candidate } = await approved(s);
    const run = s.authority.runId;
    const write = s.manager.writeCandidateCommit.bind(s.manager);
    s.manager.writeCandidateCommit = async (authority, intent, signal) => {
      // A parent-process Git mock cannot affect the isolated writer. Hold the
      // exact private ref lock so the real Git process fails after object write.
      const directory = join(s.workspace.path, ".git/refs/epicd/commits");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${intent.commitId}.lock`), "fixture-owned lock\n", {
        flag: "wx",
      });
      await write(authority, intent, signal);
    };
    expect(
      (await s.dispatch({ kind: "request_commit", ...candidate, subject: "Unretained object" }))
        .status,
    ).toBe("failed");
    const pending = s.journal.commits.records(run)[0]!;
    const settled = await reconcileCommit(s.journal, s.manager, s.authority, pending.commitId);
    expect(settled).toMatchObject({
      status: "failed",
      revision: pending.revision,
      sourceIntact: false,
    });
    expect(settled.failure).toContain("retention ref was not installed");
    expect(git(s.workspace.path, "cat-file", "-t", pending.revision!)).toBe("commit");
    expect(
      readFileSync(
        join(s.workspace.path, `.git/refs/epicd/commits/${pending.commitId}.lock`),
        "utf8",
      ),
    ).toBe("fixture-owned lock\n");
    expect(git(s.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
    expect(
      await s.dispatch({
        kind: "create_review_workspace",
        ...candidate,
        revision: pending.revision,
      }),
    ).toMatchObject({ status: "rejected", code: "commit_not_current" });
  });

  it("does not infer old I/O stop from an absent commit ref", async () => {
    const s = await fixture();
    const { candidate } = await approved(s);
    const run = s.authority.runId;
    // The actual worker rejects changed source during preflight. Hide its genuine
    // receipt: an absent commit ref still cannot release this bound I/O exclusion.
    writeFileSync(join(s.workspace.path, "app.txt"), "post-approval source bytes\n");
    const receipt = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValue(null);
    try {
      expect(
        (await s.dispatch({ kind: "request_commit", ...candidate, subject: "Uncertain operation" }))
          .status,
      ).toBe("indeterminate");
      const pending = s.journal.commits.records(run)[0]!;
      const operation = s.journal.agents.workspaceOperation(run, pending.workspaceOperationId);
      expect(operation.execution).not.toBeNull();
      expect(await lifetime.readCommandStop(operation.execution!)).toMatchObject({
        kind: "stopped",
        code: 1,
      });
      expect(git(s.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
      s.newLease();
      await expect(
        reconcileCommit(s.journal, s.manager, s.authority, pending.commitId),
      ).rejects.toThrow("no independent stop receipt");
      expect(s.journal.agents.activeWorkspaceOperation(run, pending)?.operationId).toBe(
        pending.workspaceOperationId,
      );
      expect(s.journal.commits.record(run, pending.commitId).status).toBe("preparing");
      expect(readFileSync(join(s.workspace.path, "app.txt"), "utf8")).toBe(
        "post-approval source bytes\n",
      );
    } finally {
      receipt.mockRestore();
    }
  });

  it("requires fresh validation citations and a different reviewer for actual-SHA verification", async () => {
    const s = await fixture();
    const { candidate, review } = await approved(s);
    const run = s.authority.runId;
    const created = await commit(s, candidate);
    const exact = await s.copy(candidate, created.revision!);
    expect(
      await s.dispatch({
        kind: "run_review",
        references: [],
        ...candidate,
        ...target(exact),
        agent: {
          agentId: review.evidence.turnIdentity!.agentId,
          agentGeneration: review.evidence.turnIdentity!.agentGeneration,
        },
        instructions: "Reuse the previous approval",
      }),
    ).toMatchObject({ status: "rejected", code: "review_not_independent" });
    const oldIds = s.journal.delivery
      .preCommitEvidence(run, candidate)
      .evidence.map((item) => item.evidenceId);
    await s.validate(candidate, exact);
    const forged = await s.review(
      candidate,
      { validationEvidenceIds: oldIds },
      [],
      created.revision!,
    );
    expect(forged.result.status).toBe("failed");
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBeNull();
    const accepted = await s.review(candidate, {}, [], created.revision!);
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBe(
      accepted.evidence.evidenceId,
    );
    writeFileSync(join(exact.path, "app.txt"), "host contamination\n");
    expect(await s.validate(candidate, exact)).toMatchObject({ satisfiesCheck: false });
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBeNull();
    expect(s.journal.reviews.approval(run, candidate)).toBe(review.evidence.evidenceId);
  }, 15000);

  it("invalidates exact-SHA eligibility after a writer resumes and quarantines raw commit rows", async () => {
    const s = await fixture();
    const { candidate } = await approved(s);
    const run = s.authority.runId;
    const created = await commit(s, candidate);
    const writer = s.journal.agents.prepareTurn(
      s.authority,
      s.writer,
      randomUUID(),
      "Continue implementation",
      { type: "object" },
      s.journal.control(run).controlVersion,
    );
    expect(
      await s.dispatch({
        kind: "create_review_workspace",
        ...candidate,
        revision: created.revision,
      }),
    ).toMatchObject({ status: "rejected", code: "commit_not_current" });
    await s.driver.reconcile(s.authority, writer.identity);
    const db = new Database(s.path);
    try {
      const raw = db.prepare("SELECT * FROM delivery_commits").get();
      s.store.releaseLease(run, s.authority.ownerToken);
      db.prepare("UPDATE runs SET state_json = 'broken' WHERE run_id = ?").run(run);
      s.store.quarantineInvalidRun(run);
      const row = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id = ? AND source_table = 'delivery_commits'",
        )
        .get(run) as { row_json: string };
      expect(JSON.parse(row.row_json)).toEqual(raw);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("creates initial implementation work only from the run's frozen baseline", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const result = resource(
      await s.dispatch({ kind: "create_implementation_workspace", baseCommitId: null }),
    );
    const copy = s.journal.agents.workspace(run, {
      workspaceId: result.resourceId,
      workspaceGeneration: result.generation,
    });
    expect(copy).toMatchObject({
      baselineRevision: s.head,
      purpose: "implementation",
      sourceMode: "mutable",
    });
    expect(copy.creationOperationId).toBeTruthy();
    expect(readFileSync(join(copy.path, "app.txt"), "utf8")).toBe("red\n");
    expect(
      await s.dispatch({ kind: "create_implementation_workspace", baseCommitId: randomUUID() }),
    ).toMatchObject({ status: "rejected", code: "implementation_base_stale" });
  });

  it("rejects sibling commits from an obsolete base even when their candidate was independently approved", async () => {
    const s = await fixture();
    const first = await approved(s);
    const created = await commit(s, first.candidate);
    const sibling = await approved(s);
    expect(
      await s.dispatch({
        kind: "request_commit",
        ...sibling.candidate,
        subject: "Fork from old base",
      }),
    ).toMatchObject({ status: "rejected", code: "commit_parent_stale" });
    expect(s.journal.commits.records(s.authority.runId)).toHaveLength(1);
    expect(
      await s.dispatch({ kind: "create_implementation_workspace", baseCommitId: null }),
    ).toMatchObject({ status: "rejected", code: "implementation_base_stale" });
    expect(
      resource(
        await s.dispatch({
          kind: "create_implementation_workspace",
          baseCommitId: created.commitId,
        }),
      ).kind,
    ).toBe("resource");
  }, 15000);

  it("repairs an actual-SHA finding in a fresh workspace and appends a follow-up commit without amending history", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const first = await approved(s);
    const created = await commit(s, first.candidate);
    const exact = await s.copy(first.candidate, created.revision!);
    await s.validate(first.candidate, exact);
    const rejected = await s.review(
      first.candidate,
      { verdict: "changes_requested", findings: [finding] },
      [],
      created.revision!,
    );
    expect(rejected.result.status).toBe("succeeded");
    expect(s.journal.reviews.approval(run, first.candidate, "exact_revision")).toBeNull();
    const open = s.journal.reviews.openFindings(run, first.candidate);
    const nextCopy = resource(
      await s.dispatch({ kind: "create_implementation_workspace", baseCommitId: created.commitId }),
    );
    const workspace = s.journal.agents.workspace(run, {
      workspaceId: nextCopy.resourceId,
      workspaceGeneration: nextCopy.generation,
    });
    expect(workspace.baselineRevision).toBe(created.revision);
    s.journal.agents.reserveAgent(
      s.authority,
      {
        ...target(workspace),
        role: "implementation",
        purpose: "implementation",
        taskId: "demo.1",
        candidateId: null,
        instructions: "Repair the independently identified branch",
        confinementProfile: "fixture-only",
        contract: s.writer.contract,
      },
      s.journal.control(run).controlVersion,
    );
    writeFileSync(join(workspace.path, "regression.txt"), "explicit fixture repair\n");
    const validationPlanId = await s.define();
    const captured = resource(
      await s.dispatch({
        kind: "capture_candidate",
        taskId: "demo.1",
        ...target(workspace),
        validationPlanId,
      }),
    );
    const candidate = {
      candidateId: captured.resourceId,
      candidateGeneration: captured.generation,
    };
    await s.validate(candidate, await s.copy(candidate));
    expect(s.journal.reviews.openFindings(run, candidate)).toEqual(open);
    const fixed = await s.review(candidate, {
      resolutions: [
        {
          findingId: open[0]!.findingId,
          disposition: "resolved",
          rationale: "Inspected the new regression file and required check evidence",
        },
      ],
    });
    expect(s.journal.reviews.approval(run, candidate)).toBe(fixed.evidence.evidenceId);
    const followup = await commit(s, candidate);
    expect(followup.parentRevision).toBe(created.revision);
    expect(git(workspace.path, "rev-parse", `${followup.revision}^`)).toBe(created.revision);
    expect(git(workspace.path, "cat-file", "commit", created.revision!)).toBe(
      created.objectContent.trim(),
    );
    const verificationCopy = await s.copy(candidate, followup.revision!);
    await s.validate(candidate, verificationCopy);
    const verified = await s.review(candidate, {}, [], followup.revision!);
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBe(
      verified.evidence.evidenceId,
    );
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
    expect(s.journal.commits.records(run)).toHaveLength(2);
  }, 20000);
});
