import type { StateStore } from "../adapters/store.js";
import { digestJson } from "../domain/repository-policy.js";
import {
  ORCHESTRATOR_MODEL,
  resolveAgentRoleSettings,
  ResolvedAgentRoleSettingsSchema,
} from "../domain/types.js";
import type { ActionKernel } from "./actions.js";
import { CapabilityRejected } from "./guards.js";

/** Autonomous selection is bounded by frozen policy; no live contract is rewritten. */
export function registerSettingsCapabilities(kernel: ActionKernel, store: StateStore) {
  if (kernel.journal !== store.orchestration)
    throw new Error("Settings and action authority must use the same store connection");
  kernel.registerLocal("change_agent_settings", ({ authority }, action) => {
    const parsed = ResolvedAgentRoleSettingsSchema.safeParse(action.settings);
    if (!parsed.success)
      throw new CapabilityRejected(
        "invalid_agent_settings",
        "Select a concrete model and supported reasoning setting",
      );
    const state = store.get(authority.runId)!;
    const settings = parsed.data;
    const current = resolveAgentRoleSettings(state, action.role);
    const policy = kernel.journal.policy(authority.runId);
    if (action.role === "orchestrator") {
      if (
        settings.model !== ORCHESTRATOR_MODEL ||
        !policy.coordinator.reasoningEfforts.some((effort) => effort === settings.reasoningEffort)
      )
        throw new CapabilityRejected(
          "invalid_coordinator_settings",
          "The coordinator must remain Astra with an effort allowed by frozen policy",
        );
    } else if (
      digestJson(settings) !== digestJson(current) &&
      !policy.autonomousWorkerSettings.some(
        (allowed) => digestJson(allowed) === digestJson(settings),
      )
    ) {
      throw new CapabilityRejected(
        "worker_settings_not_allowed",
        "The requested model/effort pair is not in autonomousWorkerSettings; existing operator-selected settings remain in force",
      );
    }
    if (digestJson(settings) !== digestJson(current)) {
      const preferences = structuredClone(state.agentSettings);
      preferences[action.role] = settings;
      store.updateAgentSettingsWithLease(authority.runId, authority.ownerToken, preferences);
    }
    return {
      kind: "inspection",
      text: JSON.stringify({
        role: action.role,
        settings,
        appliesTo: "Future assignments only; existing contracts and retry budgets are unchanged",
      }),
      artifactIds: [],
    };
  });
}
