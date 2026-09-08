import { z } from "zod";
import { FixtureExecutableSchema, FixtureProviderBindingSchema } from "./fixtures.js";
import {
  CommandLifetimeSchema,
  CommandStopSchema,
  type CommandLifetime,
  assertCommandStop,
} from "./command-lifetime.js";
import { digestJson } from "./repository-policy.js";

const Id = z.string().min(1).max(256);
const Oid = z.string().regex(/^\d{1,10}$/);
export const FixtureValidationGrantSchema = z.strictObject({
  schemaVersion: z.literal(1),
  grantId: z.uuid(),
  runId: Id,
  fixtureId: Id,
  policyDigest: Id,
  definitionDigest: Id,
  binding: FixtureProviderBindingSchema,
  pgbouncer: FixtureExecutableSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type FixtureValidationGrant = z.infer<typeof FixtureValidationGrantSchema>;

export const FixtureValidationObservationSchema = z.strictObject({
  observerRole: Id,
  database: z.strictObject({
    oid: Oid,
    name: Id,
    owner: Id,
    marker: z.string().max(256).nullable(),
    allowConnections: z.boolean(),
  }),
  role: z
    .strictObject({
      oid: Oid,
      name: Id,
      login: z.boolean(),
      superuser: z.boolean(),
      createDatabase: z.boolean(),
      createRole: z.boolean(),
      replication: z.boolean(),
      bypassRls: z.boolean(),
      memberships: z.boolean(),
      externalDependencies: z.boolean(),
      parameterPrivileges: z.boolean(),
      unsafeFunctions: z.boolean(),
      foreignDataAccess: z.boolean(),
      eventTriggers: z.boolean(),
    })
    .nullable(),
  otherConnections: z.number().int().nonnegative(),
});
export type FixtureValidationObservation = z.infer<typeof FixtureValidationObservationSchema>;

export const FixtureValidationUseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    accessId: z.uuid(),
    runId: Id,
    fixtureId: Id,
    evidenceId: Id,
    operationId: Id,
    controllerLeaseId: Id,
    creationId: z.uuid(),
    generation: z.number().int().positive(),
    databaseOid: Oid,
    marker: Id,
    grantId: z.uuid(),
    policyDigest: Id,
    definitionDigest: Id,
    binding: FixtureProviderBindingSchema,
    pgbouncer: FixtureExecutableSchema,
    status: z.enum(["reserved", "dispatched", "stopped", "not_started"]),
    preflight: FixtureValidationObservationSchema.nullable(),
    finalObservation: FixtureValidationObservationSchema.nullable(),
    localStopped: z.boolean(),
    localCommand: CommandLifetimeSchema.nullable(),
    localReceipt: CommandStopSchema.nullable(),
    localWorkerStop: z
      .strictObject({
        operationId: z.uuid(),
        execution: CommandLifetimeSchema,
        receipt: CommandStopSchema,
      })
      .nullable(),
    remoteStopped: z.boolean(),
    detail: z.string().max(4000).nullable(),
    createdAt: z.iso.datetime(),
  })
  .superRefine((use, context) => {
    if (
      (["dispatched", "stopped"].includes(use.status) && !use.localCommand) ||
      (use.status === "reserved" && use.localCommand !== null) ||
      (use.localReceipt !== null && (!use.localCommand || !use.localStopped)) ||
      (use.localCommand && use.localStopped && !use.localReceipt && !use.localWorkerStop) ||
      (use.localWorkerStop !== null &&
        (!use.localCommand ||
          !use.localStopped ||
          use.localWorkerStop.execution.runId !== use.runId ||
          use.localWorkerStop.execution.operationId !== use.localWorkerStop.operationId ||
          use.localWorkerStop.execution.controllerLeaseId !== use.controllerLeaseId ||
          use.localWorkerStop.receipt.kind !== "stopped")) ||
      (use.localReceipt?.kind === "not_started" && use.status !== "not_started") ||
      (use.localCommand &&
        use.status === "not_started" &&
        use.localReceipt?.kind !== "not_started") ||
      (use.localCommand &&
        (use.localCommand.runId !== use.runId ||
          use.localCommand.operationId !== use.operationId ||
          use.localCommand.controllerLeaseId !== use.controllerLeaseId))
    )
      context.addIssue({
        code: "custom",
        message: "Fixture command lifetime and local stop proof disagree",
      });
    if (use.localReceipt && use.localCommand) {
      try {
        assertCommandStop(use.localCommand, use.localReceipt);
      } catch {
        context.addIssue({
          code: "custom",
          message: "Fixture stop receipt differs from its command intent",
        });
      }
    }
    if (use.localWorkerStop) {
      try {
        assertCommandStop(use.localWorkerStop.execution, use.localWorkerStop.receipt);
      } catch {
        context.addIssue({
          code: "custom",
          message: "Enclosing validation worker stop differs from its launch intent",
        });
      }
    }
    const valid =
      use.status === "reserved"
        ? !use.localStopped && !use.remoteStopped && use.finalObservation === null
        : use.status === "dispatched"
          ? !use.remoteStopped &&
            use.preflight !== null &&
            (use.finalObservation === null || use.localStopped)
          : use.status === "stopped"
            ? use.localStopped &&
              use.remoteStopped &&
              use.preflight !== null &&
              use.finalObservation !== null
            : use.localStopped && use.remoteStopped && use.finalObservation === null;
    if (!valid)
      context.addIssue({
        code: "custom",
        message: "Fixture access status contradicts its stop evidence",
      });
  });
export type FixtureValidationUse = z.infer<typeof FixtureValidationUseSchema>;

/** Immutable SQL provenance only; admission/settlement never changes the command's scope. */
export function fixtureCommandScope(uses: readonly FixtureValidationUse[]): string {
  return digestJson(
    uses
      .map((use) => ({
        accessId: use.accessId,
        runId: use.runId,
        evidenceId: use.evidenceId,
        operationId: use.operationId,
        controllerLeaseId: use.controllerLeaseId,
        fixtureId: use.fixtureId,
        creationId: use.creationId,
        generation: use.generation,
        databaseOid: use.databaseOid,
        marker: use.marker,
        grantId: use.grantId,
        policyDigest: use.policyDigest,
        definitionDigest: use.definitionDigest,
        binding: use.binding,
        pgbouncer: use.pgbouncer,
      }))
      .sort((a, b) => a.accessId.localeCompare(b.accessId)),
  );
}

export function commandOwnsFixtureUses(
  intent: CommandLifetime,
  uses: readonly FixtureValidationUse[],
) {
  return (
    uses.length > 0 &&
    uses.every(
      (use) =>
        use.runId === intent.runId &&
        use.operationId === intent.operationId &&
        use.controllerLeaseId === intent.controllerLeaseId,
    ) &&
    intent.scopeDigest === fixtureCommandScope(uses)
  );
}
