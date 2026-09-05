import type { EpicEngineOptions } from "./engine/engine.js";
import type { AgentRolePreferences, ReasoningEffort } from "./domain/types.js";

export type AgentOptionValues = {
  model?: string;
  modelInherit?: boolean;
  reasoning?: ReasoningEffort;
  reasoningInherit?: boolean;
  orchestratorModel?: string;
  orchestratorModelInherit?: boolean;
  orchestratorReasoning?: ReasoningEffort;
  orchestratorReasoningInherit?: boolean;
  implementationModel?: string;
  implementationModelInherit?: boolean;
  implementationReasoning?: ReasoningEffort;
  implementationReasoningInherit?: boolean;
  reviewModel?: string;
  reviewModelInherit?: boolean;
  reviewReasoning?: ReasoningEffort;
  reviewReasoningInherit?: boolean;
};

export function agentOptions(
  options: AgentOptionValues,
): Pick<EpicEngineOptions, "model" | "reasoningEffort" | "agentSettings"> {
  const orchestrator = rolePreferenceOptions(
    options.orchestratorModel,
    options.orchestratorModelInherit,
    options.orchestratorReasoning,
    options.orchestratorReasoningInherit,
  );
  const implementation = rolePreferenceOptions(
    options.implementationModel,
    options.implementationModelInherit,
    options.implementationReasoning,
    options.implementationReasoningInherit,
  );
  const review = rolePreferenceOptions(
    options.reviewModel,
    options.reviewModelInherit,
    options.reviewReasoning,
    options.reviewReasoningInherit,
  );
  const agentSettings = {
    ...(Object.keys(orchestrator).length > 0 ? { orchestrator } : {}),
    ...(Object.keys(implementation).length > 0 ? { implementation } : {}),
    ...(Object.keys(review).length > 0 ? { review } : {}),
  };
  return {
    ...(options.modelInherit
      ? { model: null }
      : options.model !== undefined
        ? { model: options.model }
        : {}),
    ...(options.reasoningInherit
      ? { reasoningEffort: null }
      : options.reasoning !== undefined
        ? { reasoningEffort: options.reasoning }
        : {}),
    ...(Object.keys(agentSettings).length > 0 ? { agentSettings } : {}),
  };
}

function rolePreferenceOptions(
  model: string | undefined,
  inheritModel: boolean | undefined,
  reasoningEffort: ReasoningEffort | undefined,
  inheritReasoning: boolean | undefined,
): Partial<AgentRolePreferences> {
  return {
    ...(inheritModel ? { model: null } : model !== undefined ? { model } : {}),
    ...(inheritReasoning
      ? { reasoningEffort: null }
      : reasoningEffort !== undefined
        ? { reasoningEffort }
        : {}),
  };
}
