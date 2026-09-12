import { z } from "zod";
import { ProviderFailureCategorySchema, type ProviderFailureCategory } from "./decision-source.js";
import { TurnIdentitySchema, type TurnIdentity } from "./orchestration.js";
import { redactDiagnosticText, redactSensitiveText } from "../util/redact.js";

export const AppServerCodexErrorInfoCodeSchema = z.enum([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);
export const ProviderFailureEvidenceSchema = z.enum([
  "provider_code",
  "provider_message",
  "account_snapshot",
  "unclassified",
]);
export const ProviderFailureSourceSchema = z.enum([
  "sdk.error",
  "sdk.turn_failed",
  "app_server.error",
  "app_server.account_rate_limits",
]);
export const ProviderFailureResetSchema = z.strictObject({
  detail: z.string().min(1).max(256),
  source: ProviderFailureEvidenceSchema.exclude(["unclassified"]),
});
const ProviderFailureClassificationBaseSchema = z.strictObject({
  category: ProviderFailureCategorySchema,
  evidence: ProviderFailureEvidenceSchema,
  message: z.string().max(8000),
  source: ProviderFailureSourceSchema,
  providerCode: AppServerCodexErrorInfoCodeSchema.nullable(),
  reset: ProviderFailureResetSchema.nullable(),
});
export const ProviderFailureClassificationSchema = ProviderFailureClassificationBaseSchema.refine(
  validProvenance,
  "Provider failure evidence does not match its trusted source",
);
export type ProviderFailureClassification = z.infer<typeof ProviderFailureClassificationSchema>;

export const EssentialTurnFailureSchema = ProviderFailureClassificationBaseSchema.extend({
  schemaVersion: z.literal(1),
  identity: TurnIdentitySchema,
  launchGeneration: z.uuid(),
  providerSessionId: z.string().min(1).max(256).nullable(),
  observedAt: z.iso.datetime(),
  diagnosticArtifactIds: z.array(z.uuid()).max(8),
  diagnosticOmission: z.enum(["budget_exhausted", "input_too_large", "sink_failed"]).nullable(),
}).refine(validProvenance, "Provider failure evidence does not match its trusted source");
export type EssentialTurnFailure = z.infer<typeof EssentialTurnFailureSchema>;

export type ProviderFailureInput =
  | {
      channel: "sdk";
      event: "error" | "turn.failed";
      message: string;
    }
  | {
      channel: "app_server";
      event: "error";
      message: string;
      codexErrorInfo: unknown;
    };

const retryTimestamp =
  "(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\\d|3[01])(?:st|nd|rd|th), \\d{4} )?(?:[1-9]|1[0-2]):[0-5]\\d (?:AM|PM)";
const sdkUsageLimitWithOrRetry = new RegExp(
  "^(?:" +
    [
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits",
      "You've hit your usage limit. To get more access now, send a request to your admin",
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),",
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
    ]
      .map(escapeRegExp)
      .join("|") +
    `)(?: or try again at (${retryTimestamp})| or try again later)\\.$`,
);
const sdkUsageLimitWithRetry = new RegExp(
  `^You've hit your usage limit\\. (?:Try again at (${retryTimestamp})|Try again later)\\.$`,
);
const sdkUsageLimitWithoutRetry = new Set([
  "Your workspace is out of credits. Add credits to continue.",
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
  "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
  "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
]);

/**
 * Classifies only genuine provider-channel inputs supplied by a trusted adapter.
 * Callers must never pass tool output, agent messages, terminal text, or launcher exceptions.
 */
