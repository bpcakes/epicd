import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closureFixture, publishVerified, publishTracker } from "./fixtures/tracker-closure.js";
import { check, finding, git, resource, target } from "./fixtures/review.js";
import { IMPLEMENTATION_OUTPUT_SCHEMA } from "../src/domain/types.js";
import type { CandidateIdentity } from "../src/domain/delivery.js";

type Setup = Awaited<ReturnType<typeof closureFixture>>;
const implementation = {
  status: "completed",
  summary: "Scripted epic repair",
  changedFiles: ["integration.txt"],
  tests: [],
  blockers: [],
};
const integrationCheck = {
  ...check,
  id: "integration-check",
  args: ["-c", "test -s integration.txt"],
  stage: "both" as const,
};
async function plan(s: Setup, extraChecks: (typeof check)[] = []) {
  const { stage: _stage, ...command } = check;
  return resource(
    await s.dispatch({
      kind: "define_validation_plan",
      taskId: "demo",
      acceptanceCriteria: ["All epic requirements and integration behavior work together"],
      checks: [command, ...extraChecks.map(({ stage: _stage, ...extra }) => extra)],
    }),
  ).resourceId;
}
async function finalTarget(s: Setup) {
  const validationPlanId = await plan(s);
  const prepared = resource(
    await s.dispatch({
      kind: "prepare_epic_delivery",
      validationPlanId,
      publicationId: s.journal.publications.repository(s.authority.runId)!.lastPublishedId!,
      trackerSnapshotId: s.journal.tracker.snapshot(s.authority.runId).snapshotId,
    }),
  );
  return { candidateId: prepared.resourceId, candidateGeneration: prepared.generation };
}
async function initial(s: Setup) {
  const delivered = await publishVerified(s);
  resource(
    await s.dispatch({
      kind: "request_beads_transition",
      taskId: "demo.1",
      transition: "close_task",
      revision: delivered.commit.revision!,
    }),
  );
  return { delivered, final: await finalTarget(s) };
}
async function workspace(s: Setup) {
  const copy = resource(
    await s.dispatch({
      kind: "create_implementation_workspace",
      baseCommitId: s.journal.commits.latestCreated(s.authority.runId)!.commitId,
    }),
  );
  return s.journal.agents.workspace(s.authority.runId, {
    workspaceId: copy.resourceId,
    workspaceGeneration: copy.generation,
  });
}
async function start(
  s: Setup,
  candidate: CandidateIdentity,
  copy: Awaited<ReturnType<typeof workspace>>,
  command = "printf 'ready\\n' > integration.txt",
) {
  s.response(implementation, [command]);
  const started = resource(
    await s.dispatch({
      kind: "start_agent",
      role: "implementation",
      purpose: "epic_repair",
      taskId: "demo",
      candidateId: candidate.candidateId,
      ...target(copy),
      instructions: "Repair the integration findings without reopening completed tasks",
    }),
  );
  return s.journal.agents.instance(s.authority.runId, {
    agentId: started.resourceId,
    agentGeneration: started.generation,
  });
}
async function capture(
  s: Setup,
  copy: Awaited<ReturnType<typeof workspace>>,
  extraChecks: (typeof check)[] = [],
) {
  const validationPlanId = await plan(s, extraChecks);
  const captured = resource(
    await s.dispatch({
      kind: "capture_candidate",
      taskId: "demo",
      ...target(copy),
      validationPlanId,
    }),
  );
  return { candidateId: captured.resourceId, candidateGeneration: captured.generation };
}
async function validate(s: Setup, candidate: CandidateIdentity, revision: string | null = null) {
  const copy = await s.copy(candidate, revision);
  for (const check of s.journal.delivery.plan(
    s.authority.runId,
    s.journal.delivery.candidate(s.authority.runId, candidate).validationPlanId,
  ).checks)
    expect(await s.validate(candidate, copy, check.id)).toMatchObject({
      outcome: "succeeded",
      satisfiesCheck: true,
    });
}
function resolutions(s: Setup, candidate: CandidateIdentity) {
  return s.journal.reviews.openFindings(s.authority.runId, candidate).map((entry) => ({
    findingId: entry.findingId,
    disposition: "resolved" as const,
    rationale:
      "The independently inspected integration behavior and required check now cover this finding",
  }));
}

