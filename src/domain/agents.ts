import { z } from "zod";
import { TurnIdentitySchema } from "./orchestration.js";
import { AgentRoleSchema, AgentSessionContractSchema } from "./types.js";
import { TurnLaunchSchema } from "./codex-launch.js";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const Generation = z.number().int().positive();
const Text = z.string().min(1).max(16000);
const At = z.iso.datetime();
export const AgentIdentitySchema = z.strictObject({ agentId: Id, agentGeneration: Generation });
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
export const WorkspaceIdentitySchema = z.strictObject({
  workspaceId: Id,
  workspaceGeneration: Generation,
});
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

export const WorkspaceRecordSchema = WorkspaceIdentitySchema.extend({
  schemaVersion: z.literal(1),
  runId: Id,
  path: z.string().min(1).max(4096),
  purpose: z.enum([
    "delivery",
    "implementation",
    "review",
    "verification",
    "diagnostic",
    "coordinator",
  ]),
  sourceMode: z.enum(["mutable", "immutable"]),
  baselineRevision: z.string().min(1).max(256),
  baselineFingerprint: z.string().min(1).max(256).nullable(),
  creationOperationId: Id.nullable().default(null),
  status: z.enum(["reserved", "ready", "quarantined", "disposed"]),
  activeTurnId: Id.nullable(),
  createdAt: At,
  updatedAt: At,
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

export const AgentAssignmentSchema = z.strictObject({
  assignmentId: Id,
  runId: Id,
  ...AgentIdentitySchema.shape,
  purpose: z.enum([
    "coordination",
    "implementation",
    "review",
    "verification",
    "final_review",
    "epic_repair",
    "specialist",
  ]),
  taskId: z.string().min(1).max(256).nullable(),
  candidateId: Id.nullable(),
  instructions: Text,
  createdAt: At,
});
export type AgentAssignment = z.infer<typeof AgentAssignmentSchema>;

export const ProviderIdentitySchema = z.discriminatedUnion("runtime", [
  z.strictObject({ runtime: z.literal("sdk"), sessionId: z.string().min(1).max(256) }),
  z.strictObject({
    runtime: z.literal("herdr"),
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    paneId: z.string().min(1).max(256),
    tabId: z.string().min(1).max(256),
    terminalId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256).nullable(),
  }),
]);
export type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>;

export const AgentInstanceSchema = AgentIdentitySchema.extend({
  schemaVersion: z.literal(1),
  runId: Id,
  role: AgentRoleSchema,
  ...WorkspaceIdentitySchema.shape,
  assignmentId: Id,
  contract: AgentSessionContractSchema,
  confinementProfile: z.string().min(1).max(256),
  provider: ProviderIdentitySchema.nullable(),
  status: z.enum(["reserved", "ready", "busy", "revoked", "released"]),
  activeTurnId: Id.nullable(),
  revokedReason: z.string().min(1).max(4000).nullable(),
  createdAt: At,
  updatedAt: At,
});
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;

export const AgentMailboxMessageSchema = z.strictObject({
  messageId: Id,
  runId: Id,
  ...AgentIdentitySchema.shape,
  operationId: Id,
  content: Text,
  status: z.enum(["queued", "reserved", "acknowledged", "indeterminate", "superseded"]),
  deliveryTurnId: Id.nullable(),
  acknowledgement: z.string().min(1).max(4000).nullable(),
  createdAt: At,
  updatedAt: At,
});
export type AgentMailboxMessage = z.infer<typeof AgentMailboxMessageSchema>;

export const TurnPromptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: TurnIdentitySchema,
  assignment: AgentAssignmentSchema,
  // The coordinator carries the bounded durable context. Worker instructions
  // retain their smaller limit in AgentJournal, including during replay.
  instructions: z.string().min(1).max(98304),
  messages: z.array(z.strictObject({ messageId: Id, content: Text })).max(100),
  // Kernel-supplied review facts, covered by the complete prompt digest. Optional
  // preserves hashes of historical prompts rather than inserting a new default.
  reviewContext: z.json().optional(),
});
export const TurnRecordSchema = z.strictObject({
  identity: TurnIdentitySchema,
  launch: TurnLaunchSchema.nullable().default(null),
  status: z.enum([
    "prepared",
    "submitting",
    "running",
    "stop_requested",
    "indeterminate",
    "completed",
    "failed",
    "cancelled",
  ]),
  prompt: TurnPromptSchema,
  promptDigest: z.string().length(64),
  outputSchema: z.json(),
  policyDigest: z.string().length(64),
  controlVersion: z.number().int().nonnegative(),
  submissionAcknowledgement: z.string().min(1).max(4000).nullable(),
  stopRequested: z.boolean(),
  stopEvidence: z.string().min(1).max(4000).nullable(),
  result: z.json().nullable(),
  resultEligible: z.boolean(),
  createdAt: At,
  updatedAt: At,
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;