export function classifyProviderFailure(
  input: ProviderFailureInput,
): ProviderFailureClassification {
  const message = redactSensitiveText(redactDiagnosticText(input.message), 7999);
  if (input.channel === "sdk") {
    const usageLimit = sdkUsageLimitDetails(input.message);
    return ProviderFailureClassificationSchema.parse(
      usageLimit
        ? {
            category: "quota",
            evidence: "provider_message",
            message,
            source: input.event === "error" ? "sdk.error" : "sdk.turn_failed",
            providerCode: null,
            reset:
              usageLimit.resetDetail === null
                ? null
                : { detail: usageLimit.resetDetail, source: "provider_message" },
          }
        : {
            category: "runtime",
            evidence: "unclassified",
            message,
            source: input.event === "error" ? "sdk.error" : "sdk.turn_failed",
            providerCode: null,
            reset: null,
          },
    );
  }

  const code = AppServerCodexErrorInfoCodeSchema.safeParse(input.codexErrorInfo);
  if (!code.success)
    return ProviderFailureClassificationSchema.parse({
      category: httpStatus(input.codexErrorInfo) === 429 ? "transient" : "runtime",
      evidence: "unclassified",
      message,
      source: "app_server.error",
      providerCode: null,
      reset: null,
    });
  return ProviderFailureClassificationSchema.parse({
    category: appServerCategory(code.data),
    evidence: "provider_code",
    message,
    source: "app_server.error",
    providerCode: code.data,
    reset: null,
  });
}

function sdkUsageLimitDetails(message: string): { resetDetail: string | null } | null {
  if (sdkUsageLimitWithoutRetry.has(message)) return { resetDetail: null };
  for (const template of [sdkUsageLimitWithOrRetry, sdkUsageLimitWithRetry]) {
    const match = template.exec(message);
    if (match)
      return {
        resetDetail: match[1] === undefined ? "try again later" : `try again at ${match[1]}`,
      };
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function essentialTurnFailure(
  identity: TurnIdentity,
  launchGeneration: string,
  providerSessionId: string | null,
  observedAt: string,
  failure: ProviderFailureClassification,
  diagnostics: {
    artifactIds: string[];
    omission: EssentialTurnFailure["diagnosticOmission"];
  },
): EssentialTurnFailure {
  return EssentialTurnFailureSchema.parse({
    schemaVersion: 1,
    identity,
    launchGeneration,
    providerSessionId,
    observedAt,
    ...failure,
    diagnosticArtifactIds: diagnostics.artifactIds,
    diagnosticOmission: diagnostics.omission,
  });
}

function appServerCategory(
  code: z.infer<typeof AppServerCodexErrorInfoCodeSchema>,
): ProviderFailureCategory {
  switch (code) {
    case "usageLimitExceeded":
      return "quota";
    case "rateLimitExceeded":
    case "serverOverloaded":
      return "transient";
    case "unauthorized":
      return "authentication";
    case "contextWindowExceeded":
      return "context_window";
    case "sessionBudgetExceeded":
      return "session_budget";
    case "cyberPolicy":
    case "misalignmentPolicyViolation":
      return "safety_stop";
    case "badRequest":
      return "configuration";
    case "internalServerError":
    case "threadRollbackFailed":
    case "sandboxError":
    case "other":
      return "runtime";
  }
}

function validProvenance(
  failure: z.infer<typeof ProviderFailureClassificationBaseSchema>,
): boolean {
  const sdk = failure.source === "sdk.error" || failure.source === "sdk.turn_failed";
  return failure.evidence === "provider_code"
    ? failure.source === "app_server.error" &&
        failure.providerCode !== null &&
        failure.category === appServerCategory(failure.providerCode)
    : failure.evidence === "provider_message"
      ? sdk && failure.providerCode === null
      : failure.evidence === "account_snapshot"
        ? failure.source === "app_server.account_rate_limits" && failure.providerCode === null
        : failure.providerCode === null && failure.source !== "app_server.account_rate_limits";
}

function httpStatus(value: unknown): number | null {
  const parsed = z
    .union([
      z.strictObject({ httpConnectionFailed: z.object({ httpStatusCode: z.number().int() }) }),
      z.strictObject({
        responseStreamConnectionFailed: z.object({ httpStatusCode: z.number().int() }),
      }),
      z.strictObject({
        responseStreamDisconnected: z.object({ httpStatusCode: z.number().int() }),
      }),
      z.strictObject({
        responseTooManyFailedAttempts: z.object({ httpStatusCode: z.number().int() }),
      }),
    ])
    .safeParse(value);
  if (!parsed.success) return null;
  const variant = Object.values(parsed.data)[0];
  return variant?.httpStatusCode ?? null;
}
