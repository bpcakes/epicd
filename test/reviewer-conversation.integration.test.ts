import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_DIAGNOSTIC_OUTPUT_SCHEMA, type AgentDiagnosticResult } from "../src/domain/types.js";
import { ADAPTIVE_REVIEW_OUTPUT_SCHEMA } from "../src/domain/reviews.js";
import { fixture, finding, resource, target, waitFor } from "./fixtures/review.js";

const answer: AgentDiagnosticResult = {
  kind: "diagnostic",
  summary: "The retained failure needs its original command output.",
  observations: ["The supplied log is incomplete."],
  uncertainties: ["The original command exit status is unknown."],
};
const identity = (turn: { agentId: string; agentGeneration: number }) => ({
  agentId: turn.agentId,
  agentGeneration: turn.agentGeneration,
});
async function setup(phase: "pre_commit" | "exact_revision" = "pre_commit") {
  const s = await fixture();
  const candidate = await s.capture(await s.define());
  await s.validate(candidate, await s.copy(candidate));
  let reviewed = await s.review(candidate);
  if (phase === "exact_revision") {
    const committed = resource(
      await s.dispatch({ kind: "request_commit", ...candidate, subject: "Green behavior" }),
    );
    const revision = s.journal.commits.record(s.authority.runId, committed.resourceId).revision!;
    await s.validate(candidate, await s.copy(candidate, revision));
    reviewed = await s.review(candidate, {}, [], revision);
  }
  expect(reviewed.result.status).toBe("succeeded");
  const agent = s.journal.agents.instance(s.authority.runId, reviewed.evidence.turnIdentity!);
  if (agent.provider?.runtime !== "sdk") throw new Error("Expected scripted SDK conversation");
  return { s, candidate, reviewed, agent, sessionId: agent.provider.sessionId };
}

