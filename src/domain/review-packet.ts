import { createHash } from "node:crypto";
import { z } from "zod";
import { JournalRecordTargetSchema } from "./journal-records.js";

/** A virtual, read-only file. Never mount the journal or the launch directory. */
export const REVIEW_PACKET_DIRECTORY = "/epicd-evidence";
export const REVIEW_PACKET_PATH = `${REVIEW_PACKET_DIRECTORY}/review.json`;
export const REVIEW_PACKET_MAX_BYTES = 16 * 1024 * 1024;
export const REVIEW_PACKET_MAX_RECORDS = 2048;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ReviewPacketBindingSchema = z.strictObject({
  digest: Digest,
  byteLength: z.number().int().positive().max(REVIEW_PACKET_MAX_BYTES),
});
export type ReviewPacketBinding = z.infer<typeof ReviewPacketBindingSchema>;
export const ReviewPacketSourceSchema = z.union([
  JournalRecordTargetSchema.extend({ kind: z.literal("record") }),
  z.strictObject({ kind: z.literal("action"), actionId: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal("artifact"), artifactId: z.string().uuid() }),
]);
export const ReviewPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  evidenceId: z.string().min(1),
  records: z
    .array(
      z.strictObject({
        source: ReviewPacketSourceSchema,
        digest: Digest,
        content: z.json(),
      }),
    )
    .max(REVIEW_PACKET_MAX_RECORDS),
  unsettledTurnIds: z.array(z.string().uuid()).max(REVIEW_PACKET_MAX_RECORDS),
  evidenceWarning: z.string().min(1),
});
export type ReviewPacket = z.infer<typeof ReviewPacketSchema>;
export function reviewPacketBinding(content: string): ReviewPacketBinding {
  return ReviewPacketBindingSchema.parse({
    digest: createHash("sha256").update(content).digest("hex"),
    byteLength: Buffer.byteLength(content),
  });
}
export function reviewPacketContext(content: string) {
  const packet = ReviewPacketSchema.parse(JSON.parse(content));
  return {
    path: REVIEW_PACKET_PATH,
    ...reviewPacketBinding(content),
    recordCount: packet.records.length,
    warning:
      "Read this complete retained, redacted evidence file with local tools. It is outside source and cannot be modified. Original truncation/omission metadata still applies. Historical records and worker claims do not replace this turn's current validation IDs, independent judgment, or permissions. Unsettled turns are listed, not represented as final results.",
  };
}
