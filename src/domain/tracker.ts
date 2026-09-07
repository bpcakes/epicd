import { z } from "zod";
import { IssueStatusSchema, IssueTypeSchema } from "./types.js";
import type { KernelAction } from "./orchestration.js";

export const TrackerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
const Node = z.strictObject({
  path: z.string().startsWith("/").max(4096),
  device: z.string(),
  inode: z.string(),
});
export const TrackerBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repository: Node,
  directory: Node,
  database: Node,
  executable: Node,
  configurationDigest: z.string().length(64),
});
export type TrackerBinding = z.infer<typeof TrackerBindingSchema>;
export const TaskClaimBindingSchema = z.strictObject({
  trackerOperationId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  workDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TaskClaimBinding = z.infer<typeof TaskClaimBindingSchema>;
export const TrackerRelationSchema = z.strictObject({
  id: TrackerIdSchema,
  type: z.string().min(1).max(64),
  status: IssueStatusSchema,
});
export const TrackerIssueSchema = z.strictObject({
  id: TrackerIdSchema,
  title: z.string().min(1).max(1024),
  description: z.string().max(32768),
  acceptanceCriteria: z.string().max(32768),
  status: IssueStatusSchema,
  type: IssueTypeSchema,
  priority: z.number().int().min(0).max(4),
  assignee: z.string().max(1024).nullable(),
  instructions: z.string().max(32768).nullable(),
  // Missing tracker fields are normalized to null by the transport.
  closedAt: z.iso.datetime().nullable(),
  closeReason: z.string().max(32768).nullable(),
  closedBySession: z.string().max(1024).nullable(),
  updatedAt: z.iso.datetime().nullable(),
  // Raw work before redaction, excluding task status, assignee and close/update metadata.
  workDigest: z.string().regex(/^[0-9a-f]{64}$/),
  // Raw requirements and relation identities, without relation status. Expected container
  // closure changes status, not the work covered by an epic-level review.
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  dependencies: z.array(TrackerRelationSchema).max(1000),
  dependents: z.array(TrackerRelationSchema).max(1000),
});
export type TrackerIssue = z.infer<typeof TrackerIssueSchema>;
export const TrackerGraphSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    epicId: TrackerIdSchema,
    issues: z.array(TrackerIssueSchema).min(1).max(1000),
    readyIds: z.array(TrackerIdSchema).max(1000),
    startedAt: z.iso.datetime(),
    capturedAt: z.iso.datetime(),
  })
  .superRefine((graph, context) => {
    const issues = new Map(graph.issues.map((issue) => [issue.id, issue]));
    const root = issues.get(graph.epicId);
    if (!root || root.type !== "epic" || issues.size !== graph.issues.length)
      context.addIssue({
        code: "custom",
        message: "Tracker graph needs one exact epic and unique issue identities",
      });
    const visited = new Set<string>();
    const active = new Set<string>();
    const walk = (id: string) => {
      if (active.has(id)) throw new Error("Tracker parent-child cycle");
      if (visited.has(id)) return;
      const issue = issues.get(id);
      if (!issue) throw new Error("Tracker graph omitted a child");
      active.add(id);
      for (const edge of issue.dependents.filter((edge) => edge.type === "parent-child")) {
        const child = issues.get(edge.id);
        if (
          !child?.dependencies.some((parent) => parent.id === id && parent.type === "parent-child")
        )
          throw new Error("Tracker hierarchy changed between reads");
        walk(edge.id);
      }
      active.delete(id);
      visited.add(id);
    };
    try {
      walk(graph.epicId);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid tracker hierarchy",
      });
    }
    if (
      visited.size !== issues.size ||
      graph.readyIds.some((id) => id === graph.epicId || !visited.has(id)) ||
      new Set(graph.readyIds).size !== graph.readyIds.length
    )
      context.addIssue({
        code: "custom",
        message: "Tracker ready set or hierarchy is inconsistent; refresh it",
      });
  });