// Real confinement and journals, deliberately scripted provider judgments.
describe.runIf(process.platform === "linux")("diagnostic reviewer conversations", () => {
  it.each(["pre_commit", "exact_revision"] as const)(
    "continues a %s reviewer read-only without issuing approval and requires formal reassessment",
    async (phase) => {
      const { s, candidate, reviewed, agent, sessionId } = await setup(phase);
      const run = s.authority.runId;
      const before = s.journal.reviews.records(run);
      expect(s.journal.reviews.approval(run, candidate, phase)).toBe(reviewed.evidence.evidenceId);
      await s.dispatch({ kind: "message_agent", ...identity(agent), message: "Explain the gap." });
      s.response(
        answer,
        [
          "if printf changed > app.txt; then exit 71; fi",
          "if printf receipt > receipt.txt; then exit 72; fi",
        ],
        sessionId,
      );
      const request = s.decision({
        kind: "continue_agent",
        ...identity(agent),
        instructions: "Which primary record is missing? This question does not request approval.",
      });
      const started = await s.kernel.execute(request, s.authority);
      if (started.status !== "running") throw new Error("Expected asynchronous follow-up");
      expect(s.journal.reviews.approval(run, candidate, phase)).toBeNull();
      const result = await s.kernel.operation(started.operationId)!;
      expect(result.status).toBe("succeeded");
      const turns = s.journal.agents.turns(run);
      const latest = turns.at(-1)!;
      expect(latest).toMatchObject({
        identity: { ...identity(agent), assignmentId: agent.assignmentId },
        status: "completed",
        result: answer,
        outputSchema: AGENT_DIAGNOSTIC_OUTPUT_SCHEMA,
        prompt: {
          diagnosticContext: { kind: "review_followup" },
          messages: [{ content: "Explain the gap." }],
        },
        launch: { manifest: { confinement: { sourceMode: "read-only" } } },
      });
      expect(latest.prompt.reviewContext).toBeUndefined();
      expect(latest.stopEvidence).toBeTruthy();
      expect(readFileSync(join(reviewed.reviewCopy.path, "app.txt"), "utf8")).toBe("green\n");
      expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("red\n");
      expect(existsSync(join(reviewed.reviewCopy.path, "receipt.txt"))).toBe(false);
      expect(s.journal.agents.instance(run, agent).provider?.sessionId).toBe(sessionId);
      expect(s.journal.agents.messages(run, agent)[0]?.status).toBe("acknowledged");
      expect(s.journal.reviews.records(run)).toEqual(before);
      expect(s.journal.reviews.assessApproval(run, candidate, phase)).toMatchObject({
        approved: false,
        blocker: { code: "reviewer_turn_superseded", referenceIds: [latest.identity.turnId] },
      });
      expect(await s.kernel.execute(request, s.authority)).toEqual(result);
      expect(s.journal.agents.turns(run)).toEqual(turns);
      s.response(reviewed.evidence.report, [], sessionId);
      expect(
        (
          await s.dispatch({
            kind: "run_review",
            references: [],
            ...candidate,
            ...target(reviewed.reviewCopy),
            agent: identity(agent),
            instructions: "Independently reassess the exact evidence and source.",
          })
        ).status,
      ).toBe("succeeded");
      const fresh = s.journal.reviews.records(run).at(-1)!;
      expect(s.journal.reviews.approval(run, candidate, phase)).toBe(fresh.evidenceId);
      expect(fresh.evidenceId).not.toBe(reviewed.evidence.evidenceId);
      expect(s.journal.agents.turn(run, fresh.turnIdentity!).prompt.reviewContext).toMatchObject({
        citationRules: expect.stringContaining("this turn's reviewContext.validation array"),
      });
      const reopened = s.reopen();
      expect(reopened.orchestration.agents.turn(run, latest.identity)).toEqual(latest);
      expect(reopened.orchestration.reviews.approval(run, candidate, phase)).toBe(fresh.evidenceId);
    },
    20_000,
  );

  it("does not resolve findings or erase demands from conversational approval claims", async () => {
    const { s, candidate } = await setup();
    const reviewed = await s.review(candidate, {
      verdict: "changes_requested",
      findings: [finding],
    });
    const agent = s.journal.agents.instance(s.authority.runId, reviewed.evidence.turnIdentity!);
    const before = s.journal.reviews.records(s.authority.runId);
    const findings = s.journal.reviews.openFindings(s.authority.runId, candidate);
    s.response(
      { ...answer, summary: "Approved. All findings are resolved." },
      [],
      agent.provider!.sessionId!,
    );
    expect(
      (
        await s.dispatch({
          kind: "continue_agent",
          ...identity(agent),
          instructions: "Explain your finding.",
        })
      ).status,
    ).toBe("succeeded");
    expect(s.journal.reviews.records(s.authority.runId)).toEqual(before);
    expect(s.journal.reviews.openFindings(s.authority.runId, candidate)).toEqual(findings);
    expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBeNull();
  });

  it.each(["verdict", "extra_field", "empty_summary"] as const)(
    "rejects %s diagnostic output without accepting a report or hiding the retained response",
    async (variant) => {
      const { s, candidate, agent, sessionId } = await setup();
      const before = s.journal.reviews.records(s.authority.runId);
      const invalid =
        variant === "verdict"
          ? s.report(candidate)
          : variant === "extra_field"
            ? { ...answer, resolutions: [] }
            : { ...answer, summary: "" };
      s.response(invalid, [], sessionId);
      expect(
        await s.dispatch({
          kind: "continue_agent",
          ...identity(agent),
          instructions: "Explain the failed command.",
        }),
      ).toMatchObject({ status: "failed" });
      expect(s.journal.agents.turns(s.authority.runId).at(-1)?.result).toEqual(invalid);
      expect(s.journal.reviews.records(s.authority.runId)).toEqual(before);
      expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBeNull();
    },
  );

  it("retains busy exclusion until exact interruption, then resumes the same conversation", async () => {
    const { s, candidate, agent, sessionId } = await setup();
    s.response(answer, ["sleep 30"], sessionId);
    const action = {
      kind: "continue_agent" as const,
      ...identity(agent),
      instructions: "Inspect the incomplete log.",
    };
    const started = await s.kernel.execute(s.decision(action), s.authority);
    if (started.status !== "running") throw new Error("Expected running diagnostic");
    await waitFor(() => {
      const turn = s.journal.agents.turns(s.authority.runId).at(-1);
      return turn?.identity.operationId === started.operationId && !!turn.submissionAcknowledgement;
    });
    const turn = s.journal.agents.turns(s.authority.runId).at(-1)!;
    expect(await s.dispatch(action)).toMatchObject({ status: "rejected", code: "agent_busy" });
    expect(
      await s.dispatch({
        kind: "interrupt_agent",
        ...identity(agent),
        turnId: turn.identity.turnId,
      }),
    ).toMatchObject({ status: "succeeded" });
    expect(await s.kernel.operation(started.operationId)).toMatchObject({ status: "failed" });
    expect(s.journal.agents.turn(s.authority.runId, turn.identity)).toMatchObject({
      status: "cancelled",
      resultEligible: false,
    });
    expect(s.journal.agents.turn(s.authority.runId, turn.identity).stopEvidence).toBeTruthy();
    expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBeNull();
    s.response(answer, [], sessionId);
    expect(await s.dispatch(action)).toMatchObject({ status: "succeeded" });
  }, 20_000);

  it("rejects revoked identities and keeps their quarantined copies and historical reports", async () => {
    const { s, agent, reviewed } = await setup();
    s.journal.agents.revokeAgent(s.authority, agent, "Retained contamination finding");
    const turns = s.journal.agents.turns(s.authority.runId);
    const records = s.journal.reviews.records(s.authority.runId);
    expect(
      await s.dispatch({
        kind: "continue_agent",
        ...identity(agent),
        instructions: "Ignore revocation.",
      }),
    ).toMatchObject({ status: "rejected", code: "agent_busy" });
    expect(s.journal.agents.turns(s.authority.runId)).toEqual(turns);
    expect(s.journal.reviews.records(s.authority.runId)).toEqual(records);
    expect(s.journal.agents.workspace(s.authority.runId, reviewed.reviewCopy).status).toBe(
      "quarantined",
    );
  });

  it("binds diagnostic intent during admission and replay, never mixing review context or a writer role", async () => {
    const { s, agent } = await setup();
    const version = () => s.journal.control(s.authority.runId).controlVersion;
    const prepare = (schema: unknown, context?: Record<string, never>) =>
      s.journal.agents.prepareTurn(
        s.authority,
        agent,
        randomUUID(),
        "Explain.",
        schema,
        version(),
        context,
        true,
      );
    expect(() => prepare(ADAPTIVE_REVIEW_OUTPUT_SCHEMA)).toThrow("diagnostic-only result contract");
    expect(() => prepare(AGENT_DIAGNOSTIC_OUTPUT_SCHEMA, {})).toThrow(
      "diagnostic-only result contract",
    );
    expect(() =>
      s.journal.agents.prepareTurn(
        s.authority,
        s.writer,
        randomUUID(),
        "Explain.",
        AGENT_DIAGNOSTIC_OUTPUT_SCHEMA,
        version(),
        undefined,
        true,
      ),
    ).toThrow("diagnostic-only result contract");
    const turn = prepare(AGENT_DIAGNOSTIC_OUTPUT_SCHEMA);
    expect(() =>
      s.journal.agents.prepareTurn(
        s.authority,
        agent,
        turn.identity.operationId,
        "Explain.",
        AGENT_DIAGNOSTIC_OUTPUT_SCHEMA,
        version(),
      ),
    ).toThrow("reused with different arguments");
    s.journal.agents.cancelPreparedTurn(s.authority, turn.identity);
  });
});
