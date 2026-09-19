import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closureFixture, publishVerified } from "./fixtures/tracker-closure.js";
import { check, finding, git, resource, success, target } from "./fixtures/review.js";
import type { CandidateIdentity } from "../src/domain/delivery.js";
import type { JournalRecordTarget } from "../src/domain/journal-records.js";

const actionCheck = ({ stage: _stage, ...value }: typeof check) => value;
async function closed(s: Awaited<ReturnType<typeof closureFixture>>) {
  const published = await publishVerified(s);
  resource(
    await s.dispatch({
      kind: "request_beads_transition",
      taskId: "demo.1",
      transition: "close_task",
      revision: published.commit.revision!,
    }),
  );
  return published;
}
async function prepare(s: Awaited<ReturnType<typeof closureFixture>>): Promise<CandidateIdentity> {
  const planId = resource(
    await s.dispatch({
      kind: "define_validation_plan",
      taskId: "demo",
      acceptanceCriteria: [
        "All epic and descendant requirements are met at the published revision",
      ],
      checks: [actionCheck(check)],
    }),
  ).resourceId;
  const candidate = resource(
    await s.dispatch({
      kind: "prepare_epic_delivery",
      publicationId: s.journal.publications.repository(s.authority.runId)!.lastPublishedId!,
      trackerSnapshotId: s.journal.tracker.snapshot(s.authority.runId).snapshotId,
      validationPlanId: planId,
    }),
  );
  return { candidateId: candidate.resourceId, candidateGeneration: candidate.generation };
}
async function refresh(s: Awaited<ReturnType<typeof closureFixture>>) {
  resource(await s.dispatch({ kind: "refresh_tracker" }));
}