export type TrackerGraph = z.infer<typeof TrackerGraphSchema>;
export const TrackerSnapshotSchema = z.strictObject({
  snapshotId: z.string().uuid(),
  runId: z.string(),
  operationId: z.string().uuid(),
  digest: z.string().length(64),
  graph: TrackerGraphSchema,
});
export type TrackerSnapshot = z.infer<typeof TrackerSnapshotSchema>;
export const EpicRepairBindingSchema = z.strictObject({
  scopeDigest: z.string().length(64),
  epicBaselineRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  baseCommitId: z.uuid(),
  baseRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export type EpicRepairBinding = z.infer<typeof EpicRepairBindingSchema>;
const ScopeClosureProof = z.strictObject({
  scopeDigest: z.string().length(64),
  closureOperationIds: z.array(z.uuid()).max(1000),
  preexistingIds: z.array(TrackerIdSchema).max(1000),
});
export const TrackerClosureProofSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), claim: TaskClaimBindingSchema }),
  ScopeClosureProof.extend({ kind: z.literal("container") }),
  ScopeClosureProof.extend({
    kind: z.literal("epic"),
    candidateId: z.string().min(1).max(256),
    candidateGeneration: z.number().int().positive(),
    reviewScopeDigest: z.string().length(64),
    rootClosureOperationId: z.uuid().nullable(),
  }),
]);
export const TrackerClosureSchema = z.strictObject({
  publicationId: z.string().uuid(),
  revision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  reviewEvidenceId: z.string().min(1).max(256),
  proof: TrackerClosureProofSchema,
  reason: z.string().min(1).max(1024),
  commandReport: z.string().max(4000).optional(),
  // Physical ref inspection is separate from current journal approval.
  refsVerified: z.boolean(),
  intervention: z.boolean(),
});
export type TrackerClosure = z.infer<typeof TrackerClosureSchema>;
export const CompletionResourcesSchema = z.strictObject({
  disposition: z.literal("retained_for_inspection"),
  workspaceIds: z.array(z.string()),
  agentAssignmentIds: z.array(z.string()),
  publicationIds: z.array(z.uuid()),
  fixtureCreationIds: z.array(z.uuid()),
  detail: z.string().min(1).max(4000),
});
export type CompletionResources = z.infer<typeof CompletionResourcesSchema>;
export const TrackerOperationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    trackerOperationId: z.string().uuid(),
    runId: z.string(),
    actionId: z.string().uuid(),
    operationId: z.string().uuid(),
    controllerLeaseId: z.string(),
    ioLeaseId: z.string(),
    policyDigest: z.string(),
    kind: z.enum([
      "refresh",
      "claim",
      "adopt",
      "close_task",
      "close_container",
      "close_epic",
      "complete",
    ]),
    closure: TrackerClosureSchema.optional(),
    completion: CompletionResourcesSchema.nullable(),
    taskId: TrackerIdSchema.nullable(),
    dispatched: z.boolean(),
    mutationDispatched: z.boolean(),
    ioStopped: z.boolean(),
    beforeSnapshotId: z.string().uuid().nullable(),
    afterSnapshotId: z.string().uuid().nullable(),
    outcome: z
      .enum([
        "observed",
        "claimed",
        "not_claimed",
        "closed",
        "not_closed",
        "completed",
        "conflict",
        "failed",
      ])
      .nullable(),
    failure: z.string().max(4000).nullable(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .refine((operation) => (operation.outcome !== null) === (operation.finishedAt !== null))
  .refine((operation) => operation.outcome === null || operation.ioStopped)
  .refine(
    (operation) =>
      ["close_task", "close_container", "close_epic", "complete"].includes(operation.kind) ===
      (operation.closure !== undefined),
  )
  .refine(
    (operation) =>
      !operation.closure ||
      operation.closure.proof.kind ===
        (operation.kind === "close_task"
          ? "task"
          : operation.kind === "close_container"
            ? "container"
            : "epic"),
  )
  .refine(
    (operation) => !operation.completion || (operation.kind === "complete" && operation.ioStopped),
  )
  .refine((operation) => operation.outcome !== "completed" || operation.completion !== null)
  .refine(
    (operation) =>
      !["closed", "completed"].includes(operation.outcome ?? "") ||
      (operation.closure?.refsVerified && !operation.closure.intervention),
  )
  .refine(
    (operation) =>
      !operation.mutationDispatched ||
      (operation.dispatched &&
        !["refresh", "complete"].includes(operation.kind) &&
        operation.beforeSnapshotId !== null),
  );
export type TrackerOperation = z.infer<typeof TrackerOperationSchema>;
export const trackerActor = (runId: string) => `epicd:${runId}`;

export function concurrentWithTracker(kind: KernelAction["kind"]): boolean {
  return (
    kind.startsWith("inspect_") ||
    kind.startsWith("read_") ||
    [
      "record_memory",
      "wait_for_events",
      "message_agent",
      "interrupt_agent",
      "escalate",
      "reconcile_tracker_operation",
    ].includes(kind)
  );
}

export function claimable(
  graph: TrackerGraph,
  taskId: string,
  kind: "claim" | "adopt",
): TrackerIssue {
  const root = graph.issues.find((issue) => issue.id === graph.epicId)!;
  const task = graph.issues.find((issue) => issue.id === taskId);
  if (
    ["closed", "tombstone"].includes(root.status) ||
    !task ||
    task.id === graph.epicId ||
    task.type === "epic"
  )
    throw new Error("Claim requires concrete work in the current open epic graph");
  if (!task.description.trim() && !task.acceptanceCriteria.trim())
    throw new Error("Task has no concrete acceptance or implementation work");
  if (task.assignee?.trim())
    throw new Error("Task is already assigned; do not overwrite tracker ownership");
  if (
    kind === "claim"
      ? !graph.readyIds.includes(taskId) || task.status !== "open"
      : task.status !== "in_progress"
  )
    throw new Error("Task does not satisfy the requested claim/adoption state");
  return task;
}
