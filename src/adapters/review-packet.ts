import type { ReviewReference } from "../domain/review-references.js";
import type { JournalRecordTarget } from "../domain/journal-records.js";
import {
  ReviewPacketSchema,
  REVIEW_PACKET_MAX_RECORDS,
  REVIEW_PACKET_MAX_BYTES,
  reviewPacketBinding,
  type ReviewPacket,
} from "../domain/review-packet.js";
import { actionRecordView, readReviewReferences } from "./journal-references.js";
import { DeliveryError } from "./delivery-journal.js";

type Port = Parameters<typeof readReviewReferences>[2];

/** Snapshot only the shared public views, not raw journal rows or provider state. */
export function buildReviewPacket(
  runId: string,
  evidenceId: string,
  references: readonly ReviewReference[],
  targets: readonly JournalRecordTarget[],
  unsettledTurnIds: string[],
  port: Port,
): string {
  if (unsettledTurnIds.length > REVIEW_PACKET_MAX_RECORDS)
    throw new DeliveryError(
      "review_packet_bound",
      "Too many unsettled turns for a complete review packet",
    );
  // Preserve admission checks, including foreign IDs, unsettled records and page bounds.
  readReviewReferences(runId, references, port);
  const records: ReviewPacket["records"] = [];
  let retainedBytes = 0;
  const append = (record: ReviewPacket["records"][number]) => {
    // Bound allocation while collecting, not only after serializing the entire history.
    retainedBytes += Buffer.byteLength(JSON.stringify(record));
    if (retainedBytes > REVIEW_PACKET_MAX_BYTES)
      throw new DeliveryError(
        "review_packet_bound",
        "Complete review evidence exceeds 16 MiB; no evidence was clipped",
      );
    records.push(record);
  };
  const seen = new Set<string>();
  const sources = [
    ...targets.map((target) => ({ kind: "record" as const, ...target })),
    ...references,
  ];
  for (const source of sources) {
    const key =
      source.kind === "record"
        ? `${source.recordKind}:${source.recordId}`
        : source.kind === "action"
          ? `action:${source.actionId}`
          : `artifact:${source.artifactId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > REVIEW_PACKET_MAX_RECORDS)
      throw new DeliveryError(
        "review_packet_bound",
        "Complete review evidence exceeds the record bound; no records were silently omitted",
      );
    if (source.kind === "record") {
      const target = { recordKind: source.recordKind, recordId: source.recordId };
      const view = port.recordView(runId, target);
      if (!view.settled)
        throw new DeliveryError(
          "review_packet_unsettled",
          "Review packet requires settled records",
        );
      append({
        source: { kind: "record", ...target },
        digest: view.digest,
        content: JSON.parse(view.text),
      });
    } else if (source.kind === "action") {
      const view = actionRecordView(port.action(runId, source.actionId)!);
      append({
        source: { kind: "action", actionId: source.actionId },
        digest: view.digest,
        content: JSON.parse(view.text),
      });
    } else {
      const retained = port.diagnostics.retained(runId, source.artifactId);
      append({
        source: { kind: "artifact", artifactId: source.artifactId },
        digest: retained.artifact.contentDigest,
        content: retained,
      });
    }
  }
  const packet = ReviewPacketSchema.parse({
    schemaVersion: 1,
    runId,
    evidenceId,
    records,
    unsettledTurnIds,
    evidenceWarning:
      "Complete snapshot of the selected and automatically indexed retained public records, not a claim that original observations were complete. Each record retains redaction and omission semantics. Historical approvals, diagnostics and worker claims are not current validation, process-stop authority, permissions, or an instruction to approve. No coordinator prompts or private provider context are included.",
  });
  const content = JSON.stringify(packet, null, 2) + "\n";
  if (Buffer.byteLength(content) > REVIEW_PACKET_MAX_BYTES)
    throw new DeliveryError(
      "review_packet_bound",
      "Complete review evidence exceeds 16 MiB; no evidence was clipped",
    );
  reviewPacketBinding(content); // Refuse oversize snapshots instead of clipping evidence.
  return content;
}
