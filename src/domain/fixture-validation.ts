import { z } from "zod";
import { FixtureExecutableSchema, FixtureProviderBindingSchema } from "./fixtures.js";

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
    remoteStopped: z.boolean(),
    detail: z.string().max(4000).nullable(),
    createdAt: z.iso.datetime(),
  })
  .superRefine((use, context) => {
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
