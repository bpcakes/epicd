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
  // Computed by the trusted transport before redaction; excludes only status and assignee.
  workDigest: z.string().regex(/^[0-9a-f]{64}$/),
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
    kind: z.enum(["refresh", "claim", "adopt"]),
    taskId: TrackerIdSchema.nullable(),
    dispatched: z.boolean(),
    mutationDispatched: z.boolean(),
    ioStopped: z.boolean(),
    beforeSnapshotId: z.string().uuid().nullable(),
    afterSnapshotId: z.string().uuid().nullable(),
    outcome: z.enum(["observed", "claimed", "not_claimed", "conflict", "failed"]).nullable(),
    failure: z.string().max(4000).nullable(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .refine((operation) => (operation.outcome !== null) === (operation.finishedAt !== null))
  .refine((operation) => operation.outcome === null || operation.ioStopped)
  .refine(
    (operation) =>
      !operation.mutationDispatched ||
      (operation.dispatched && operation.kind !== "refresh" && operation.beforeSnapshotId !== null),
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
