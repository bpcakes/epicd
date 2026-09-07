import { z } from "zod";
import { AgentRoleSchema, AgentRoleSettingsSchema } from "./types.js";

// These identities originate in durable controller records, never in agent output.
const IdentityPartSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export const TurnIdentitySchema = z.strictObject({
  runId: IdentityPartSchema,
  agentId: IdentityPartSchema,
  agentGeneration: z.number().int().positive(),
  turnId: IdentityPartSchema,
  operationId: IdentityPartSchema,
  assignmentId: IdentityPartSchema,
  workspaceId: IdentityPartSchema,
  workspaceGeneration: z.number().int().positive(),
});
export type TurnIdentity = z.infer<typeof TurnIdentitySchema>;

export const CapabilityAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.string().min(1) }),
]);
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;

export const RuntimeCapabilitiesSchema = z.strictObject({
  structuredResults: CapabilityAvailabilitySchema,
  lifecycleObservation: CapabilityAvailabilitySchema,
  commandEvents: CapabilityAvailabilitySchema,
  diagnosticOutput: CapabilityAvailabilitySchema,
  usage: CapabilityAvailabilitySchema,
  liveSteering: CapabilityAvailabilitySchema,
  durableReconnect: CapabilityAvailabilitySchema,
  confirmedInterruption: CapabilityAvailabilitySchema,
  confinedWrites: CapabilityAvailabilitySchema,
  immutableReviewSource: CapabilityAvailabilitySchema,
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export type StopAcknowledgement =
  { status: "stopped"; evidence: string } | { status: "still_running" | "unknown"; reason: string };

export const HerdrTurnResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: TurnIdentitySchema,
  result: z.unknown(),
});

export function sameTurn(left: TurnIdentity, right: TurnIdentity): boolean {
  return (Object.keys(TurnIdentitySchema.shape) as (keyof TurnIdentity)[]).every(
    (key) => left[key] === right[key],
  );
}

const Id = z.string().min(1).max(256);
const Version = z.number().int().nonnegative();
const AgentTarget = { agentId: Id, agentGeneration: z.number().int().positive() };
const WorkspaceTarget = { workspaceId: Id, workspaceGeneration: z.number().int().positive() };
const CandidateTarget = { candidateId: Id, candidateGeneration: z.number().int().positive() };

export const MemoryInputSchema = z.strictObject({
  kind: z.enum(["strategy", "fact", "hypothesis", "failed_approach", "recovery", "knowledge"]),
  content: z.string().min(1).max(8000),
  scope: z.enum(["run", "task", "repository_proposal"]),
  taskId: Id.nullable(),
  confidence: z.enum(["observed", "hypothesis", "agent_report"]),
  observationIds: z.array(z.number().int().positive()).max(100),
  evidenceIds: z.array(Id).max(100),
  revision: Id.nullable(),
  environmentGeneration: Version.nullable(),
  supersedes: Id.nullable(),
});
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

