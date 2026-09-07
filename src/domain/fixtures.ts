import { z } from "zod";

export const FixtureOperationSchema = z.enum(["inspect", "create", "reset", "cleanup"]);
export type FixtureOperation = z.infer<typeof FixtureOperationSchema>;
const NodeIdentity = z.strictObject({
  path: z.string().startsWith("/").max(4096),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
export const FixtureProviderBindingSchema = z.strictObject({
  executable: NodeIdentity.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) }),
  directory: NodeIdentity,
  socket: NodeIdentity.nullable(),
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