describe.skipIf(process.platform !== "linux")("published whole-epic review", () => {
  it("indexes only actual descendant proof records and exposes their retained history without replay", async () => {
    const s = await closureFixture("sha1", true, "preclosed"),
      run = s.authority.runId;
    const { commit, publication } = await closed(s);
    const candidate = await prepare(s);
    const closure = s.journal.tracker
      .operations(run)
      .find((operation) => operation.kind === "close_task")!;
    const reviews = [commit.reviewEvidenceId, closure.closure!.reviewEvidenceId].map((id) =>
      s.journal.reviews.evidence(run, id),
    );
    const validations = [...new Set(reviews.flatMap((review) => review.validationEvidenceIds))];
    expect(reviews.map((review) => review.phase)).toEqual(["pre_commit", "exact_revision"]);
    expect(validations).toHaveLength(2);
    const records: JournalRecordTarget[] = [
      { recordKind: "tracker_operation", recordId: closure.trackerOperationId },
      { recordKind: "commit", recordId: commit.commitId },
      { recordKind: "publication", recordId: publication.publicationId },
      ...reviews.map((review) => ({ recordKind: "review" as const, recordId: review.evidenceId })),
      ...validations.map((recordId) => ({ recordKind: "validation" as const, recordId })),
    ];
    const context = s.journal.delivery.epicReviewContext(run, candidate);
    expect(context).toMatchObject({
      preexistingClosedTaskIds: ["demo.2"],
      closedTasks: [{ taskId: "demo.1", historicalRecords: records }],
    });
    const originalTracker = s.journal.tracker.operations(run),
      originalCommits = s.journal.commits.records(run),
      originalPublications = s.journal.publications.records(run);
    for (const record of records) {
      let offset: number | null = 0,
        expectedDigest: string | null = null,
        retained = "";
      do {
        const result = success(
          await s.dispatch({
            kind: "inspect_record",
            ...record,
            offset,
            limit: 4000,
            expectedDigest,
          }),
        );
        if (result.kind !== "inspection") throw new Error("Expected primary record inspection");
        const page = JSON.parse(result.text);
        expect(page).toMatchObject({ ...record, settled: true });
        retained += page.content;
        offset = page.nextOffset;
        expectedDigest = page.digest;
      } while (offset !== null);
      const viewed = JSON.parse(retained);
      expect(viewed).toMatchObject({ ...record, record: { runId: run } });
      expect(viewed.record).not.toHaveProperty("controllerLeaseId");
      expect(viewed.record).not.toHaveProperty("ioLeaseId");
      expect(viewed.record).not.toHaveProperty("lockNonce");
      if (record.recordKind === "commit") expect(viewed.record.revision).toBe(commit.revision);
      if (record.recordKind === "review") expect(viewed.record.report.verdict).toBe("approved");
    }
    expect(s.journal.tracker.operations(run)).toEqual(originalTracker);
    expect(s.journal.commits.records(run)).toEqual(originalCommits);
    expect(s.journal.publications.records(run)).toEqual(originalPublications);
    expect(s.journal.delivery.epicReviewContext(run, candidate)).toEqual(context);
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBeNull();
  }, 30000);

  it("retains initially closed work as explicit scope without fabricating run-owned closure", async () => {
    const s = await closureFixture("sha1", true, "preclosed"),
      run = s.authority.runId;
    await closed(s);
    const candidate = await prepare(s);
    expect(s.journal.delivery.epicReviewContext(run, candidate)).toMatchObject({
      preexistingClosedTaskIds: ["demo.2"],
      closedTasks: [{ taskId: "demo.1" }],
    });
    expect(
      s.journal.tracker.operations(run).filter((operation) => operation.kind === "close_task"),
    ).toHaveLength(1);
  }, 30000);

  it("binds raw requirements despite redaction and ignores only container status in content identity", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await closed(s);
    s.writeTracker({ epic_description: "Deliver the epic; token=first-private-value" });
    await refresh(s);
    const candidate = await prepare(s);
    const before = s.journal.tracker.snapshot(run).graph;
    s.writeTracker({ epic_status: "closed" });
    await refresh(s);
    const after = s.journal.tracker.snapshot(run).graph;
    const originalTask = before.issues.find((issue) => issue.id === "demo.1")!;
    const closedParentTask = after.issues.find((issue) => issue.id === "demo.1")!;
    expect(originalTask.workDigest).not.toBe(closedParentTask.workDigest);
    expect(originalTask.contentDigest).toBe(closedParentTask.contentDigest);
    // Current source/scope is not a root-closure grant: no terminal transition was recorded.
    expect(s.journal.delivery.candidateCurrent(run, candidate)).toBe(true);
    s.writeTracker({
      epic_status: "open",
      epic_description: "Deliver the epic; token=second-private-value",
    });
    await refresh(s);
    expect(
      s.journal.tracker.snapshot(run).graph.issues.find((issue) => issue.id === "demo")!
        .description,
    ).toBe(before.issues.find((issue) => issue.id === "demo")!.description);
    expect(s.journal.delivery.candidateCurrent(run, candidate)).toBe(false);
  }, 30000);

  it("reviews the full two-task history and retains same-named checks with different commands", async () => {
    const s = await closureFixture("sha1", true, true),
      run = s.authority.runId;
    const taskCheck = { ...actionCheck(check), id: "task-test", args: ["-c", "test -s app.txt"] };
    const plan1 = resource(
      await s.dispatch({
        kind: "define_validation_plan",
        taskId: "demo.1",
        acceptanceCriteria: ["Green behavior"],
        checks: [actionCheck(check), taskCheck],
      }),
    ).resourceId;
    const first = await publishVerified(s, await s.capture(plan1));
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: "demo.1",
        transition: "close_task",
        revision: first.commit.revision!,
      }),
    );
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: "demo.2",
        transition: "claim",
        revision: null,
      }),
    );
    const base = s.journal.commits.implementationBase(run, first.commit.commitId);
    const workspace = await s.manager.create(
      s.authority,
      base.sourcePath,
      base.revision,
      "implementation",
    );
    s.journal.agents.reserveAgent(
      s.authority,
      {
        ...target(workspace),
        role: "implementation",
        purpose: "implementation",
        taskId: "demo.2",
        candidateId: null,
        instructions: "Deliver the integration behavior",
        confinementProfile: "fixture-only",
        contract: s.writer.contract,
      },
      s.journal.control(run).controlVersion,
    );
    writeFileSync(join(workspace.path, "integration.txt"), "ready\n");
    const plan2 = resource(
      await s.dispatch({
        kind: "define_validation_plan",
        taskId: "demo.2",
        acceptanceCriteria: ["Integration artifact is present"],
        checks: [actionCheck(check), { ...taskCheck, args: ["-c", "test -s integration.txt"] }],
      }),
    ).resourceId;
    const captured = resource(
      await s.dispatch({
        kind: "capture_candidate",
        taskId: "demo.2",
        ...target(workspace),
        validationPlanId: plan2,
      }),
    );
    const second = await publishVerified(s, {
      candidateId: captured.resourceId,
      candidateGeneration: captured.generation,
    });
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: "demo.2",
        transition: "close_task",
        revision: second.commit.revision!,
      }),
    );
    const candidate = await prepare(s);
    const plan = s.journal.delivery.plan(
      run,
      s.journal.delivery.candidate(run, candidate).validationPlanId,
    );
    expect(plan.checks).toHaveLength(3);
    expect(plan.checks.map((entry) => entry.args)).toContainEqual(["-c", "test -s app.txt"]);
    expect(plan.checks.map((entry) => entry.args)).toContainEqual([
      "-c",
      "test -s integration.txt",
    ]);
    const copy = await s.copy(candidate, second.commit.revision);
    for (const entry of plan.checks) await s.validate(candidate, copy, entry.id);
    const result = await s.review(candidate, {}, [], second.commit.revision);
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBe(
      result.evidence.evidenceId,
    );
    const turn = s.journal.agents.turn(run, result.evidence.turnIdentity!);
    expect(turn.prompt.reviewContext).toMatchObject({
      comparisonBaseRevision: s.head,
      parentRevision: first.commit.revision,
      revision: second.commit.revision,
      epic: {
        closedTasks: [
          { taskId: "demo.1", validationPlanId: plan1 },
          { taskId: "demo.2", validationPlanId: plan2 },
        ],
      },
    });
    expect(
      git(result.reviewCopy.path, "diff", "--name-only", s.head, second.commit.revision!),
    ).toBe("app.txt\nintegration.txt");
  }, 60000);

  it("requires closed descendant provenance, exact publication and a current epic plan", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { publication, commit } = await publishVerified(s);
    expect(
      (
        await s.dispatch({
          kind: "define_validation_plan",
          taskId: "demo",
          acceptanceCriteria: ["Deliver the epic"],
          checks: [actionCheck(check)],
        })
      ).status,
    ).toBe("rejected");
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: "demo.1",
        transition: "close_task",
        revision: commit.revision!,
      }),
    );
    const candidate = await prepare(s);
    const record = s.journal.delivery.candidate(run, candidate);
    expect(record).toMatchObject({
      taskId: "demo",
      source: {
        kind: "published_epic",
        publicationId: publication.publicationId,
        baselineRevision: s.head,
      },
      status: "captured",
      snapshot: { snapshotRevision: commit.revision },
    });
    expect(s.journal.delivery.candidateCurrent(run, candidate)).toBe(true);
    for (const revision of [null, s.head])
      expect(
        (await s.dispatch({ kind: "create_review_workspace", ...candidate, revision })).status,
      ).toBe("rejected");
    expect(
      (
        await s.dispatch({
          kind: "request_commit",
          ...candidate,
          subject: "Not a new implementation",
        })
      ).status,
    ).toBe("rejected");
    for (const changed of [
      { publicationId: randomUUID() },
      { trackerSnapshotId: randomUUID() },
      { validationPlanId: s.journal.delivery.candidate(run, publication).validationPlanId },
    ])
      expect(
        (
          await s.dispatch({
            kind: "prepare_epic_delivery",
            publicationId: publication.publicationId,
            trackerSnapshotId: s.journal.tracker.snapshot(run).snapshotId,
            validationPlanId: record.validationPlanId,
            ...changed,
          })
        ).status,
      ).toBe("rejected");
  }, 30000);

  it("demands fresh exact-SHA evidence and an independent final-review conversation; preserves user checkout", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { commit } = await closed(s);
    const candidate = await prepare(s);
    const index = readFileSync(join(s.source, ".git/index"));
    writeFileSync(join(s.source, "app.txt"), "concurrent user work\n");
    const premature = await s.review(candidate, {}, [], commit.revision);
    expect(premature.result, JSON.stringify(premature.evidence)).toMatchObject({
      status: "succeeded",
    });
    expect(premature.evidence.report?.verdict).toBe("approved");
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBeNull();
    const missing = s.journal.delivery.validationEvidence(
      run,
      candidate,
      "exact_revision",
      commit.revision!,
    );
    expect(missing).toMatchObject({ evidence: [], missingCheckIds: [check.id] });
    await s.validate(candidate, await s.copy(candidate, commit.revision));
    const final = await s.review(candidate, {}, [], commit.revision);
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBe(
      final.evidence.evidenceId,
    );
    const turn = s.journal.agents.turn(run, final.evidence.turnIdentity!);
    expect(turn.prompt.assignment).toMatchObject({
      taskId: "demo",
      purpose: "final_review",
    });
    expect(turn.prompt.reviewContext).toMatchObject({
      scope: "epic",
      comparisonBaseRevision: s.head,
      revision: commit.revision,
      epic: {
        epicId: "demo",
        requirements: [
          { id: "demo", acceptanceCriteria: "The check passes" },
          { id: "demo.1", description: "Implement green behavior" },
        ],
        closedTasks: [{ taskId: "demo.1" }],
      },
    });
    const taskAgents = s.journal.reviews
      .records(run, "demo.1")
      .map((review) => review.turnIdentity!.agentId);
    expect(taskAgents).not.toContain(turn.identity.agentId);
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
    expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("concurrent user work\n");
    expect(readFileSync(join(s.source, ".git/index"))).toEqual(index);
    await refresh(s);
    expect(s.journal.delivery.candidateCurrent(run, candidate)).toBe(true);
    const reopened = s.reopen().orchestration;
    expect(reopened.delivery.candidateCurrent(run, candidate)).toBe(true);
    expect(reopened.reviews.approval(run, candidate, "exact_revision")).toBe(
      final.evidence.evidenceId,
    );
  }, 30000);

  it("keeps final findings sticky across replacement final targets", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { commit } = await closed(s);
    const candidate = await prepare(s);
    await s.validate(candidate, await s.copy(candidate, commit.revision));
    const failed = await s.review(
      candidate,
      { verdict: "changes_requested", findings: [finding] },
      [],
      commit.revision,
    );
    expect(failed.evidence.report?.findings).toHaveLength(1);
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBeNull();
    const replacement = await prepare(s);
    await s.validate(replacement, await s.copy(replacement, commit.revision));
    await s.review(replacement, {}, [], commit.revision);
    expect(s.journal.reviews.approval(run, replacement, "exact_revision")).toBeNull();
    expect(s.journal.reviews.openFindings(run, replacement)).toHaveLength(1);
    expect(s.readTracker().epic_status ?? "open").toBe("open");
  }, 40000);

  it("does not accept later unowned task closure as preexisting completion", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await publishVerified(s);
    s.writeTracker({
      status: "closed",
      closed_at: new Date().toISOString(),
      close_reason: "closed elsewhere",
      closed_by_session: "unowned",
    });
    await refresh(s);
    expect(() => s.journal.tracker.closedEpicScope(run)).toThrow("closure provenance");
  }, 30000);

  it("invalidates each fresh final target after an observed scope or provenance change", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    await closed(s);
    const baseline = s.readTracker();
    for (const change of [
      { status: "open" },
      { description: "Changed work after task closure" },
      { close_reason: "Unrelated closure" },
      { assignee: "another-user" },
      { new_children: ["demo.2"] },
      { epic_description: "New epic acceptance scope" },
    ]) {
      const candidate = await prepare(s);
      expect(s.journal.delivery.candidateCurrent(run, candidate)).toBe(true);
      s.writeTracker(change);
      await refresh(s);
      expect(s.journal.delivery.candidateCurrent(run, candidate)).toBe(false);
      s.replaceTracker(baseline);
      await refresh(s);
    }
  }, 180000);

  it("carries additional delivered task checks into final validation and rejects replacement commands", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const extra = {
      ...actionCheck(check),
      id: "integration-check",
      args: ["-c", "test -s app.txt"],
    };
    const taskPlan = resource(
      await s.dispatch({
        kind: "define_validation_plan",
        taskId: "demo.1",
        acceptanceCriteria: ["The app works", "The integration contract is retained"],
        checks: [actionCheck(check), extra],
      }),
    ).resourceId;
    const { commit } = await publishVerified(s, await s.capture(taskPlan));
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: "demo.1",
        transition: "close_task",
        revision: commit.revision!,
      }),
    );
    expect(
      (
        await s.dispatch({
          kind: "define_validation_plan",
          taskId: "demo",
          acceptanceCriteria: ["Complete"],
          checks: [actionCheck(check), { ...extra, args: ["-c", "true"] }],
        })
      ).status,
    ).toBe("rejected");
    const candidate = await prepare(s);
    const record = s.journal.delivery.candidate(run, candidate);
    expect(s.journal.delivery.plan(run, record.validationPlanId).checks).toEqual([
      check,
      { ...extra, stage: "both" },
    ]);
    await s.validate(candidate, await s.copy(candidate, commit.revision));
    expect(
      s.journal.delivery.validationEvidence(run, candidate, "exact_revision", commit.revision!)
        .missingCheckIds,
    ).toEqual([extra.id]);
  }, 30000);
});
