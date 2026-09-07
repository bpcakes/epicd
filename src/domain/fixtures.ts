import { z } from "zod";

export const FixtureOperationSchema = z.enum(["inspect", "create", "reset", "cleanup"]);
export type FixtureOperation = z.infer<typeof FixtureOperationSchema>;
const NodeIdentity = z.strictObject({
  path: z.string().startsWith("/").max(4096),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
export const FixtureExecutableSchema = NodeIdentity.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const FixtureProviderBindingSchema = z.strictObject({
  executable: FixtureExecutableSchema,
  directory: NodeIdentity,
  socket: NodeIdentity.extend({ changeTimeNs: z.string().regex(/^\d+$/) }).nullable(),
});
export type FixtureProviderBinding = z.infer<typeof FixtureProviderBindingSchema>;
export const FixtureGrantSchema = z.strictObject({
  schemaVersion: z.literal(1),
  grantId: z.uuid(),
  runId: z.string().min(1),
  fixtureId: z.string().min(1).max(256),
  policyDigest: z.string(),
  definitionDigest: z.string(),
  binding: FixtureProviderBindingSchema,
  operations: z.array(FixtureOperationSchema).min(1).max(4),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type FixtureGrant = z.infer<typeof FixtureGrantSchema>;

export const FixtureCatalogSchema = z.strictObject({
  serverVersion: z.string().max(12).regex(/^\d+$/),
  role: z.string().min(1).max(63),
  maintenanceDatabase: z.literal("postgres"),
  roleCanCreateDatabase: z.boolean(),
  roleIsSuperuser: z.boolean(),
  database: z
    .strictObject({
      oid: z.string().max(10).regex(/^\d+$/),
      name: z.string().min(1).max(63),
      owner: z.string().min(1).max(63),
      canConnect: z.boolean(),
    })
    .nullable(),
});
export type FixtureCatalog = z.infer<typeof FixtureCatalogSchema>;

export const FixtureBackendSchema = z.strictObject({
  pid: z.number().int().positive(),
  startedAt: z.string().regex(/^\d{1,20}(\.\d{1,6})?$/),
});
export type FixtureBackend = z.infer<typeof FixtureBackendSchema>;
export const FixtureCreationObservationSchema = z.strictObject({
  backendStopped: z.boolean(),
  database: z
    .strictObject({
      oid: z.string().max(10).regex(/^\d+$/),
      name: z.string().min(1).max(63),
      owner: z.string().min(1).max(63),
      markerMatches: z.boolean(),
      allowConnections: z.boolean(),
    })
    .nullable(),
});
export type FixtureCreationObservation = z.infer<typeof FixtureCreationObservationSchema>;
export const FixtureCreationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  creationId: z.uuid(),
  runId: z.string().min(1),
  fixtureId: z.string().min(1).max(256),
  operationId: z.string().min(1),
  generation: z.number().int().positive(),
  policyDigest: z.string(),
  definitionDigest: z.string(),
  grantId: z.uuid(),
  binding: FixtureProviderBindingSchema,
  plannedOid: z.number().int().min(16384).max(4294967295),
  marker: z.string().min(1).max(256),
  alias: z.string().regex(/^epicd_lock_[a-f0-9]{32}$/),
  controllerLeaseId: z.string(),
  status: z.enum(["reserved", "dispatching", "owned", "not_created", "uncertain"]),
  backend: FixtureBackendSchema.nullable(),
  clientStopEvidence: z.string().max(4000).nullable(),
  observation: FixtureCreationObservationSchema.nullable(),
  detail: z.string().max(4000).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type FixtureCreation = z.infer<typeof FixtureCreationSchema>;
