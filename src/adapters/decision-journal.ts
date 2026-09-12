import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  DecisionSourceAttemptSchema,
  DecisionSourceOutcomeSchema,
  MAX_DECISION_SOURCE_ATTEMPTS,
  decisionSourceFailureForProviderFailure,
  type DecisionExecution,
  type DecisionSourceAttempt,
  type DecisionSourceOutcome,
} from "../domain/decision-source.js";
import {
  OrchestratorDecisionSchema,
  sameTurn,
  type TurnIdentity,
  type ControllerAuthority,
  type ControlState,
  type DecisionTicket,
  type ObservationInput,
} from "../domain/orchestration.js";
import type { TurnRecord } from "../domain/agents.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";

export const DECISION_SOURCE_TABLES = ["decision_executions", "decision_source_attempts"] as const;

export function createDecisionSourceSchema(db: Database.Database): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS decisions_run_identity ON decisions(run_id, decision_id);
    CREATE TABLE IF NOT EXISTS decision_executions (
      decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
      ticket_json TEXT NOT NULL CHECK(json_valid(ticket_json)),
      context_json TEXT NOT NULL CHECK(json_valid(context_json)),
      input_digest TEXT NOT NULL,
      FOREIGN KEY(run_id, decision_id) REFERENCES decisions(run_id, decision_id) ON DELETE CASCADE,
      CHECK(length(CAST(context_json AS BLOB)) <= 65536)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS decision_source_attempts (
      attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
      decision_id TEXT NOT NULL REFERENCES decision_executions(decision_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND ${MAX_DECISION_SOURCE_ATTEMPTS}),
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      FOREIGN KEY(run_id, decision_id) REFERENCES decisions(run_id, decision_id) ON DELETE CASCADE,
      UNIQUE(decision_id, ordinal),
      CHECK(json_extract(record_json, '$.attemptId') = attempt_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_unsettled_decision_source ON decision_source_attempts(run_id)
      WHERE json_extract(record_json, '$.outcome') IS NULL OR json_extract(record_json, '$.outcome.kind') = 'indeterminate';
    CREATE UNIQUE INDEX IF NOT EXISTS one_decision_source_turn ON decision_source_attempts(json_extract(record_json, '$.turnIdentity.turnId'))
      WHERE json_extract(record_json, '$.turnIdentity') IS NOT NULL;
  `);
}

type Access = {
  transaction<T>(authority: ControllerAuthority, body: () => T): T;
  control(runId: string): ControlState;
  pending(runId: string): DecisionTicket | null;
  observe(authority: ControllerAuthority, observation: ObservationInput): unknown;
  turn(runId: string, identity: TurnIdentity): TurnRecord;
};
type ExecutionRow = { ticket_json: string; context_json: string; input_digest: string };

/** Requests have no delivery effects; only the action kernel may execute their output. */
export class DecisionJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly access: Access,
  ) {}

  execution(runId: string, decisionId: string): DecisionExecution | null {
    const row = this.db
      .prepare("SELECT * FROM decision_executions WHERE run_id = ? AND decision_id = ?")
      .get(runId, decisionId) as ExecutionRow | undefined;
    if (!row) return null;
    const ticket: DecisionTicket = JSON.parse(row.ticket_json);
    if (digestJson({ ticket, contextJson: row.context_json }) !== row.input_digest)
      throw new Error("Decision input digest mismatch");
    const rows = this.db
      .prepare(
        "SELECT record_json FROM decision_source_attempts WHERE run_id = ? AND decision_id = ? ORDER BY ordinal",
      )
      .all(runId, decisionId) as { record_json: string }[];
    const attempts = rows.map((item) =>
      DecisionSourceAttemptSchema.parse(JSON.parse(item.record_json)),
    );
    return { runId, ticket, contextJson: row.context_json, attempts };
  }

  /** Freeze the exact first input so new observations or a restart cannot refill an attempt budget. */
  prepare(
    authority: ControllerAuthority,
    ticket: DecisionTicket,
    contextJson: string,
  ): DecisionExecution {
    return this.access.transaction(authority, () => {
      this.assertCurrent(authority, ticket);
      const existing = this.execution(authority.runId, ticket.decisionId);
      if (existing) return existing;
      if (Buffer.byteLength(contextJson) > 65536)
        throw new Error("Decision context exceeds 64 KiB");
      const context = JSON.parse(contextJson);
      if (
        context.control?.runId !== authority.runId ||
        context.observationCursor !== ticket.observationCursor ||
        typeof context.observationWindow?.hasMore !== "boolean" ||
        context.observationWindow?.afterCursor !==
          this.access.control(authority.runId).observationCursor ||
        context.control?.controlVersion !== ticket.expectedControlVersion ||
        context.control?.policyDigest !== ticket.policyDigest
      )
        throw new Error("Decision context does not match its ticket");
      this.db
        .prepare(
          "INSERT INTO decision_executions(decision_id, run_id, ticket_json, context_json, input_digest) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          ticket.decisionId,
          authority.runId,
          JSON.stringify(ticket),
          contextJson,
          digestJson({ ticket, contextJson }),
        );
      return this.execution(authority.runId, ticket.decisionId)!;
    });
  }

  unsettled(runId: string): DecisionSourceAttempt | null {
    const row = this.db
      .prepare(
        `SELECT record_json FROM decision_source_attempts WHERE run_id = ? AND
        (json_extract(record_json, '$.outcome') IS NULL OR json_extract(record_json, '$.outcome.kind') = 'indeterminate')`,
      )
      .get(runId) as { record_json: string } | undefined;
    return row ? DecisionSourceAttemptSchema.parse(JSON.parse(row.record_json)) : null;
  }

  start(authority: ControllerAuthority, decisionId: string): DecisionSourceAttempt {
    return this.access.transaction(authority, () => {
      const execution = this.execution(authority.runId, decisionId);
      if (!execution) throw new Error("Decision input was not recorded before dispatch");
      this.assertCurrent(authority, execution.ticket);
      if (this.unsettled(authority.runId))
        throw new Error("Decision source stop state needs reconciliation");
      const previous = execution.attempts.at(-1);
      if (
        execution.attempts.length >= MAX_DECISION_SOURCE_ATTEMPTS ||
        (previous &&
          (previous.outcome?.kind !== "failure" || previous.outcome.code !== "transient"))
      )
        throw new Error("Decision source is not retryable");
      if (previous?.retryNotBefore && Date.now() < Date.parse(previous.retryNotBefore))
        throw new Error("Decision source retry is not due");
      const attempt: DecisionSourceAttempt = {
        attemptId: randomUUID(),
        controllerLeaseId: authority.leaseId,
        turnIdentity: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outcome: null,
        retryNotBefore: null,
      };
      this.db
        .prepare(
          "INSERT INTO decision_source_attempts(attempt_id, run_id, decision_id, ordinal, record_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          attempt.attemptId,
          authority.runId,
          decisionId,
          execution.attempts.length + 1,
          JSON.stringify(attempt),
        );
      this.observe(
        authority,
        attempt,
        "started",
        `Decision ${decisionId}, transport attempt ${execution.attempts.length + 1}`,
      );
      return attempt;
    });
  }

  finish(
    authority: ControllerAuthority,
    attemptId: string,
    input: DecisionSourceOutcome,
  ): DecisionSourceAttempt {
    return this.access.transaction(authority, () => {
      const row = this.db
        .prepare(
          "SELECT record_json, ordinal, decision_id FROM decision_source_attempts WHERE run_id = ? AND attempt_id = ?",
        )
        .get(authority.runId, attemptId) as
        { record_json: string; ordinal: number; decision_id: string } | undefined;
      if (!row) throw new Error("Unknown decision source attempt");
      const attempt = DecisionSourceAttemptSchema.parse(JSON.parse(row.record_json));
      if (attempt.controllerLeaseId !== authority.leaseId || attempt.outcome !== null)
        throw new Error(
          "Decision source attempt is settled or belongs to another controller lease",
        );
      const outcome = DecisionSourceOutcomeSchema.parse(input);
      if (attempt.turnIdentity && outcome.kind !== "indeterminate") {
        const turn = this.linkedTurn(authority.runId, attempt);
        if (!turn.stopEvidence) throw new Error("Decision source turn has no confirmed stop");
        if (
          outcome.kind === "decision" &&
          (!turn.resultEligible || digestJson(turn.result) !== digestJson(outcome.decision))
        )
          throw new Error("Decision source must return its eligible persisted turn result");
      }
      if (outcome.kind === "decision" && outcome.decision.request.decisionId !== row.decision_id)
        throw new Error("Decision source result belongs to another ticket");
      if (outcome.kind !== "decision") outcome.detail = redactSensitiveText(outcome.detail, 7999);
      attempt.outcome = outcome;
      attempt.finishedAt = new Date().toISOString();
      if (
        outcome.kind === "failure" &&
        outcome.code === "transient" &&
        row.ordinal < MAX_DECISION_SOURCE_ATTEMPTS
      ) {
        // The automatic backoff is capped, but a longer provider delay is a durable deadline, not permission to retry early.
        const backoff = Math.min(30_000, 2_000 * 2 ** (row.ordinal - 1));
        attempt.retryNotBefore = new Date(
          Date.now() + Math.max(backoff, outcome.retryAfterMs ?? 0),
        ).toISOString();
      }
      this.db
        .prepare("UPDATE decision_source_attempts SET record_json = ? WHERE attempt_id = ?")
        .run(JSON.stringify(attempt), attemptId);
      this.observe(
        authority,
        attempt,
        outcome.kind,
        outcome.kind === "decision"
          ? "A structured decision is available for kernel admission"
          : outcome.detail,
      );
      return attempt;
    });
  }

  /** Bind before dispatch; a provider/model cannot choose or replace this identity. */
  bindTurn(
    authority: ControllerAuthority,
    attemptId: string,
    identity: TurnIdentity,
  ): DecisionSourceAttempt {
    return this.access.transaction(authority, () => {
      const row = this.attemptRow(authority.runId, attemptId);
      const attempt = DecisionSourceAttemptSchema.parse(JSON.parse(row.record_json));
      if (attempt.controllerLeaseId !== authority.leaseId || attempt.outcome !== null)
        throw new Error("Cannot bind a settled or old-controller decision attempt");
      if (attempt.turnIdentity) {
        if (!sameTurn(attempt.turnIdentity, identity))
          throw new Error("Decision attempt already belongs to another turn");
        return attempt;
      }
      const turn = this.access.turn(authority.runId, identity);
      if (
        turn.status !== "prepared" ||
        turn.launch ||
        identity.operationId !== attemptId ||
        turn.prompt.assignment.purpose !== "coordination"
      )
        throw new Error("Decision attempt requires its own prepared coordination turn");
      attempt.turnIdentity = turn.identity;
      this.save(attempt);
      this.observe(
        authority,
        attempt,
        "turn_bound",
        `Decision attempt bound to turn ${identity.turnId}`,
      );
      return attempt;
    });
  }

  /** Recovery derives the outcome from journaled stop/result evidence, never a runtime's boolean claim. */
  reconcileStoppedAttempt(
    authority: ControllerAuthority,
    attemptId: string,
  ): DecisionSourceAttempt {
    return this.access.transaction(authority, () => {
      const row = this.attemptRow(authority.runId, attemptId);
      const attempt = DecisionSourceAttemptSchema.parse(JSON.parse(row.record_json));
      if (attempt.outcome && attempt.outcome.kind !== "indeterminate") return attempt;
      const turn = this.linkedTurn(authority.runId, attempt);
      if (!turn.stopEvidence) throw new Error("Decision source turn has no confirmed stop");
      const decision = OrchestratorDecisionSchema.safeParse(turn.result);
      attempt.outcome = turn.essentialFailure
        ? decisionSourceFailureForProviderFailure(turn.essentialFailure)
        : turn.status === "cancelled"
          ? {
              kind: "invalid_output",
              detail:
                "The exact coordinator turn was stopped without admitting its output; choose again from current context",
            }
          : turn.status === "completed" && turn.resultEligible
            ? decision.success && decision.data.request.decisionId === row.decision_id
              ? { kind: "decision", decision: decision.data }
              : {
                  kind: "invalid_output",
                  detail: "The persisted coordinator result is not a decision for this ticket",
                }
            : {
                kind: "failure",
                code: "runtime",
                detail:
                  "Coordinator turn stopped without an eligible result; inspect its recorded diagnostics",
                retryAfterMs: null,
              };
      attempt.finishedAt = new Date().toISOString();
      attempt.retryNotBefore = null;
      this.save(attempt);
      this.observe(
        authority,
        attempt,
        "reconciled",
        `Recovered ${attempt.outcome.kind} from exact turn ${turn.identity.turnId}`,
      );
      return attempt;
    });
  }

  private attemptRow(
    runId: string,
    attemptId: string,
  ): { record_json: string; decision_id: string } {
    const row = this.db
      .prepare(
        "SELECT record_json, decision_id FROM decision_source_attempts WHERE run_id = ? AND attempt_id = ?",
      )
      .get(runId, attemptId) as { record_json: string; decision_id: string } | undefined;
    if (!row) throw new Error("Unknown decision source attempt");
    return row;
  }

  private linkedTurn(runId: string, attempt: DecisionSourceAttempt): TurnRecord {
    if (!attempt.turnIdentity) throw new Error("Decision attempt has no durable turn identity");
    const turn = this.access.turn(runId, attempt.turnIdentity);
    if (
      turn.identity.operationId !== attempt.attemptId ||
      turn.prompt.assignment.purpose !== "coordination"
    )
      throw new Error("Decision attempt turn identity is inconsistent");
    return turn;
  }

  private save(attempt: DecisionSourceAttempt): void {
    this.db
      .prepare("UPDATE decision_source_attempts SET record_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(DecisionSourceAttemptSchema.parse(attempt)), attempt.attemptId);
  }

  private assertCurrent(authority: ControllerAuthority, ticket: DecisionTicket): void {
    const pending = this.access.pending(authority.runId);
    const control = this.access.control(authority.runId);
    if (
      !pending ||
      digestJson(pending) !== digestJson(ticket) ||
      control.status !== "active" ||
      control.controlVersion !== ticket.expectedControlVersion ||
      control.policyDigest !== ticket.policyDigest
    )
      throw new Error("Decision source dispatch is stale");
  }

  private observe(
    authority: ControllerAuthority,
    attempt: DecisionSourceAttempt,
    kind: string,
    summary: string,
  ): void {
    this.access.observe(authority, {
      source: "kernel",
      sourceEventId: `decision-source:${attempt.attemptId}:${kind}`,
      kind: `orchestrator.source_${kind}`,
      summary: redactSensitiveText(summary, 7999),
      artifactIds: [],
      identity: null,
      wakesOrchestrator: false,
    });
  }
}
