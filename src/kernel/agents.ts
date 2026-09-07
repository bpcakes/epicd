import type { ActionKernel, ActionContext } from "./actions.js";
import { OperationFailed, CapabilityRejected } from "./guards.js";
import type { AgentIdentity, TurnRecord } from "../domain/agents.js";
import type { ControllerAuthority, TurnIdentity } from "../domain/orchestration.js";
import {
  IMPLEMENTATION_OUTPUT_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  type AgentRole,
  type AgentSessionContract,
  type RuntimeKind,
} from "../domain/types.js";

export interface ControlledAgentDriver {
  readonly kind: RuntimeKind;
  run(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    signal?: AbortSignal,
  ): Promise<TurnRecord>;
  reconcile(authority: ControllerAuthority, identity: TurnIdentity): Promise<TurnRecord>;
}

/** The model chooses start/follow-up/interruption; these handlers only enforce and execute the request. */
export function registerAgentCapabilities(
  kernel: ActionKernel,
  driver: ControlledAgentDriver,
  contractFor: (role: Exclude<AgentRole, "orchestrator">) => AgentSessionContract,
) {
  const agents = kernel.journal.agents;
  kernel.registerLocal("replace_agent", ({ authority }, action) => {
    const old = agents.instance(authority.runId, action);
    if (old.role === "orchestrator")
      throw new CapabilityRejected(
        "coordinator_owned",
        "Coordinator rotation belongs to the decision source; use change_agent_settings for a policy-approved effort change",
      );
    if (old.contract.runtime !== driver.kind)
      throw new CapabilityRejected("wrong_runtime", "Agent belongs to a different runtime");
    if (
      old.activeTurnId ||
      agents
        .turns(authority.runId)
        .some(
          (turn) =>
            turn.identity.agentId === old.agentId &&
            turn.identity.agentGeneration === old.agentGeneration &&
            !turn.stopEvidence,
        )
    )
      throw new CapabilityRejected(
        "agent_not_stopped",
        "Interrupt and confirm the exact old turn stopped before replacing it",
      );
    if (old.workspaceId === action.workspaceId)
      throw new CapabilityRejected(
        "fresh_workspace_required",
        "Replacement must use a separately created workspace; the old workspace is retained",
      );
    const assignment = agents.assignment(authority.runId, old.assignmentId);
    if (["review", "verification", "final_review"].includes(assignment.purpose)) {
      const binding = kernel.journal.delivery.binding(authority.runId, action);
      if (
        binding.candidateId !== assignment.candidateId ||
        binding.phase !== (assignment.purpose === "review" ? "pre_commit" : "exact_revision") ||
        !kernel.journal.delivery.candidateCurrent(authority.runId, binding)
      )
        throw new CapabilityRejected(
          "replacement_candidate_mismatch",
          "Replacement reviewer must retain the current candidate and evidence phase",
        );
    }
    const contract = contractFor(old.role);
    if (contract.runtime !== driver.kind)
      throw new CapabilityRejected(
        "wrong_runtime",
        "Replacement settings belong to a different driver",
      );
    // executeLocalAction owns one transaction: invalid reservation, audit failure
    // or result failure rolls back revocation and the new generation together.
    agents.revokeAgent(authority, old, action.reason);
    agents.releaseAgent(authority, old);
    const replacement = agents.reserveAgent(
      authority,
      {
        role: old.role,
        purpose: assignment.purpose,
        taskId: assignment.taskId,
        candidateId: assignment.candidateId,
        workspaceId: action.workspaceId,
        workspaceGeneration: action.workspaceGeneration,
        instructions: action.instructions,
        confinementProfile: "epicd-isolated",
        contract,
        replaces: old,
      },
      kernel.journal.control(authority.runId).controlVersion,
    );
    return {
      kind: "resource",
      resourceId: replacement.agentId,
      generation: replacement.agentGeneration,
    };
  });
  const run = async (context: ActionContext, agent: AgentIdentity, instructions: string) => {
    const instance = agents.instance(context.authority.runId, agent);
    const assignment = agents.assignment(context.authority.runId, instance.assignmentId);
    if (["review", "verification", "final_review"].includes(assignment.purpose))
      throw new CapabilityRejected(
        "review_capability_required",
        "Use run_review for candidate-bound independent review or exact-SHA verification; final epic review is not wired yet",
      );
    if (instance.role === "orchestrator")
      throw new CapabilityRejected(
        "coordinator_owned",
        "The decision source, not worker capabilities, owns coordinator turns",
      );
    if (instance.contract.runtime !== driver.kind)
      throw new CapabilityRejected("wrong_runtime", "Agent belongs to a different runtime");
    const turn = agents.prepareTurn(
      context.authority,
      agent,
      context.record.operationId,
      instructions,
      instance.role === "review" ? REVIEW_OUTPUT_SCHEMA : IMPLEMENTATION_OUTPUT_SCHEMA,
      kernel.journal.control(context.authority.runId).controlVersion,
    );
    const stopped = await driver.run(context.authority, turn.identity, context.signal);
    if (!stopped.stopEvidence)
      throw new Error("Agent stop is unconfirmed; retain this operation for reconciliation");
    if (stopped.status !== "completed")
      throw new OperationFailed(
        `Agent turn ${turn.identity.turnId} ${stopped.status}; inspect its recorded diagnostics`,
      );
    return {
      kind: "resource" as const,
      resourceId: agent.agentId,
      generation: agent.agentGeneration,
    };
  };
  kernel.registerExternal("start_agent", async (context, action) => {
    if (["review", "verification", "final_review"].includes(action.purpose))
      throw new CapabilityRejected(
        "review_capability_required",
        "Use run_review to start independent candidate review",
      );
    const contract = contractFor(action.role);
    if (contract.runtime !== driver.kind)
      throw new CapabilityRejected(
        "wrong_runtime",
        "Selected contract belongs to a different driver",
      );
    const agent = agents.reserveAgent(
      context.authority,
      { ...action, contract, confinementProfile: "epicd-isolated" },
      kernel.journal.control(context.authority.runId).controlVersion,
    );
    return run(context, agent, action.instructions);
  });
  kernel.registerExternal("start_specialist", async (context, action) => {
    const contract = contractFor(action.settingsRole);
    if (contract.runtime !== driver.kind)
      throw new CapabilityRejected(
        "wrong_runtime",
        "Selected contract belongs to a different driver",
      );
    const agent = agents.reserveAgent(
      context.authority,
      {
        ...action,
        role: action.settingsRole,
        purpose: "specialist",
        candidateId: null,
        instructions: `${action.specialty}: ${action.instructions}`,
        contract,
        confinementProfile: "epicd-isolated",
      },
      kernel.journal.control(context.authority.runId).controlVersion,
    );
    return run(context, agent, action.instructions);
  });
  kernel.registerExternal("continue_agent", (context, action) =>
    run(context, action, action.instructions),
  );
  kernel.registerExternal("interrupt_agent", async (context, action) => {
    const turn = agents
      .turns(context.authority.runId)
      .find((item) => item.identity.turnId === action.turnId);
    if (
      !turn ||
      turn.identity.agentId !== action.agentId ||
      turn.identity.agentGeneration !== action.agentGeneration
    )
      throw new CapabilityRejected(
        "stale_turn",
        "Interrupt must name this agent generation's exact turn",
      );
    const instance = agents.instance(context.authority.runId, action);
    if (instance.role === "orchestrator")
      throw new CapabilityRejected(
        "coordinator_owned",
        "Use operator control to interrupt the coordinator",
      );
    if (instance.contract.runtime !== driver.kind)
      throw new CapabilityRejected("wrong_runtime", "Agent belongs to a different runtime");
    const stopped = await driver.reconcile(context.authority, turn.identity);
    if (!stopped.stopEvidence)
      throw new Error("Interruption requested but process stop remains unconfirmed");
    return { kind: "resource", resourceId: action.agentId, generation: action.agentGeneration };
  });
}
