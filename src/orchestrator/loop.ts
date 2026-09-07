import { setTimeout as delay } from "node:timers/promises";
import {
  OrchestratorDecisionSchema,
  type ControllerAuthority,
  type DecisionTicket,
  type ControlState,
} from "../domain/orchestration.js";
import { ActionKernel } from "../kernel/actions.js";
import { buildOrchestratorContext, type OrchestratorContext } from "./context.js";
import {
  DecisionSourceError,
  MAX_DECISION_SOURCE_ATTEMPTS,
  type DecisionExecution,
  type DecisionSourceOutcome,
  type DecisionSourceAttempt,
} from "../domain/decision-source.js";
import { redactSensitiveText } from "../util/redact.js";

/**
 * Implementations may retain a provider thread, but cannot execute delivery actions.
 * A resolved response or DecisionSourceError requires a settled request; an unknown
 * exception leaves dispatch indeterminate. Herdr readiness is not that acknowledgement.
 */
export interface DecisionSource {
  decide(
    input: { ticket: DecisionTicket; context: OrchestratorContext; attemptId: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Trusted runtime stop operation only; the journal derives the recovered outcome. */
  reconcile?(attempt: DecisionSourceAttempt): Promise<void>;
}

export class OrchestratorLoop {
  constructor(
    private readonly kernel: ActionKernel,
    private readonly source: DecisionSource,
    private readonly options: {
      pollMs?: number;
      onHealthCheck?: () => Promise<void>;
      beforeDecision?: (signal?: AbortSignal) => Promise<void>;
    } = {},
  ) {}

  async run(authority: ControllerAuthority, signal?: AbortSignal): Promise<ControlState["status"]> {
    const journal = this.kernel.journal;
    try {
      while (!signal?.aborted) {
        this.kernel.assertHealthy();
        journal.assertAuthority(authority);
        let control = journal.control(authority.runId);
        if (control.status !== "active") return control.status;
        const unsettled = journal.decisionSource.unsettled(authority.runId);
        if (unsettled) {
          const recovered = await this.reconcileSource(authority, unsettled);
          if (recovered) {
            if (recovered.kind === "failure")
              return this.unavailable(authority, recovered.detail, `coordinator_${recovered.code}`);
            continue;
          }
          return this.unavailable(
            authority,
            `Coordinator attempt ${unsettled.attemptId} has no confirmed settlement. Reconcile its exact runtime identity and stop state before retrying.`,
            "coordinator_indeterminate",
          );
        }
        const pending = journal.pendingDecision(authority.runId);
        const currentPending =
          pending &&
          pending.expectedControlVersion === control.controlVersion &&
          pending.policyDigest === control.policyDigest
            ? pending
            : null;
        let execution = currentPending
          ? journal.decisionSource.execution(authority.runId, currentPending.decisionId)
          : null;
        const actions = journal.actions(authority.runId);
        const latest = actions.at(-1);
        if (
          !execution &&
          latest?.result?.status === "succeeded" &&
          latest.result.result.kind === "wait"
        ) {
          await this.wait(
            authority,
            latest.result.result.afterCursor,
            latest.result.result.deadline,
            signal,
          );
          signal?.throwIfAborted();
          control = journal.control(authority.runId);
          if (control.status !== "active") return control.status;
        }
        if (!currentPending && control.decisionsUsed >= control.maxDecisions) {
          journal.setEscalation(
            authority,
            "The decision budget is exhausted. Inspect the recorded attempts and explicitly grant a new budget to continue.",
            "budget",
            [],
          );
          return "awaiting_user";
        }
        if (!execution) {
          // Rotation changes control facts, so do it before freezing context and
          // issuing the next ticket, never in the middle of a provider attempt.
          if (this.options.beforeDecision) await this.options.beforeDecision(signal);
          signal?.throwIfAborted();
          control = journal.control(authority.runId);
          if (control.status !== "active") return control.status;
          const context = buildOrchestratorContext(this.kernel, authority.runId);
          if (
            currentPending &&
            currentPending.observationCursor !== context.observationCursor &&
            control.decisionsUsed >= control.maxDecisions
          ) {
            return this.unavailable(
              authority,
              "The decision budget is exhausted and the unsubmitted ticket was superseded by new observations. Explicitly grant a new budget to continue.",
              "budget",
            );
          }
          const ticket = journal.beginDecision(
            authority,
            context.observationCursor,
            context.control.controlVersion,
          );
          execution = journal.decisionSource.prepare(authority, ticket, JSON.stringify(context));
        }
        const outcome = await this.obtainDecision(authority, execution, signal);
        signal?.throwIfAborted();
        if (outcome === null) continue; // Pause/settings change invalidated a waiting dispatch.
        if (outcome.kind === "failure" || outcome.kind === "indeterminate") {
          return this.unavailable(
            authority,
            outcome.kind === "indeterminate"
              ? `Coordinator stop state is unknown. Reconcile the recorded attempt before retrying. ${outcome.detail}`
              : `Coordinator unavailable (${outcome.code}); no model fallback was attempted. ${outcome.detail}`,
            outcome.kind === "indeterminate"
              ? "coordinator_indeterminate"
              : `coordinator_${outcome.code}`,
          );
        }
        if (outcome.kind === "invalid_output") {
          journal.rejectDecision(authority, execution.ticket.decisionId, outcome.detail);
          continue;
        }
        const result = await this.kernel.execute(outcome.decision, authority);
        const requested = outcome.decision.request.action;
        if (
          result.status === "running" &&
          (requested.kind === "complete_run" ||
            (requested.kind === "reconcile_tracker_operation" &&
              journal.tracker
                .operations(authority.runId)
                .some(
                  (record) =>
                    record.trackerOperationId === requested.trackerOperationId &&
                    record.kind === "complete",
                )))
        ) {
          // The model requested termination. Do not launch new reasoning while
          // its terminal inspection is proving that every request has stopped.
          const operation = this.kernel.operation(result.operationId);
          if (operation) {
            const monitor = new AbortController();
            const watchedSignal = signal
              ? AbortSignal.any([signal, monitor.signal])
              : monitor.signal;
            const watch = async () => {
              let nextHealth = Date.now() + 30_000;
              while (journal.control(authority.runId).status === "active") {
                this.kernel.assertHealthy();
                journal.assertAuthority(authority);
                if (Date.now() >= nextHealth) {
                  await this.options.onHealthCheck?.();
                  nextHealth = Date.now() + 30_000;
                }
                await delay(this.options.pollMs ?? 250, undefined, { signal: watchedSignal });
              }
            };
            try {
              await Promise.race([operation, watch()]);
            } finally {
              monitor.abort();
            }
          }
        }
      }
      return journal.control(authority.runId).status;
    } finally {
      // Cancellation is a request, not proof of stop. Persisted actions remain until settled/reconciled.
      // Do not query SQLite here: a failed store must not mask the original error or prevent interruption.
      this.kernel.interruptAll();
    }
  }

  private unavailable(
    authority: ControllerAuthority,
    detail: string,
    reason: string,
  ): ControlState["status"] {
    // Do not supersede an operator's concurrent pause/escalation with a source failure.
    const journal = this.kernel.journal;
    if (journal.control(authority.runId).status === "active")
      journal.setEscalation(authority, redactSensitiveText(detail, 7999), reason, []);
    this.kernel.interruptAll();
    return journal.control(authority.runId).status;
  }

  private async obtainDecision(
    authority: ControllerAuthority,
    initial: DecisionExecution,
    signal?: AbortSignal,
  ): Promise<DecisionSourceOutcome | null> {
    const sourceJournal = this.kernel.journal.decisionSource;
    let execution = initial;
    let nextHealth = Date.now() + 30_000;
    for (;;) {
      signal?.throwIfAborted();
      this.kernel.assertHealthy();
      this.kernel.journal.assertAuthority(authority);
      const control = this.kernel.journal.control(authority.runId);
      if (
        control.status !== "active" ||
        control.controlVersion !== execution.ticket.expectedControlVersion ||
        control.policyDigest !== execution.ticket.policyDigest
      )
        return null;
      const last = execution.attempts.at(-1);
      if (
        last?.outcome &&
        !(
          last.outcome.kind === "failure" &&
          last.outcome.code === "transient" &&
          execution.attempts.length < MAX_DECISION_SOURCE_ATTEMPTS
        )
      )
        return last.outcome;
      if (last?.retryNotBefore && Date.now() < Date.parse(last.retryNotBefore)) {
        if (Date.now() >= nextHealth) {
          await this.options.onHealthCheck?.();
          nextHealth = Date.now() + 30_000;
        }
        await delay(this.options.pollMs ?? 250, undefined, { signal });
        continue;
      }
      const attempt = sourceJournal.start(authority, execution.ticket.decisionId);
      let outcome: DecisionSourceOutcome;
      try {
        // This JSON was assembled by the kernel and digest-checked on every read, not supplied by the model.
        const context: OrchestratorContext = JSON.parse(execution.contextJson);
        const result = await this.callSource(
          authority,
          { ticket: execution.ticket, context, attemptId: attempt.attemptId },
          signal,
        );
        const decision = OrchestratorDecisionSchema.safeParse(result);
        outcome = !decision.success
          ? {
              kind: "invalid_output",
              detail: `Invalid decision schema: ${decision.error.issues[0]?.message ?? "invalid result"}`,
            }
          : decision.data.request.decisionId !== execution.ticket.decisionId
            ? {
                kind: "invalid_output",
                detail: "The model returned an identity other than the issued decision ticket",
              }
            : { kind: "decision", decision: decision.data };
        if (signal?.aborted)
          outcome = {
            kind: "invalid_output",
            detail: "The returned decision was cancelled before admission",
          };
      } catch (error) {
        outcome =
          error instanceof DecisionSourceError
            ? {
                kind: "failure",
                code:
                  error.code === "transient" && (error.retryAfterMs ?? 0) > 86_400_000
                    ? "configuration"
                    : error.code,
                detail: redactSensitiveText(
                  (error.code === "transient" && (error.retryAfterMs ?? 0) > 86_400_000
                    ? "The provider retry delay exceeds the 24-hour waiting bound; operator direction is required. "
                    : "") + error.message,
                  7999,
                ),
                retryAfterMs: (error.retryAfterMs ?? 0) > 86_400_000 ? null : error.retryAfterMs,
              }
            : {
                kind: "indeterminate",
                detail: redactSensitiveText(
                  error instanceof Error
                    ? error.message
                    : "Decision source failed without a confirmed settlement",
                  7999,
                ),
              };
      }
      // A persistence or lease failure is not a provider failure; leave its dispatch unreconciled.
      sourceJournal.finish(authority, attempt.attemptId, outcome);
      if (outcome.kind === "indeterminate") {
        const unsettled = sourceJournal.unsettled(authority.runId);
        if (unsettled) await this.reconcileSource(authority, unsettled);
      }
      signal?.throwIfAborted();
      execution = sourceJournal.execution(authority.runId, execution.ticket.decisionId)!;
    }
  }

  private async reconcileSource(
    authority: ControllerAuthority,
    attempt: DecisionSourceAttempt,
  ): Promise<DecisionSourceOutcome | null> {
    if (!this.source.reconcile || !attempt.turnIdentity) return null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.source.reconcile(attempt),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Coordinator reconciliation deadline exceeded")),
            8000,
          );
        }),
      ]);
      return this.kernel.journal.decisionSource.reconcileStoppedAttempt(
        authority,
        attempt.attemptId,
      ).outcome;
    } catch {
      // Unknown identity/process state remains owned. A late stop may be recorded,
      // but no callback can admit the old model response or restart it.
      this.kernel.journal.assertAuthority(authority);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callSource(
    authority: ControllerAuthority,
    input: Parameters<DecisionSource["decide"]>[0],
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const request = new AbortController();
    const monitor = new AbortController();
    const abortRequest = () => request.abort(signal?.reason);
    signal?.addEventListener("abort", abortRequest, { once: true });
    let rejectInterrupted!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectInterrupted = reject;
    });
    const onInterrupted = () =>
      rejectInterrupted(
        new Error("Coordinator request interrupted without a confirmed settlement"),
      );
    request.signal.addEventListener("abort", onInterrupted, { once: true });
    const health = async () => {
      let nextHealth = Date.now() + 30_000;
      for (;;) {
        await delay(this.options.pollMs ?? 250, undefined, { signal: monitor.signal });
        this.kernel.assertHealthy();
        this.kernel.journal.assertAuthority(authority);
        const control = this.kernel.journal.control(authority.runId);
        if (
          control.status !== "active" ||
          control.controlVersion !== input.ticket.expectedControlVersion ||
          control.policyDigest !== input.ticket.policyDigest
        )
          throw new Error("Coordinator request authority changed before settlement");
        if (Date.now() >= nextHealth) {
          await this.options.onHealthCheck?.();
          nextHealth = Date.now() + 30_000;
        }
      }
    };
    try {
      // Monitor independently: a native runtime which ignores cancellation must not hold operator control hostage.
      // A late response has no callback that can admit an action or overwrite the recorded uncertainty.
      return await Promise.race([
        Promise.resolve().then(() => {
          request.signal.throwIfAborted();
          this.kernel.assertHealthy();
          this.kernel.journal.assertAuthority(authority);
          const control = this.kernel.journal.control(authority.runId);
          if (
            control.status !== "active" ||
            control.controlVersion !== input.ticket.expectedControlVersion ||
            control.policyDigest !== input.ticket.policyDigest
          )
            throw new Error("Coordinator request authority changed before dispatch");
          return this.source.decide(input, request.signal);
        }),
        health(),
        interrupted,
      ]);
    } catch (error) {
      request.abort();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortRequest);
      request.signal.removeEventListener("abort", onInterrupted);
      monitor.abort();
    }
  }

  private async wait(
    authority: ControllerAuthority,
    afterCursor: number,
    deadline: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    let nextHealth = Date.now() + 30_000;
    while (!signal?.aborted) {
      this.kernel.assertHealthy();
      this.kernel.journal.assertAuthority(authority);
      if (this.kernel.journal.control(authority.runId).status !== "active") return;
      if (this.kernel.journal.observations(authority.runId, afterCursor, 1, true).length) return;
      if (deadline && Date.now() >= Date.parse(deadline)) return;
      if (Date.now() >= nextHealth) {
        await this.options.onHealthCheck?.();
        nextHealth = Date.now() + 30_000;
      }
      await delay(this.options.pollMs ?? 250, undefined, { signal });
    }
  }
}
