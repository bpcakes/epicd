import {
  AgentPreferencesSchema,
  ReasoningEffortSchema,
  resolveAgentRoleSettings,
  type AgentPreferences,
  type AgentRole,
  type AgentRolePreferences,
  type ReasoningEffort,
} from "../domain/types.js";

export function normalizeAgentModelInput(input: string): string | null {
  return input.trim() || null;
}

export function updateAgentPreference(
  current: AgentPreferences,
  role: AgentRole,
  update: Partial<AgentRolePreferences>,
): AgentPreferences {
  return AgentPreferencesSchema.parse({
    ...current,
    [role]: { ...current[role], ...update },
  });
}

export function cycleAgentReasoningEffort(
  current: AgentPreferences,
  role: AgentRole,
  fallbackModel: string | null,
  fallbackReasoningEffort: ReasoningEffort | null,
  direction: -1 | 1,
): AgentPreferences {
  const efforts = ReasoningEffortSchema.options;
  const currentEffort = resolveAgentRoleSettings(
    {
      agentSettings: current,
      model: fallbackModel,
      reasoningEffort: fallbackReasoningEffort,
    },
    role,
  ).reasoningEffort;
  const currentIndex = efforts.indexOf(currentEffort);
  const nextIndex = (currentIndex + direction + efforts.length) % efforts.length;
  const reasoningEffort = efforts[nextIndex];
  return reasoningEffort ? updateAgentPreference(current, role, { reasoningEffort }) : current;
}
