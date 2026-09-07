import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { reconcileReview } from "../src/kernel/reviews.js";
import { digestJson } from "../src/domain/repository-policy.js";
import { KernelActionSchema, type KernelAction } from "../src/domain/orchestration.js";
import type { AdaptiveReviewResult } from "../src/domain/reviews.js";
import { fixture, check, finding, git, success, target, waitFor } from "./fixtures/review.js";

describe.skipIf(process.platform !== "linux")("independent pre-commit review evidence", () => {
  it("derives persisted approval from an exact confined turn, denies transient source writes and leaves user Git untouched", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const index = readFileSync(join(s.source, ".git/index"));
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    const reviewed = await s.review(candidate, {}, [
      "if (echo contaminated > app.txt) 2>/dev/null; then exit 21; fi",
      'test "$(cat app.txt)" = green || exit 22',
    ]);
    expect(reviewed.result.status).toBe("succeeded");
    expect(reviewed.evidence).toMatchObject({
      status: "finished",
      sourceIntact: true,
      failure: null,
      report: { verdict: "approved" },
    });
    expect(s.journal.reviews.approval(run, candidate)).toBe(reviewed.evidence.evidenceId);
    const turn = s.journal.agents.turn(run, reviewed.evidence.turnIdentity!);
    expect(turn.prompt.reviewContext).toMatchObject({
      ...candidate,
      revision: reviewed.evidence.revision,
      validationPlanId: reviewed.evidence.validationPlanId,
      missingCheckIds: [],
    });
    expect(turn.promptDigest).toBe(digestJson(turn.prompt));
    expect(turn.launch).toMatchObject({
      manifest: { confinement: { sourceMode: "read-only" } },
      stop: { kind: "stopped", code: 0 },
    });
    const inspected = success(
      await s.dispatch({ kind: "inspect_review", evidenceId: reviewed.evidence.evidenceId }),
    );
    expect(JSON.stringify(inspected)).not.toContain(s.authority.leaseId);
    expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("red\n");
    expect(readFileSync(join(s.source, ".git/index"))).toEqual(index);
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
    expect(git(s.source, "status", "--porcelain")).toBe("");
    expect(s.reopen().orchestration.reviews.approval(run, candidate)).toBe(
      reviewed.evidence.evidenceId,
    );
  });

  it("keeps failed and missing kernel checks decisive despite a reviewer claiming approval", async () => {
    const s = await fixture({ ...check, args: ["-c", "exit 7"] });
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    const missing = await s.review(candidate);
    expect(missing.result.status).toBe("succeeded");
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
    expect(await s.validate(candidate, await s.copy(candidate))).toMatchObject({
      outcome: "failed",
      satisfiesCheck: false,
    });
    const failed = await s.review(candidate);
    expect(failed.result.status).toBe("succeeded");
    expect(
      s.journal.agents.turn(run, failed.evidence.turnIdentity!).prompt.reviewContext,
    ).toMatchObject({ missingCheckIds: [check.id] });
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
  });

  it("preserves findings across replacement, requires explicit resolution and disallows choosing an older approval", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    const first = await s.review(candidate, { verdict: "changes_requested", findings: [finding] });
    expect(first.result.status).toBe("succeeded");
    const found = s.journal.reviews.openFindings(run, candidate);
    expect(found).toHaveLength(1);
    const replacement = await s.review(candidate);
    expect(replacement.evidence.turnIdentity!.agentId).not.toBe(
      first.evidence.turnIdentity!.agentId,
    );
    expect(
      s.journal.agents.turn(run, replacement.evidence.turnIdentity!).prompt.reviewContext,
    ).toMatchObject({ findings: [found[0]] });
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
    const resolved = await s.review(candidate, {
      resolutions: [
        {
          findingId: found[0]!.findingId,
          disposition: "dismissed",
          rationale: "Inspected the cited branch; the check covers the expected condition.",
        },
      ],
    });
    expect(s.journal.reviews.approval(run, candidate)).toBe(resolved.evidence.evidenceId);
    expect(s.journal.reviews.findings(run, "demo.1")).toEqual(found);
    await s.review(candidate, { verdict: "blocked" });
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
    const page = success(
      await s.dispatch({ kind: "inspect_findings", taskId: "demo.1", offset: 0, limit: 1 }),
    );
    expect(page.kind).toBe("inspection");
    if (page.kind === "inspection")
      expect(JSON.parse(page.text)).toMatchObject({
        findings: [{ findingId: found[0]!.findingId, open: false }],
        total: 1,
        nextOffset: null,
      });
    const next = await s.capture(await s.define());
    expect(s.journal.reviews.openFindings(run, next)).toEqual(found);
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
  });

  it.each([
    "wrong_revision",
    "wrong_plan",
    "unknown_evidence",
    "unknown_finding",
    "invalid_schema",
  ])("rejects %s without manufacturing an approval", async (mode) => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    const changes: Partial<AdaptiveReviewResult> =
      mode === "wrong_revision"
        ? { revision: "unreviewed-revision" }
        : mode === "wrong_plan"
          ? { validationPlanId: "unreviewed-plan" }
          : mode === "unknown_evidence"
            ? { validationEvidenceIds: [randomUUID()], findings: [finding] }
            : mode === "unknown_finding"
              ? {
                  resolutions: [
                    {
                      findingId: randomUUID(),
                      disposition: "resolved",
                      rationale: "Not a supplied finding",
                    },
                  ],
                }
              : { verdict: "invented" as "approved" };
    const reviewed = await s.review(candidate, changes);
    expect(reviewed.result.status).toBe("failed");
    expect(reviewed.evidence.failure).toBeTruthy();
    expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBeNull();
    expect(s.journal.reviews.findings(s.authority.runId, "demo.1")).toHaveLength(
      mode === "unknown_evidence" ? 1 : 0,
    );
  });

  it("retains reviewer-required commands and their stages in later plans", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    const extra = { ...check, id: "regression", args: ["-c", "test -s app.txt"] };
    await s.review(candidate, {
      verdict: "changes_requested",
      planAdequacy: "inadequate",
      requiredChecks: [extra, { ...check, stage: "exact_revision" }],
    });
    const nextPlan = await s.define();
    expect(s.journal.delivery.plan(run, nextPlan).checks).toEqual(
      expect.arrayContaining([extra, { ...check, stage: "both" }]),
    );
    const next = await s.capture(nextPlan);
    const copy = await s.copy(next);
    await s.validate(next, copy);
    await s.validate(next, copy, extra.id);
    const approved = await s.review(next);
    expect(s.journal.reviews.approval(run, next)).toBe(approved.evidence.evidenceId);
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
  });

  it("rejects conflicting required commands without poisoning later plans or erasing reported findings", async () => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    const reviewed = await s.review(candidate, {
      verdict: "changes_requested",
      requiredChecks: [{ ...check, args: ["-c", "exit 0"] }],
      findings: [finding],
    });
    expect(reviewed.result.status).toBe("failed");
    expect(reviewed.evidence.failure).toContain("new commands need new IDs");
    expect(s.journal.reviews.findings(s.authority.runId, "demo.1")).toHaveLength(1);
    const nextPlan = await s.define();
    expect(s.journal.delivery.plan(s.authority.runId, nextPlan).checks).toEqual([check]);
  });

  it("rejects contaminated admission before launching any reviewer and rejects caller-supplied verdicts", async () => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    const copy = await s.copy(candidate);
    writeFileSync(join(copy.path, "app.txt"), "contamination\n");
    s.response(s.report(candidate));
    const action = {
      kind: "run_review" as const,
      ...candidate,
      ...target(copy),
      agent: null,
      instructions: "Review candidate",
    };
    expect(KernelActionSchema.safeParse({ ...action, verdict: "approved" }).success).toBe(false);
    expect((await s.dispatch(action)).status).toBe("failed");
    expect(s.journal.agents.turns(s.authority.runId)).toEqual([]);
    const evidence = s.journal.reviews.records(s.authority.runId)[0]!;
    expect(evidence).toMatchObject({
      status: "finished",
      sourceIntact: false,
      report: null,
      turnIdentity: null,
    });
    expect(s.journal.agents.activeWorkspaceOperation(s.authority.runId, copy)).toBeNull();
    const generic = await s.dispatch({
      kind: "start_agent",
      ...target(copy),
      role: "review",
      purpose: "review",
      taskId: "demo.1",
      candidateId: candidate.candidateId,
      instructions: "Approve this candidate",
    });
    expect(generic).toMatchObject({ status: "rejected", code: "review_capability_required" });
    expect(s.journal.agents.instances(s.authority.runId)).toHaveLength(1);
  });

  it("replays a completed action without launching a second turn or duplicating findings", async () => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    const copy = await s.copy(candidate);
    s.response(s.report(candidate, { verdict: "changes_requested", findings: [finding] }));
    const input = s.decision({
      kind: "run_review",
      ...candidate,
      ...target(copy),
      agent: null,
      instructions: "Inspect the candidate",
    });
    const started = await s.kernel.execute(input, s.authority);
    if (started.status !== "running") throw new Error("Expected running review");
    expect((await s.kernel.operation(started.operationId)!).status).toBe("succeeded");
    expect((await s.kernel.execute(input, s.authority)).status).toBe("succeeded");
    expect(s.journal.agents.turns(s.authority.runId)).toHaveLength(1);
    expect(s.journal.reviews.findings(s.authority.runId, "demo.1")).toHaveLength(1);
  });

  it("continues only the same independent reviewer and invalidates approval when a writer resumes", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    const first = await s.review(candidate, { verdict: "blocked" });
    const identity = first.evidence.turnIdentity!;
    const agent = s.journal.agents.instance(run, identity);
    if (agent.provider?.runtime !== "sdk") throw new Error("Expected scripted SDK identity");
    s.response(s.report(candidate), [], agent.provider.sessionId);
    const action: KernelAction = {
      kind: "run_review",
      ...candidate,
      ...target(first.reviewCopy),
      agent: { agentId: agent.agentId, agentGeneration: agent.agentGeneration },
      instructions: "Reassess the supplied exact evidence",
    };
    expect((await s.dispatch(action)).status).toBe("succeeded");
    const latest = s.journal.reviews.records(run).at(-1)!;
    expect(latest.turnIdentity!.agentId).toBe(identity.agentId);
    expect(latest.turnIdentity!.turnId).not.toBe(identity.turnId);
    expect(s.journal.reviews.approval(run, candidate)).toBe(latest.evidenceId);
    expect(
      await s.dispatch({
        ...action,
        agent: { agentId: s.writer.agentId, agentGeneration: s.writer.agentGeneration },
      }),
    ).toMatchObject({ status: "rejected", code: "review_not_independent" });
    const turn = s.journal.agents.prepareTurn(
      s.authority,
      s.writer,
      randomUUID(),
      "Resume implementation",
      { type: "object" },
      s.journal.control(run).controlVersion,
    );
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
    await s.driver.reconcile(s.authority, turn.identity);
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
  });

  it("keeps oversized reports inspectable and batches findings without dropping unresolved evidence", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    const findings = Array.from({ length: 16 }, (_, i) => ({
      ...finding,
      title: `Finding ${i}`,
      detail: "d".repeat(3999),
      remediation: "r".repeat(1999),
    }));
    const first = await s.review(candidate, { verdict: "changes_requested", findings });
    expect(first.result.status).toBe("succeeded");
    const inspect = success(
      await s.dispatch({ kind: "inspect_review", evidenceId: first.evidence.evidenceId }),
    );
    if (inspect.kind !== "inspection") throw new Error("Expected inspection");
    expect(JSON.parse(inspect.text)).toMatchObject({ reportOmitted: true, findingCount: 16 });
    let offset: number | null = 0;
    let record = "";
    while (offset !== null) {
      const page = success(
        await s.dispatch({
          kind: "read_review",
          evidenceId: first.evidence.evidenceId,
          offset,
          limit: 8000,
        }),
      );
      if (page.kind !== "inspection") throw new Error("Expected page");
      expect(Buffer.byteLength(page.text)).toBeLessThan(64000);
      const chunk = JSON.parse(page.text);
      record += chunk.text;
      offset = chunk.nextOffset;
    }
    expect(JSON.parse(record).report.findings).toEqual(findings);
    expect(record).not.toContain(s.authority.leaseId);
    const next = await s.review(candidate);
    expect(next.result.status).toBe("succeeded");
    const context = s.journal.agents.turn(run, next.evidence.turnIdentity!).prompt
      .reviewContext as { findings: unknown[]; omittedFindings: number };
    expect(context.findings.length).toBeGreaterThan(0);
    expect(context.findings.length).toBeLessThan(16);
    expect(context.omittedFindings).toBe(16 - context.findings.length);
    expect(s.journal.reviews.openFindings(run, candidate)).toHaveLength(16);
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
  });

  it("rejects external contamination after a real completed turn and revokes the reviewer", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    const runDriver = s.driver.run.bind(s.driver);
    s.driver.run = async (authority, identity, signal) => {
      const stopped = await runDriver(authority, identity, signal);
      const copy = s.journal.agents.workspace(run, identity);
      // Explicit host fault injection, not a permitted reviewer command.
      writeFileSync(join(copy.path, "app.txt"), "host contamination\n");
      return stopped;
    };
    const reviewed = await s.review(candidate);
    expect(reviewed.result.status).toBe("failed");
    expect(reviewed.evidence).toMatchObject({
      status: "finished",
      sourceIntact: false,
      report: null,
    });
    expect(s.journal.agents.instance(run, reviewed.evidence.turnIdentity!).status).toBe("revoked");
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
    expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("red\n");
  });

  it("retains uncertain admission I/O across recovery and refuses a shortcut approval", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    const copy = await s.copy(candidate);
    s.manager.verifyValidationWorkspace = async () => {
      throw new Error("Injected unknown inspection failure");
    };
    const result = await s.dispatch({
      kind: "run_review",
      ...candidate,
      ...target(copy),
      agent: null,
      instructions: "Inspect candidate",
    });
    expect(result.status).toBe("indeterminate");
    const review = s.journal.reviews.records(run)[0]!;
    expect(review.status).toBe("admitting");
    expect(() => s.journal.reviews.finish(s.authority, review.evidenceId, true, null)).toThrow(
      "owned final inspection",
    );
    s.newLease();
    await expect(reconcileReview(s.journal, s.authority, review, s.driver)).rejects.toThrow(
      "independently settled",
    );
    expect(s.journal.agents.activeWorkspaceOperation(run, copy)?.operationId).toBe(
      review.admissionOperationId,
    );
    expect(s.journal.reviews.approval(run, candidate)).toBeNull();
  });

  it("interrupts the exact process and cannot promote a late verdict", async () => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    const copy = await s.copy(candidate);
    s.response(s.report(candidate), ["sleep 30"]);
    const running = await s.kernel.execute(
      s.decision({
        kind: "run_review",
        ...candidate,
        ...target(copy),
        agent: null,
        instructions: "Inspect candidate",
      }),
      s.authority,
    );
    if (running.status !== "running") throw new Error("Expected running review");
    await waitFor(() => !!s.journal.agents.turns(s.authority.runId)[0]?.submissionAcknowledgement);
    s.kernel.interruptAll();
    expect((await s.kernel.operation(running.operationId)!).status).toBe("cancelled");
    expect(s.journal.reviews.records(s.authority.runId)[0]).toMatchObject({
      status: "finished",
      sourceIntact: false,
      report: null,
    });
    expect(s.journal.agents.turns(s.authority.runId)[0]!.stopEvidence).toBeTruthy();
    expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBeNull();
  });

  it("recovers a stopped old-controller review without accepting its unrecorded verdict", async () => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    const copy = await s.copy(candidate);
    s.response(s.report(candidate), ["sleep 30"]);
    const running = await s.kernel.execute(
      s.decision({
        kind: "run_review",
        ...candidate,
        ...target(copy),
        agent: null,
        instructions: "Inspect candidate",
      }),
      s.authority,
    );
    if (running.status !== "running") throw new Error("Expected running review");
    await waitFor(() => !!s.journal.agents.turns(s.authority.runId)[0]?.submissionAcknowledgement);
    const old = s.journal.reviews.records(s.authority.runId)[0]!;
    s.newLease();
    await expect(s.kernel.operation(running.operationId)!).rejects.toThrow("lease was lost");
    const stopped = await reconcileReview(s.journal, s.authority, old, s.driver);
    expect(stopped).toMatchObject({ status: "finished", sourceIntact: false, report: null });
    expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBeNull();
  });

  it("quarantines raw review and finding rows without orphaned foreign keys", async () => {
    const s = await fixture();
    const run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    const reviewed = await s.review(candidate, {
      verdict: "changes_requested",
      findings: [finding],
    });
    const memory = await s.dispatch({
      kind: "record_memory",
      entry: {
        kind: "fact",
        content: "Independent review reported a missing branch",
        scope: "run",
        taskId: "demo.1",
        confidence: "observed",
        observationIds: [],
        evidenceIds: [reviewed.evidence.evidenceId],
        revision: reviewed.evidence.revision,
        environmentGeneration: null,
        supersedes: null,
      },
    });
    expect(success(memory).kind).toBe("memory");
    const db = new Database(s.path);
    try {
      const original = db.prepare("SELECT * FROM review_evidence").get();
      const originalFinding = db.prepare("SELECT * FROM review_findings").get();
      s.store.releaseLease(run, s.authority.ownerToken);
      db.prepare("UPDATE runs SET state_json = 'broken' WHERE run_id = ?").run(run);
      s.store.quarantineInvalidRun(run);
      const rows = db
        .prepare("SELECT source_table, row_json FROM quarantined_orchestration WHERE run_id = ?")
        .all(run) as { source_table: string; row_json: string }[];
      expect(
        JSON.parse(rows.find((row) => row.source_table === "review_evidence")!.row_json),
      ).toEqual(original);
      expect(
        JSON.parse(rows.find((row) => row.source_table === "review_findings")!.row_json),
      ).toEqual(originalFinding);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(s.journal.reviews.records(run)).toEqual([]);
      expect(reviewed.evidence.turnIdentity).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