/** Each admitted action has a narrow schema; none conveys controller authority. */
export const KernelActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inspect_run") }),
  z.strictObject({ kind: z.literal("inspect_candidate"), ...CandidateTarget }),
  z.strictObject({ kind: z.literal("inspect_validation_plan"), validationPlanId: Id }),
  z.strictObject({ kind: z.literal("inspect_evidence"), evidenceId: Id }),
  z.strictObject({ kind: z.literal("inspect_review"), evidenceId: Id }),
  z.strictObject({ kind: z.literal("inspect_commit"), commitId: Id }),
  z.strictObject({
    kind: z.literal("create_implementation_workspace"),
    baseCommitId: Id.nullable(),
  }),
  z.strictObject({
    kind: z.literal("read_review"),
    evidenceId: Id,
    offset: Version,
    limit: z.number().int().min(1).max(8000),
  }),
  z.strictObject({
    kind: z.literal("inspect_findings"),
    taskId: Id,
    offset: Version,
    limit: z.number().int().positive().max(100),
  }),
  z.strictObject({
    kind: z.literal("inspect_repo"),
    ...WorkspaceTarget,
    operation: z.enum(["read", "search", "list", "diff", "history"]),
    path: z.string().max(4096),
    query: z.string().max(1000).nullable(),
    offset: Version,
    limit: z.number().int().positive().max(1000),
  }),
  z.strictObject({ kind: z.literal("inspect_agent"), ...AgentTarget }),
  z.strictObject({
    kind: z.literal("inspect_artifact"),
    artifactId: Id,
    offset: Version,
    limit: z.number().int().positive().max(65536),
  }),
  z.strictObject({ kind: z.literal("inspect_fixture"), fixtureId: Id }),
  z.strictObject({
    kind: z.literal("start_agent"),
    role: AgentRoleSchema.exclude(["orchestrator"]),
    purpose: z.enum(["implementation", "review", "verification", "final_review", "epic_repair"]),
    taskId: Id.nullable(),
    ...WorkspaceTarget,
    candidateId: Id.nullable(),
    instructions: z.string().min(1).max(16000),
  }),
  z.strictObject({
    kind: z.literal("start_specialist"),
    specialty: z.string().min(1).max(256),
    settingsRole: AgentRoleSchema.exclude(["orchestrator"]),
    taskId: Id.nullable(),
    ...WorkspaceTarget,
    instructions: z.string().min(1).max(16000),
  }),
  z.strictObject({
    kind: z.literal("message_agent"),
    ...AgentTarget,
    message: z.string().min(1).max(16000),
  }),
  z.strictObject({
    kind: z.literal("continue_agent"),
    ...AgentTarget,
    instructions: z.string().min(1).max(16000),
  }),
  z.strictObject({ kind: z.literal("interrupt_agent"), ...AgentTarget, turnId: Id }),
  z.strictObject({
    kind: z.literal("replace_agent"),
    ...AgentTarget,
    reason: z.string().min(1).max(4000),
  }),
  z.strictObject({
    kind: z.literal("define_validation_plan"),
    taskId: Id,
    acceptanceCriteria: z.array(z.string().min(1).max(4000)).min(1).max(100),
    checks: z
      .array(
        z.strictObject({
          id: Id,
          command: z.string().min(1).max(4096),
          args: z.array(z.string().max(4096)).max(100),
          cwd: z.string().max(4096),
          timeoutMs: z.number().int().positive().max(21600000),
          environmentBindings: z.array(Id).max(100),
        }),
      )
      .min(1)
      .max(100),
  }),
  z.strictObject({
    kind: z.literal("capture_candidate"),
    taskId: Id,
    ...WorkspaceTarget,
    validationPlanId: Id,
  }),
  z.strictObject({
    kind: z.literal("create_review_workspace"),
    ...CandidateTarget,
    revision: Id.nullable(),
  }),
  z.strictObject({
    kind: z.literal("restore_owned_delta"),
    ...WorkspaceTarget,
    baselineSnapshotId: Id,
    expectedFingerprint: Id,
  }),
  z.strictObject({ kind: z.literal("dispose_workspace"), ...WorkspaceTarget }),
  z.strictObject({
    kind: z.literal("run_validation"),
    ...WorkspaceTarget,
    ...CandidateTarget,
    validationPlanId: Id,
    checkId: Id,
  }),
  z.strictObject({
    kind: z.literal("run_review"),
    ...CandidateTarget,
    ...WorkspaceTarget,
    agent: z.strictObject(AgentTarget).nullable(),
    instructions: z.string().min(1).max(8000),
  }),
  z.strictObject({
    kind: z.literal("request_commit"),
    ...CandidateTarget,
    subject: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal("request_publish"),
    ...CandidateTarget,
    revision: Id,
    expectedPreviousRevision: Id,
  }),
  z.strictObject({
    kind: z.literal("request_beads_transition"),
    transition: z.enum(["claim", "adopt", "close_task", "close_container", "close_epic"]),
    taskId: Id,
    revision: Id.nullable(),
  }),
  z.strictObject({
    kind: z.literal("provision_declared_fixture"),
    fixtureId: Id,
    operation: z.enum(["create", "reset", "cleanup"]),
    expectedGeneration: Version,
  }),
  z.strictObject({
    kind: z.literal("change_agent_settings"),
    role: AgentRoleSchema,
    settings: AgentRoleSettingsSchema,
  }),
  z.strictObject({ kind: z.literal("record_memory"), entry: MemoryInputSchema }),
  z.strictObject({
    kind: z.literal("wait_for_events"),
    afterCursor: Version,
    deadline: z.iso.datetime().nullable(),
  }),
  z.strictObject({
    kind: z.literal("escalate"),
    question: z.string().min(1).max(8000),
    reason: z.enum(["authority", "judgment", "budget", "ownership", "runtime"]),
    evidenceIds: z.array(Id).max(100),
  }),
  z.strictObject({ kind: z.literal("complete_run") }),
]);
export type KernelAction = z.infer<typeof KernelActionSchema>;

