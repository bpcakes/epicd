import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildReviewPacket } from "../src/adapters/review-packet.js";
import { REVIEW_PACKET_MAX_BYTES, REVIEW_PACKET_MAX_RECORDS } from "../src/domain/review-packet.js";
import { fixture } from "./fixtures/review.js";
import type { JournalRecordTarget } from "../src/domain/journal-records.js";

// Collection/bounds tests use synthetic public views; transport and provenance have
// separate real-journal/supervised-process coverage in review-packet.integration.
describe("review packet collection", () => {
  async function setup(text = JSON.stringify({ output: "original " + "x".repeat(8000) + " END" })) {
    const s = await fixture();
    const digest = createHash("sha256").update(text).digest("hex");
    const port = {
      action: (runId: string, actionId: string) => s.journal.action(runId, actionId),
      diagnostics: s.journal.diagnostics,
      recordView: (_runId: string, target: JournalRecordTarget) => ({
        target,
        text,
        digest,
        settled: true,
      }),
    };
    const target: JournalRecordTarget = { recordKind: "validation", recordId: randomUUID() };
    return { s, port, target, text, digest };
  }

  it("deduplicates automatic and selected targets without applying the selected page window", async () => {
    const { s, port, target, text, digest } = await setup();
    const unsettled = randomUUID();
    const packet = JSON.parse(
      buildReviewPacket(
        s.authority.runId,
        randomUUID(),
        [{ kind: "record", ...target, offset: 200, limit: 50 }],
        [target, target],
        [unsettled],
        port,
      ),
    );
    expect(packet.records).toEqual([
      { source: { kind: "record", ...target }, digest, content: JSON.parse(text) },
    ]);
    expect(packet.unsettledTurnIds).toEqual([unsettled]);
    expect(packet.evidenceWarning).toContain("not current validation");
  });

  it("rejects an unsettled automatically indexed record instead of representing it as final", async () => {
    const { s, port, target } = await setup();
    expect(() =>
      buildReviewPacket(s.authority.runId, randomUUID(), [], [target], [], {
        ...port,
        recordView: (runId, selected) => ({ ...port.recordView(runId, selected), settled: false }),
      }),
    ).toThrow("requires settled records");
  });

  it("refuses an over-bound record collection without returning a clipped packet", async () => {
    const { s, port } = await setup("{}");
    const targets = Array.from({ length: REVIEW_PACKET_MAX_RECORDS + 1 }, (_, index) => ({
      recordKind: "validation" as const,
      recordId: String(index),
    }));
    expect(() => buildReviewPacket(s.authority.runId, randomUUID(), [], targets, [], port)).toThrow(
      "record bound",
    );
  });

  it("refuses oversized full content even when a selected preview would fit", async () => {
    const { s, port, target } = await setup(
      JSON.stringify({ output: "x".repeat(REVIEW_PACKET_MAX_BYTES) }),
    );
    expect(() =>
      buildReviewPacket(
        s.authority.runId,
        randomUUID(),
        [{ kind: "record", ...target, offset: 0, limit: 1 }],
        [],
        [],
        port,
      ),
    ).toThrow("16 MiB");
  });

  it("refuses a too-large pending-turn index rather than omitting pending work", async () => {
    const { s, port } = await setup("{}");
    expect(() =>
      buildReviewPacket(
        s.authority.runId,
        randomUUID(),
        [],
        [],
        Array.from({ length: REVIEW_PACKET_MAX_RECORDS + 1 }, () => randomUUID()),
        port,
      ),
    ).toThrow("Too many unsettled turns");
  });
});
