import type { AgentIdentity, AgentInstance, TurnRecord } from "../domain/agents.js";

/** Conservative transport maintenance, not a model context-size claim or delivery budget. */
export const COORDINATOR_CONVERSATION_LIMITS = Object.freeze({
  turns: 12,
  retainedBytes: 512 * 1024,
  reportedInputTokens: 192 * 1024,
});

/** Reconstructed from immutable turn inputs and recorded SDK usage after cold restart.
 * Bytes include repeated schemas and retained results, not hidden reasoning/tool history.
 * SDK input usage may aggregate requests; use its high-water mark as pressure, not
 * exact context occupancy. Herdr needs the byte/turn guards even without usage.
 * Provider compaction cannot reset these counters or the run's decision/retry budgets.
 */
export function coordinatorConversationPressure(
  agent: AgentInstance,
  turns: readonly TurnRecord[],
  conversationOwners: readonly AgentIdentity[] = [agent],
) {
  const owners = new Set(
    conversationOwners.map((owner) => `${owner.agentId}/${owner.agentGeneration}`),
  );
  const own = turns.filter(
    (turn) =>
      turn.identity.runId === agent.runId &&
      owners.has(`${turn.identity.agentId}/${turn.identity.agentGeneration}`),
  );
  const retainedBytes = own.reduce(
    (sum, turn) =>
      sum +
      Buffer.byteLength(JSON.stringify(turn.prompt)) +
      Buffer.byteLength(JSON.stringify(turn.outputSchema)) +
      Buffer.byteLength(JSON.stringify(turn.result)),
    0,
  );
  const reportedInputTokens = own.reduce(
    (max, turn) => Math.max(max, turn.sdkUsage?.inputTokens ?? 0),
    0,
  );
  const usageTurns = own.filter((turn) => turn.sdkUsage !== null).length;
  const reasons = [
    ...(own.length >= COORDINATOR_CONVERSATION_LIMITS.turns ? ["turn_limit"] : []),
    ...(retainedBytes >= COORDINATOR_CONVERSATION_LIMITS.retainedBytes ? ["byte_limit"] : []),
    ...(reportedInputTokens >= COORDINATOR_CONVERSATION_LIMITS.reportedInputTokens
      ? ["usage_pressure"]
      : []),
  ];
  return {
    reasons,
    turns: own.length,
    retainedBytes,
    reportedInputTokens,
    usageTurns,
    limits: COORDINATOR_CONVERSATION_LIMITS,
  };
}
