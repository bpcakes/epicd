import { z } from "zod";
import {
  OrchestratorDecisionSchema,
  TurnIdentitySchema,
  type DecisionTicket,
} from "./orchestration.js";

export const MAX_DECISION_SOURCE_ATTEMPTS = 3;
export const DecisionSourceFailureCodeSchema = z.enum([
  "transient",
  "authentication",
  "quota",
  "model_unavailable",
  "configuration",
  "safety_stop",
  "runtime",
]);
export type DecisionSourceFailureCode = z.infer<typeof DecisionSourceFailureCodeSchema>;

/**
 * Trusted adapters only: this exception asserts that the failed request has settled.
 * Do not infer it from model prose, HTTP 429 alone, or a settled Herdr screen.
 * Unknown stop state must use an ordinary error and requires reconciliation.
 */
export class DecisionSourceError extends Error {
  constructor(
    readonly code: DecisionSourceFailureCode,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DecisionSourceError";
    DecisionSourceFailureCodeSchema.parse(code);
    if (retryAfterMs !== null && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0))
      throw new Error("Invalid provider retry delay");
  }
}

export const DecisionSourceOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decision"), decision: OrchestratorDecisionSchema }),
  z.strictObject({ kind: z.literal("invalid_output"), detail: z.string().max(8000) }),
  z.strictObject({
    kind: z.literal("failure"),
    code: DecisionSourceFailureCodeSchema,
    detail: z.string().max(8000),
    retryAfterMs: z.number().int().nonnegative().max(86_400_000).nullable(),
  }),
  z.strictObject({ kind: z.literal("indeterminate"), detail: z.string().max(8000) }),
]);
export type DecisionSourceOutcome = z.infer<typeof DecisionSourceOutcomeSchema>;

export const DecisionSourceAttemptSchema = z.strictObject({
  attemptId: z.string().uuid(),
  controllerLeaseId: z.string().min(1),
  turnIdentity: TurnIdentitySchema.nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  outcome: DecisionSourceOutcomeSchema.nullable(),
  retryNotBefore: z.iso.datetime().nullable(),
});
export type DecisionSourceAttempt = z.infer<typeof DecisionSourceAttemptSchema>;

export type DecisionExecution = {
  runId: string;
  ticket: DecisionTicket;
  /** Kernel-produced, bounded JSON, not a provider-supplied context or authority. */
  contextJson: string;
  attempts: DecisionSourceAttempt[];
};