describe.skipIf(process.platform !== "linux")("epic-scoped implementation repair", () => {
  it("repairs a final finding, appends a verified commit, and demands a fresh whole-epic approval before closure", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { delivered, final } = await initial(s);
    const trackerTip = await publishTracker(s);
    await validate(s, final, delivered.commit.revision);
    const feedback = await s.review(
      final,
      { verdict: "changes_requested", findings: [finding], requiredChecks: [integrationCheck] },
      [],
      delivered.commit.revision,
    );
    expect(feedback.result.status).toBe("succeeded");
    const copy = await workspace(s),
      writer = await start(s, final, copy);
    const assignment = s.journal.agents.assignment(run, writer.assignmentId);
    expect(assignment).toMatchObject({
      purpose: "epic_repair",
      taskId: "demo",
      epicRepair: {
        baseCommitId: delivered.commit.commitId,
        baseRevision: trackerTip.revision,
      },
    });
    expect(assignment.trackerClaim).toBeUndefined();
    const turn = s.journal.agents
      .turns(run)
      .findLast((turn) => turn.identity.assignmentId === writer.assignmentId)!;
    expect(turn.prompt.repairContext).toMatchObject({
      epicId: "demo",
      findings: [{ finding: { title: finding.title } }],
      checks: expect.arrayContaining([integrationCheck]),
    });
    expect(readFileSync(join(copy.path, "integration.txt"), "utf8")).toBe("ready\n");
    const candidate = await capture(s, copy);
    await validate(s, candidate);
    await s.review(candidate);
    expect(
      (await s.dispatch({ kind: "request_commit", ...candidate, subject: "Unresolved finding" }))
        .status,
    ).toBe("rejected");
    const precommit = await s.review(candidate, { resolutions: resolutions(s, candidate) });
    expect(
      s.journal.agents.turn(run, precommit.evidence.turnIdentity!).prompt.reviewContext,
    ).toMatchObject({ scope: "epic_repair", comparisonBaseRevision: s.head });
    const id = resource(
      await s.dispatch({
        kind: "request_commit",
        ...candidate,
        subject: "Repair epic integration",
      }),
    ).resourceId;
    const repaired = s.journal.commits.record(run, id);
    expect(repaired.parentRevision).toBe(trackerTip.revision);
    expect(git(copy.path, "show", `${repaired.revision}:.beads/issues.jsonl`)).toBe(
      git(s.source, "show", `${trackerTip.revision}:.beads/issues.jsonl`),
    );
    expect(
      (
        await s.dispatch({
          kind: "continue_agent",
          agentId: writer.agentId,
          agentGeneration: writer.agentGeneration,
          instructions: "Do not fork the old parent",
        })
      ).status,
    ).toBe("rejected");
    await validate(s, candidate, repaired.revision);
    const exact = await s.review(
      candidate,
      { resolutions: resolutions(s, candidate) },
      [],
      repaired.revision,
    );
    expect(exact.evidence.turnIdentity!.agentId).not.toBe(precommit.evidence.turnIdentity!.agentId);
    resource(
      await s.dispatch({
        kind: "request_publish",
        ...candidate,
        revision: repaired.revision!,
        expectedPreviousRevision: trackerTip.revision,
      }),
    );
    expect(
      (
        await s.dispatch({
          kind: "request_beads_transition",
          taskId: "demo",
          transition: "close_epic",
          revision: repaired.revision!,
        })
      ).status,
    ).toBe("rejected");
    const renewed = await finalTarget(s);
    expect(s.journal.delivery.candidateCurrent(run, renewed)).toBe(true);
    expect(s.journal.delivery.epicReviewContext(run, renewed)).toMatchObject({
      repairs: [{ commitId: id, checks: expect.arrayContaining([integrationCheck]) }],
    });
    expect(s.journal.reviews.openFindings(run, renewed)).toHaveLength(1);
    await validate(s, renewed, repaired.revision);
    await s.review(renewed, { resolutions: resolutions(s, renewed) }, [], repaired.revision);
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: "demo",
        transition: "close_epic",
        revision: repaired.revision!,
      }),
    );
    await publishTracker(s);
    resource(await s.dispatch({ kind: "complete_run" }));
    expect(s.journal.control(run).status).toBe("complete");
    expect(
      s
        .trackerCommands()
        .filter((args) => ["close", "update"].includes(args[0]!))
        .map((args) => [args[0], args[1]]),
    ).toEqual([
      ["update", "demo.1"],
      ["close", "demo.1"],
      ["close", "demo"],
    ]);
    expect(s.journal.commits.records(run)).toHaveLength(2);
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
  }, 120000);

  it("rejects null, task, foreign and stale-target scope without launching a repair", async () => {
    const s = await closureFixture();
    const { final } = await initial(s),
      copy = await workspace(s);
    const before = s.journal.agents.instances(s.authority.runId).length;
    for (const taskId of [null, "demo.1", "other-epic"])
      expect(
        (
          await s.dispatch({
            kind: "start_agent",
            role: "implementation",
            purpose: "epic_repair",
            taskId,
            candidateId: final.candidateId,
            ...target(copy),
            instructions: "Invalid scope",
          })
        ).status,
      ).toBe("rejected");
    expect(
      (
        await s.dispatch({
          kind: "start_agent",
          role: "implementation",
          purpose: "epic_repair",
          taskId: "demo",
          candidateId: randomUUID(),
          ...target(copy),
          instructions: "Invalid target",
        })
      ).status,
    ).toBe("rejected");
    expect(
      (
        await s.dispatch({
          kind: "start_agent",
          role: "implementation",
          purpose: "implementation",
          taskId: "demo",
          candidateId: final.candidateId,
          ...target(copy),
          instructions: "Do not turn the root into a task",
        })
      ).status,
    ).toBe("rejected");
    expect(s.journal.agents.instances(s.authority.runId)).toHaveLength(before);
  }, 30000);

  it("rejects open descendants, a closed or competing-owned root, and an old workspace base before launch", async () => {
    const s = await closureFixture();
    const { final } = await initial(s),
      copy = await workspace(s);
    const action = {
      kind: "start_agent" as const,
      role: "implementation" as const,
      purpose: "epic_repair" as const,
      taskId: "demo",
      candidateId: final.candidateId,
      ...target(copy),
      instructions: "Only repair with current scope authority",
    };
    const before = s.journal.agents.instances(s.authority.runId).length;
    for (const state of [
      { new_children: ["demo.new"], epic_status: "open", epic_assignee: null },
      { new_children: [], epic_status: "closed", epic_assignee: null },
      { new_children: [], epic_status: "open", epic_assignee: "another-owner" },
    ]) {
      s.writeTracker(state);
      resource(await s.dispatch({ kind: "refresh_tracker" }));
      expect((await s.dispatch(action)).status).toBe("rejected");
    }
    s.writeTracker({ new_children: [], epic_status: "open", epic_assignee: null });
    resource(await s.dispatch({ kind: "refresh_tracker" }));
    expect(await s.dispatch({ ...action, ...target(s.workspace) })).toMatchObject({
      status: "rejected",
      code: "epic_repair_base",
    });
    expect(s.journal.agents.instances(s.authority.runId)).toHaveLength(before);
  }, 30000);

  it("rechecks a prepared repair's root authority before dispatch", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { final } = await initial(s),
      copy = await workspace(s),
      writer = await start(s, final, copy);
    const turn = s.journal.agents.prepareTurn(
      s.authority,
      writer,
      randomUUID(),
      "Continue the repair",
      IMPLEMENTATION_OUTPUT_SCHEMA,
      s.journal.control(run).controlVersion,
    );
    s.writeTracker({ epic_assignee: "another-owner" });
    resource(await s.dispatch({ kind: "refresh_tracker" }));
    expect(() => s.journal.agents.markSubmitting(s.authority, turn.identity)).toThrow(
      "Control facts changed",
    );
    expect(s.journal.agents.turn(run, turn.identity).status).toBe("prepared");
    expect(s.journal.agents.turn(run, turn.identity).launch).toBeNull();
    s.journal.agents.cancelPreparedTurn(s.authority, turn.identity);
  }, 30000);

  it("allows correcting unreviewed draft checks without dropping policy or reviewer requirements", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { delivered, final } = await initial(s);
    await validate(s, final, delivered.commit.revision);
    expect(
      (
        await s.review(
          final,
          { verdict: "changes_requested", requiredChecks: [integrationCheck] },
          [],
          delivered.commit.revision,
        )
      ).result.status,
    ).toBe("succeeded");
    const mistakenDraft = {
      ...check,
      id: "draft-check",
      args: ["-c", "test -s misspelled-path.txt"],
    };
    await plan(s, [mistakenDraft]);
    const corrected = { ...mistakenDraft, args: ["-c", "test -s integration.txt"] };
    expect(s.journal.delivery.plan(run, await plan(s, [corrected])).checks).toContainEqual(
      corrected,
    );
    const revised = s.journal.delivery.plan(run, await plan(s));
    expect(revised.checks.some((entry) => entry.id === mistakenDraft.id)).toBe(false);
    expect(revised.checks).toContainEqual(check);
    expect(revised.checks).toContainEqual(integrationCheck);
  }, 30000);

  it("strengthens an unpublished repair plan and appends another repair after an actual-SHA finding", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { delivered, final } = await initial(s),
      copy = await workspace(s);
    await start(s, final, copy);
    const committedCheck = { ...integrationCheck, id: "repair-only-check" };
    const first = await capture(s, copy, [committedCheck]);
    await validate(s, first);
    await s.review(first);
    const firstCommit = s.journal.commits.record(
      run,
      resource(
        await s.dispatch({
          kind: "request_commit",
          ...first,
          subject: "Initial integration repair",
        }),
      ).resourceId,
    );
    await validate(s, first, firstCommit.revision);
    const strongerCheck = {
      ...integrationCheck,
      args: ["-c", 'test "$(cat integration.txt)" = corrected'],
    };
    const review = await s.review(
      first,
      { verdict: "changes_requested", findings: [finding], requiredChecks: [strongerCheck] },
      [],
      firstCommit.revision,
    );
    expect(review.result.status).toBe("succeeded");
    const strengthenedPlanId = await plan(s);
    expect(s.journal.delivery.plan(run, strengthenedPlanId).checks).toContainEqual(strongerCheck);
    expect(s.journal.delivery.plan(run, strengthenedPlanId).checks).toContainEqual(committedCheck);
    expect(
      (
        await s.dispatch({
          kind: "prepare_epic_delivery",
          validationPlanId: strengthenedPlanId,
          publicationId: delivered.publication.publicationId,
          trackerSnapshotId: s.journal.tracker.snapshot(run).snapshotId,
        })
      ).status,
    ).toBe("rejected");
    const nextCopy = await workspace(s);
    expect(nextCopy.baselineRevision).toBe(firstCommit.revision);
    await start(s, first, nextCopy, "printf 'corrected\\n' > integration.txt");
    const second = await capture(s, nextCopy);
    expect(s.journal.reviews.openFindings(run, second)).toHaveLength(1);
    await validate(s, second);
    await s.review(second, { resolutions: resolutions(s, second) });
    const secondCommit = s.journal.commits.record(
      run,
      resource(
        await s.dispatch({
          kind: "request_commit",
          ...second,
          subject: "Correct integration after exact review",
        }),
      ).resourceId,
    );
    expect(secondCommit.parentRevision).toBe(firstCommit.revision);
    await validate(s, second, secondCommit.revision);
    await s.review(second, { resolutions: resolutions(s, second) }, [], secondCommit.revision);
    resource(
      await s.dispatch({
        kind: "request_publish",
        ...second,
        revision: secondCommit.revision!,
        expectedPreviousRevision: delivered.commit.revision!,
      }),
    );
    const renewed = await finalTarget(s);
    expect(s.journal.delivery.candidateCurrent(run, renewed)).toBe(true);
    expect(s.journal.delivery.epicReviewContext(run, renewed)).toMatchObject({
      repairs: [{ commitId: firstCommit.commitId }, { commitId: secondCommit.commitId }],
    });
    expect(
      s.journal.delivery.plan(run, s.journal.delivery.candidate(run, renewed).validationPlanId)
        .checks,
    ).toContainEqual(strongerCheck);
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
  }, 60000);

  it("reopens the bound repair and prepares a cold follow-up without inventing a tracker claim", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { final } = await initial(s),
      copy = await workspace(s),
      writer = await start(s, final, copy);
    const binding = s.journal.agents.assignment(run, writer.assignmentId).epicRepair;
    s.newLease();
    const journal = s.reopen().orchestration;
    const turn = journal.agents.prepareTurn(
      s.authority,
      writer,
      randomUUID(),
      "Continue the recorded repair",
      IMPLEMENTATION_OUTPUT_SCHEMA,
      journal.control(run).controlVersion,
    );
    expect(turn.prompt.assignment.epicRepair).toEqual(binding);
    expect(turn.prompt.assignment.trackerClaim).toBeUndefined();
    expect(turn.prompt.repairContext).toMatchObject({ epicId: "demo" });
    journal.agents.cancelPreparedTurn(s.authority, turn.identity);
  }, 30000);

  it("invalidates repair evidence and follow-up when observed epic scope changes", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { final } = await initial(s),
      copy = await workspace(s),
      writer = await start(s, final, copy);
    const candidate = await capture(s, copy);
    s.writeTracker({ epic_description: "New scope after repair assignment" });
    resource(await s.dispatch({ kind: "refresh_tracker" }));
    expect(s.journal.delivery.candidateCurrent(run, candidate)).toBe(false);
    expect(
      (
        await s.dispatch({
          kind: "continue_agent",
          agentId: writer.agentId,
          agentGeneration: writer.agentGeneration,
          instructions: "Continue stale work",
        })
      ).status,
    ).toBe("rejected");
    expect(
      (await s.dispatch({ kind: "request_commit", ...candidate, subject: "Stale repair" })).status,
    ).toBe("rejected");
    expect(
      s.journal.agents
        .turns(run)
        .filter((turn) => turn.identity.assignmentId === writer.assignmentId),
    ).toHaveLength(1);
  }, 30000);

  it("replaces a stopped repair writer against the current root target while preserving its old workspace", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const { final } = await initial(s),
      copy = await workspace(s),
      writer = await start(s, final, copy);
    const candidate = await capture(s, copy),
      nextCopy = await workspace(s);
    const replacement = resource(
      await s.dispatch({
        kind: "replace_agent",
        agentId: writer.agentId,
        agentGeneration: writer.agentGeneration,
        ...target(nextCopy),
        reason: "Use a fresh repair attempt",
        instructions: "Reassess the current epic findings",
      }),
    );
    const next = s.journal.agents.instance(run, {
      agentId: replacement.resourceId,
      agentGeneration: replacement.generation,
    });
    expect(s.journal.agents.assignment(run, next.assignmentId)).toMatchObject({
      purpose: "epic_repair",
      candidateId: candidate.candidateId,
      epicRepair: expect.any(Object),
    });
    expect(readFileSync(join(copy.path, "integration.txt"), "utf8")).toBe("ready\n");
    expect(s.journal.delivery.candidateCurrent(run, candidate)).toBe(false);
  }, 30000);
});
