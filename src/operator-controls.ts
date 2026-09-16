import { resolve } from "node:path";
import { z } from "zod";
import { StateStore } from "./adapters/store.js";
import { bindFixtureExecutable, bindFixtureProvider } from "./adapters/fixtures.js";
import { handoffRuntime } from "./bootstrap.js";
import { FixtureOperationSchema } from "./domain/fixtures.js";
import { RuntimeKindSchema } from "./domain/types.js";
import { runStatusView } from "./status.js";

const observed = { controlVersion: z.number().int().nonnegative() };
const id = z.string().min(1).max(256);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const grant = { fixtureId: id, expiresAt: z.string().min(1).max(100), psqlPath: path };
/** Trusted operator input only. This API is never registered as a model capability. */
export const OperatorRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pause"), ...observed }),
  z.strictObject({
    kind: z.literal("abandon_conversation"),
    ...observed,
    transferId: id,
    reason: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    kind: z.literal("respond"),
    ...observed,
    escalationId: id,
    message: z.string().min(1).max(7000),
  }),
  z.strictObject({
    kind: z.literal("grant_fixture"),
    ...observed,
    ...grant,
    operations: z.array(FixtureOperationSchema).min(1).max(100),
  }),
  z.strictObject({ kind: z.literal("revoke_fixture"), ...observed, grantId: id }),
  z.strictObject({ kind: z.literal("grant_sql"), ...observed, ...grant }),
  z.strictObject({ kind: z.literal("revoke_sql"), ...observed, grantId: id }),
  z.strictObject({
    kind: z.literal("handoff"),
    ...observed,
    runtime: RuntimeKindSchema,
    codexPath: path.optional(),
    herdrPath: path.optional(),
    retainCoordinatorSession: z.boolean().optional(),
  }),
]);
export type OperatorRequest = z.infer<typeof OperatorRequestSchema>;

/** Shared CLI/console boundary: resolve physical bindings here, commit through the existing kernel. */
export class RunOperator {
  private pending: Promise<string> | null = null;
  constructor(
    private readonly store: StateStore,
    readonly runId: string,
  ) {}

  status() {
    return runStatusView(this.store, this.runId);
  }

  async submit(input: OperatorRequest, signal?: AbortSignal): Promise<string> {
    if (this.pending) throw new Error("An operator request is still settling");
    const request = OperatorRequestSchema.parse(input);
    const work = this.apply(request, signal);
    this.pending = work;
    try {
      return await work;
    } finally {
      if (this.pending === work) this.pending = null;
    }
  }

  /** Closing a console cannot close SQLite underneath an admitted asynchronous request. */
  async settle(): Promise<void> {
    try {
      await this.pending;
    } catch {
      /* submit's caller owns reporting the actual failure. */
    }
  }

  private async apply(request: OperatorRequest, signal?: AbortSignal): Promise<string> {
    const journal = this.store.orchestration;
    signal?.throwIfAborted();
    // Abandonment owns its version check inside the fenced transaction, where
    // an already-terminal transfer can acknowledge a lost response without mutation.
    if (
      request.kind !== "abandon_conversation" &&
      journal.control(this.runId).controlVersion !== request.controlVersion
    )
      throw new Error("Control changed; inspect the run before retrying");
    switch (request.kind) {
      case "abandon_conversation": {
        // Synchronous lease scope: no external I/O or model execution occurs.
        const lease = this.store.acquireLease(this.runId);
        try {
          journal.abandonConversationTransfer(
            { runId: this.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId },
            request.controlVersion,
            request.transferId,
            request.reason,
          );
        } finally {
          this.store.releaseLease(this.runId, lease.ownerToken);
        }
        return "Conversation transfer abandoned. Evidence and resources retained. Inspect status, resolve any pending question, then resume with a fresh conversation.";
      }
      case "pause":
        journal.operatorControl(this.runId, request.controlVersion, { kind: "pause" });
        return "Pause recorded. External work is not considered stopped until its runtime receipt confirms it.";
      case "respond":
        journal.operatorControl(this.runId, request.controlVersion, {
          kind: "respond",
          escalationId: request.escalationId,
          message: request.message,
        });
        return "Response recorded as an instruction, not an environment grant. No controller was started; resume explicitly if none is attached.";
      case "grant_fixture": {
        const definition = journal.fixtures.definition(this.runId, request.fixtureId);
        const binding = await bindFixtureProvider(definition, resolve(request.psqlPath));
        signal?.throwIfAborted();
        const grant = journal.fixtures.grant(this.runId, request.controlVersion, {
          fixtureId: request.fixtureId,
          operations: request.operations,
          binding,
          expiresAt: request.expiresAt,
        });
        return `Grant ${grant.grantId} recorded for ${grant.fixtureId}, expiring ${grant.expiresAt}. No database mutation or test-service access occurred.`;
      }
      case "revoke_fixture":
        journal.fixtures.revoke(this.runId, request.controlVersion, request.grantId);
        return "Fixture grant revoked. No resource was removed; a stop request is not proof that in-flight I/O stopped.";
      case "grant_sql": {
        const definition = journal.fixtures.definition(this.runId, request.fixtureId);
        const policy = journal.fixtures.validation.policy(this.runId, request.fixtureId);
        const binding = await bindFixtureProvider(definition, resolve(request.psqlPath));
        signal?.throwIfAborted();
        const pgbouncer = await bindFixtureExecutable(policy.pgbouncerExecutable);
        signal?.throwIfAborted();
        const grant = journal.fixtures.validation.grant(this.runId, request.controlVersion, {
          fixtureId: request.fixtureId,
          binding,
          pgbouncer,
          expiresAt: request.expiresAt,
        });
        return `SQL-access grant ${grant.grantId} recorded; no server query or adoption occurred. Runtime still requires owned creation and restricted-role checks.`;
      }
      case "revoke_sql":
        journal.fixtures.validation.revoke(this.runId, request.controlVersion, request.grantId);
        return "SQL access revoked. Resource exclusions remain until local and remote stop are proven.";
      case "handoff": {
        const state = await handoffRuntime(
          this.store,
          this.runId,
          {
            runtime: request.runtime,
            controlVersion: request.controlVersion,
            ...(request.codexPath ? { codexPath: request.codexPath } : {}),
            ...(request.herdrPath ? { herdrPath: request.herdrPath } : {}),
            ...(request.retainCoordinatorSession ? { retainCoordinatorSession: true } : {}),
          },
          signal,
        );
        return `Runtime ${state.runtime} recorded. ${request.retainCoordinatorSession ? "The stopped coordinator conversation is reserved for one replacement generation." : "Stopped conversations are retired."} Evidence, memory, budgets and resources are retained. No model started and no pending question was answered. Inspect status, then resume this run.`;
      }
    }
  }
}
