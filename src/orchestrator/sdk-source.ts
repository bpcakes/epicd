import { z } from "zod";
import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import type { ControlledAgentDriver } from "../kernel/agents.js";
import type { AgentIdentity } from "../domain/agents.js";
import { DecisionSourceError, type DecisionSourceAttempt } from "../domain/decision-source.js";
import {
  ActionRequestSchema,
  KernelActionSchema,
  OrchestratorDecisionSchema,
  type ControllerAuthority,
} from "../domain/orchestration.js";
import { digestJson } from "../domain/repository-policy.js";
import { ADAPTIVE_ORCHESTRATOR_MODEL, agentOutputSchema } from "../domain/types.js";
import type { DecisionSource } from "./loop.js";
import { buildDecisionPrompt } from "./prompt.js";

// Structured Outputs supports nested anyOf, not Zod's oneOf representation.
// Every action has a distinct required literal kind, so this union is equivalent;
// kernel admission still uses the original discriminated schema and refinements.
export const DECISION_OUTPUT_SCHEMA = agentOutputSchema(
  OrchestratorDecisionSchema.extend({
    request: ActionRequestSchema.extend({ action: z.union(KernelActionSchema.options) }),
  }),
);

/** A controlled agent emits requests; only the kernel executes delivery capabilities. */
export class ControlledDecisionSource implements DecisionSource {
  constructor(
    private readonly journal: OrchestrationJournal,
    private readonly authority: ControllerAuthority,
    private readonly agent: AgentIdentity,
    private readonly runtime: ControlledAgentDriver,
  ) {}

  async decide(
    input: Parameters<DecisionSource["decide"]>[0],
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.journal.assertAuthority(this.authority);
    const execution = this.journal.decisionSource.execution(
      this.authority.runId,
      input.ticket.decisionId,
    );
    const attempt = execution?.attempts.at(-1);
    if (
      !execution ||
      !attempt ||
      attempt.attemptId !== input.attemptId ||
      attempt.outcome ||
      attempt.controllerLeaseId !== this.authority.leaseId ||
      digestJson(execution.ticket) !== digestJson(input.ticket) ||
      digestJson(JSON.parse(execution.contextJson)) !== digestJson(input.context)
    )
      throw new DecisionSourceError(
        "configuration",
        "Decision input is not the current persisted transport attempt",
      );
    if (attempt.turnIdentity)
      throw new Error("Reconcile the bound decision turn instead of redispatching it");
    const instance = this.journal.agents.instance(this.authority.runId, this.agent);
    if (
      instance.role !== "orchestrator" ||
      instance.contract.runtime !== this.runtime.kind ||
      instance.contract.effective.model !== ADAPTIVE_ORCHESTRATOR_MODEL
    )
      throw new DecisionSourceError(
        "configuration",
        "Coordinator requires its pinned Astra runtime assignment; no model fallback is allowed",
      );
    const turn = this.journal.agents.prepareTurn(
      this.authority,
      this.agent,
      input.attemptId,
      buildDecisionPrompt(input.ticket, input.context),
      DECISION_OUTPUT_SCHEMA,
      input.ticket.expectedControlVersion,
    );
    this.journal.decisionSource.bindTurn(this.authority, input.attemptId, turn.identity);
    const stopped = await this.runtime.run(this.authority, turn.identity, signal);
    if (!stopped.stopEvidence) throw new Error("Coordinator launcher stop is unconfirmed");
    if (stopped.status === "cancelled") return null; // Settled but deliberately not an admissible decision.
    if (stopped.status !== "completed" || !stopped.resultEligible)
      throw new DecisionSourceError(
        "runtime",
        `Coordinator turn ${turn.identity.turnId} stopped without an eligible result; inspect its recorded diagnostics`,
      );
    return stopped.result;
  }

  async reconcile(attempt: DecisionSourceAttempt): Promise<void> {
    if (!attempt.turnIdentity)
      throw new Error("Coordinator attempt has no bound launch to reconcile");
    await this.runtime.reconcile(this.authority, attempt.turnIdentity);
  }
}