export const ActionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionId: Id,
  observationCursor: Version,
  expectedControlVersion: Version,
  action: KernelActionSchema,
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;
export const OrchestratorDecisionSchema = z.strictObject({
  explanation: z.string().min(1).max(8000),
  evidenceIds: z.array(Id).max(100),
  request: ActionRequestSchema,
});
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;

export const ActionPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("inspection"),
    text: z.string().max(65536),
    artifactIds: z.array(Id).max(100),
  }),
  z.strictObject({ kind: z.literal("resource"), resourceId: Id, generation: Version }),
  z.strictObject({
    kind: z.literal("validation"),
    evidenceId: Id,
    outcome: z.enum(["succeeded", "failed", "cancelled", "timed_out", "not_started"]),
    satisfiesCheck: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("memory"), memoryId: Id }),
  z.strictObject({
    kind: z.literal("message"),
    messageId: Id,
    delivery: z.enum(["queued", "acknowledged"]),
  }),
  z.strictObject({
    kind: z.literal("wait"),
    afterCursor: Version,
    deadline: z.iso.datetime().nullable(),
  }),
  z.strictObject({ kind: z.literal("escalation"), escalationId: Id }),
  z.strictObject({ kind: z.literal("delivery"), revision: Id, evidenceIds: z.array(Id) }),
  z.strictObject({
    kind: z.literal("settings"),
    role: AgentRoleSchema,
    settings: AgentRoleSettingsSchema,
  }),
  z.strictObject({ kind: z.literal("complete") }),
]);
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;
export const ActionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), actionId: Id, result: ActionPayloadSchema }),
  z.strictObject({ status: z.literal("running"), actionId: Id, operationId: Id }),
  z.strictObject({
    status: z.literal("rejected"),
    actionId: Id,
    code: z.string().min(1).max(128),
    detail: z.string().max(8000),
  }),
  z.strictObject({ status: z.literal("failed"), actionId: Id, problemId: Id }),
  z.strictObject({ status: z.literal("indeterminate"), actionId: Id, problemId: Id }),
  z.strictObject({ status: z.literal("cancelled"), actionId: Id, problemId: Id }),
]);
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const ControlStateSchema = z.strictObject({
  runId: Id,
  controlVersion: Version,
  policyDigest: Id,
  status: z.enum(["active", "paused", "awaiting_user", "blocked", "complete"]),
  observationCursor: Version,
  decisionsUsed: Version,
  maxDecisions: z.number().int().positive(),
});
export type ControlState = z.infer<typeof ControlStateSchema>;
/** Held inside the kernel only; never serialize this into model context or artifacts. */
export type ControllerAuthority = Readonly<{ runId: string; ownerToken: string; leaseId: string }>;

export const ObservationInputSchema = z.strictObject({
  source: z.string().min(1).max(128),
  sourceEventId: Id,
  kind: z.string().min(1).max(128),
  summary: z.string().max(8000),
  artifactIds: z.array(Id).max(100),
  identity: TurnIdentitySchema.nullable(),
  wakesOrchestrator: z.boolean(),
});
export type ObservationInput = z.infer<typeof ObservationInputSchema>;
export const ObservationSchema = ObservationInputSchema.extend({
  id: z.number().int().positive(),
  at: z.iso.datetime(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export type DecisionTicket = {
  decisionId: string;
  observationCursor: number;
  expectedControlVersion: number;
  policyDigest: string;
};
export const ActionRecordSchema = z.strictObject({
  actionId: Id,
  operationId: Id,
  runId: Id,
  decisionId: Id,
  policyDigest: Id,
  request: ActionRequestSchema,
  requestDigest: Id,
  status: z.enum([
    "accepted",
    "running",
    "succeeded",
    "failed",
    "rejected",
    "cancelled",
    "indeterminate",
  ]),
  result: ActionResultSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

export type MemoryEntry = MemoryInput & {
  memoryId: string;
  createdAt: string;
  supersededBy: string | null;
};
