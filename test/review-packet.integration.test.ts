import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { fixture, success, target, resource, check } from "./fixtures/review.js";
import { closureFixture, publishVerified } from "./fixtures/tracker-closure.js";
import { journalRecordView } from "../src/adapters/journal-records.js";
import { digestJson } from "../src/domain/repository-policy.js";

// Scripted judgment, real SQLite, private Git copy and supervised process mounts.
// This is a transport/provenance regression, not a model-competence acceptance test.
describe.runIf(process.platform === "linux")("complete read-only review evidence", () => {
  it("delivers full selected history and current validation outside the prompt and source", async () => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    const copy = await s.copy(candidate);
    await s.validate(candidate, copy);
    const artifact = s.journal.diagnostics.append(
      s.authority,
      {
        source: "packet-regression",
        sourceEventId: randomUUID(),
        kind: "command.output",
        summary: "Original retained diagnostic",
        identity: null,
        wakesOrchestrator: true,
      },
      "password=do-not-disclose\n" + "z".repeat(16000) + "\nORIGINAL-TAIL",
      true,
    ).artifact;
    s.kernel.registerLocal("inspect_fixture", () => ({
      kind: "inspection",
      text: "x".repeat(12000) + "ACTION-TAIL",
      artifactIds: [],
    }));
    const action = await s.dispatch({ kind: "inspect_fixture", fixtureId: "history" });
    success(action);
    s.response(s.report(candidate), [
      'cat /epicd-evidence/review.json > "$CODEX_HOME/received-evidence.json"',
      'if printf tampered >> /epicd-evidence/review.json; then touch "$CODEX_HOME/evidence-writable"; fi',
      'if test -r /epicd-evidence/launch.json; then touch "$CODEX_HOME/control-exposed"; fi',
    ]);
    success(
      await s.dispatch({
        kind: "run_review",
        ...candidate,
        ...target(copy),
        agent: null,
        instructions: "Independently assess all criteria; history is not an approval.",
        references: [
          { kind: "artifact", artifactId: artifact.artifactId, offset: 10, limit: 100 },
          { kind: "action", actionId: action.actionId, offset: 10, limit: 100 },
        ],
      }),
    );
    const review = s.journal.reviews.records(s.authority.runId).at(-1)!;
    const turn = s.journal.agents.turn(s.authority.runId, review.turnIdentity!);
    const provider = turn.launch!.manifest.confinement.providerHome;
    const text = readFileSync(join(provider, "received-evidence.json"), "utf8");
    // Baseline reaches this assertion with an empty file: no packet is mounted.
    expect(text).toContain("ORIGINAL-TAIL");
    expect(text).toContain("ACTION-TAIL");
    expect(text).not.toContain("do-not-disclose");
    const packet = JSON.parse(text);
    const context = turn.prompt.reviewContext as Record<string, unknown>;
    expect(context.primaryEvidence).toMatchObject({
      path: "/epicd-evidence/review.json",
      digest: createHash("sha256").update(text).digest("hex"),
      byteLength: Buffer.byteLength(text),
      recordCount: 3,
    });
    expect(packet).toMatchObject({ runId: s.authority.runId, evidenceId: review.evidenceId });
    const diagnostic = packet.records.find(
      (entry: { source: { kind: string } }) => entry.source.kind === "artifact",
    );
    expect(diagnostic.content.artifact.sourceTruncated).toBe(true);
    const validation = packet.records.find(
      (entry: { source: { recordKind?: string } }) => entry.source.recordKind === "validation",
    );
    expect(validation.content.record.evidenceId).toBe(review.validationEvidenceIds[0]);
    expect(validation.content.record.outcome.status).toBe("succeeded");
    expect(validation.content.record.io.settled).toBe(true);
    expect(JSON.stringify(context)).not.toContain("ORIGINAL-TAIL");
    expect(JSON.stringify(context)).not.toContain("ACTION-TAIL");
    expect(existsSync(join(provider, "evidence-writable"))).toBe(false);
    expect(existsSync(join(provider, "control-exposed"))).toBe(false);
    expect(existsSync(join(copy.path, "review.json"))).toBe(false);
    expect(review.sourceIntact).toBe(true);
    expect(s.journal.reviews.approval(s.authority.runId, candidate, "pre_commit")).toBe(
      review.evidenceId,
    );
    const reopened = s.reopen();
    expect(
      reopened.orchestration.reviews.approval(s.authority.runId, candidate, "pre_commit"),
    ).toBe(review.evidenceId);
  }, 30000);

  it("retains an isolated historical worker turn as redacted ineligible review evidence", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    const previous = await s.review(candidate);
    success(previous.result);
    const identity = previous.evidence.turnIdentity!;
    const db = new Database(s.path);
    const row = db
      .prepare(
        "SELECT record_json FROM agent_instances WHERE run_id=? AND agent_id=? AND generation=?",
      )
      .get(run, identity.agentId, identity.agentGeneration) as { record_json: string };
    const owner = JSON.parse(row.record_json);
    const update = (record: string) =>
      db
        .prepare(
          "UPDATE agent_instances SET record_json=? WHERE run_id=? AND agent_id=? AND generation=?",
        )
        .run(record, run, identity.agentId, identity.agentGeneration);
    try {
      update(JSON.stringify({ ...owner, schemaVersion: 1 }));
      expect(s.journal.agents.ownershipAssessment(run, identity).state).toBe("isolated");

      const reviewed = await s.review(candidate, {}, [
        'cat /epicd-evidence/review.json > "$CODEX_HOME/received-evidence.json"',
      ]);
      success(reviewed.result);
      const turn = s.journal.agents.turn(run, reviewed.evidence.turnIdentity!);
      const packet = JSON.parse(
        readFileSync(
          join(turn.launch!.manifest.confinement.providerHome, "received-evidence.json"),
          "utf8",
        ),
      );
      const retained = packet.records.find(
        (entry: { source: { recordKind?: string; recordId?: string } }) =>
          entry.source.recordKind === "agent_turn" && entry.source.recordId === identity.turnId,
      );
      expect(retained?.content.record).toMatchObject({
        identity,
        role: null,
        ownerIntegrity: "isolated",
        status: "completed",
        resultEligible: false,
      });
      expect(retained?.content.record).not.toHaveProperty("prompt");
      expect(retained?.content.record).not.toHaveProperty("launch");
      expect(s.journal.reviews.records(run).at(-1)).toMatchObject({
        evidenceId: reviewed.evidence.evidenceId,
        status: "finished",
        sourceIntact: true,
      });
    } finally {
      update(row.record_json);
      db.close();
    }
  }, 30000);

  it("automatically supplies full descendant closure proof to final review without historical validation becoming current", async () => {
    const s = await closureFixture("sha1", true, "preclosed");
    const run = s.authority.runId;
    const { commit } = await publishVerified(s);
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: s.taskId,
        transition: "close_task",
        revision: commit.revision!,
      }),
    );
    const { stage: _stage, ...command } = check;
    const planId = resource(
      await s.dispatch({
        kind: "define_validation_plan",
        taskId: "demo",
        acceptanceCriteria: ["All descendant requirements hold at the published revision"],
        checks: [command],
      }),
    ).resourceId;
    const prepared = resource(
      await s.dispatch({
        kind: "prepare_epic_delivery",
        publicationId: s.journal.publications.repository(run)!.lastPublishedId!,
        trackerSnapshotId: s.journal.tracker.snapshot(run).snapshotId,
        validationPlanId: planId,
      }),
    );
    const candidate = {
      candidateId: prepared.resourceId,
      candidateGeneration: prepared.generation,
    };
    const copy = await s.copy(candidate, commit.revision);
    await s.validate(candidate, copy);
    const reviewed = await s.review(
      candidate,
      {},
      ['cat /epicd-evidence/review.json > "$CODEX_HOME/received-evidence.json"'],
      commit.revision,
    );
    success(reviewed.result);
    const turn = s.journal.agents.turn(run, reviewed.evidence.turnIdentity!);
    const packet = JSON.parse(
      readFileSync(
        join(turn.launch!.manifest.confinement.providerHome, "received-evidence.json"),
        "utf8",
      ),
    );
    const context = s.journal.delivery.epicReviewContext(run, candidate)!;
    expect(context.preexistingClosedTaskIds).toEqual(["demo.2"]);
    for (const source of context.closedTasks.flatMap((task) => task.historicalRecords)) {
      const expected = journalRecordView(s.journal, run, source);
      const actual = packet.records.find(
        (entry: { source: { recordId?: string } }) => entry.source.recordId === source.recordId,
      );
      expect(actual, source.recordId).toEqual({
        source: { kind: "record", ...source },
        digest: expected.digest,
        content: JSON.parse(expected.text),
      });
      if (source.recordKind === "validation")
        expect(reviewed.evidence.validationEvidenceIds).not.toContain(source.recordId);
    }
    const priorReview = s.journal.reviews.records(run, s.taskId)[0]!;
    const originalTurn = s.journal.agents.turn(run, priorReview.turnIdentity!);
    const worker = packet.records.find(
      (entry: { source: { recordId?: string } }) =>
        entry.source.recordId === originalTurn.identity.turnId,
    );
    expect(worker.content.record.result).toEqual(originalTurn.result);
    expect(worker.content.record).not.toHaveProperty("prompt");
    expect(worker.content.record).not.toHaveProperty("launch");
    expect(s.journal.reviews.approval(run, candidate, "exact_revision")).toBe(
      reviewed.evidence.evidenceId,
    );
    expect(JSON.stringify(turn.prompt.reviewContext)).not.toContain('"status":"passed"');
  }, 30000);

  it("preserves the raw packet in quarantine before removing active run rows", async () => {
    const s = await fixture();
    const candidate = await s.capture(await s.define());
    const { result } = await s.review(candidate);
    success(result);
    const db = new Database(s.path);
    try {
      const original = db.prepare("SELECT * FROM review_packets").get();
      expect(original).toBeDefined();
      s.store.releaseLease(s.authority.runId, s.authority.ownerToken);
      db.prepare("UPDATE runs SET state_json = 'broken' WHERE run_id = ?").run(s.authority.runId);
      s.store.quarantineInvalidRun(s.authority.runId);
      const preserved = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id = ? AND source_table = 'review_packets'",
        )
        .get(s.authority.runId) as { row_json: string };
      expect(JSON.parse(preserved.row_json)).toEqual(original);
      expect(db.prepare("SELECT * FROM review_packets").all()).toEqual([]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  }, 30000);

  it.each(["packet", "prompt", "launch"] as const)(
    "rejects approval after %s tampering despite a passing report",
    async (variant) => {
      const s = await fixture();
      const run = s.authority.runId;
      const candidate = await s.capture(await s.define());
      await s.validate(candidate, await s.copy(candidate));
      const { evidence, result } = await s.review(candidate);
      success(result);
      expect(s.journal.reviews.approval(run, candidate)).toBe(evidence.evidenceId);
      const db = new Database(s.path);
      try {
        if (variant === "packet") {
          db.prepare(
            "UPDATE review_packets SET content = replace(content, 'succeeded', 'cancelled') WHERE evidence_id = ?",
          ).run(evidence.evidenceId);
          expect(() => s.journal.reviews.approval(run, candidate)).toThrow("integrity check");
        } else {
          const turn = s.journal.agents.turn(run, evidence.turnIdentity!);
          if (variant === "prompt") {
            const context = turn.prompt.reviewContext;
            if (!context || typeof context !== "object" || Array.isArray(context))
              throw new Error("Missing context");
            turn.prompt.reviewContext = { ...context, primaryEvidence: { path: "/unrelated" } };
            turn.promptDigest = digestJson(turn.prompt);
          } else {
            turn.launch!.manifest.reviewPacket = null;
            turn.launch!.manifestDigest = digestJson(turn.launch!.manifest);
          }
          db.prepare("UPDATE agent_turns SET record_json = ? WHERE turn_id = ?").run(
            JSON.stringify(turn),
            turn.identity.turnId,
          );
          expect(s.journal.reviews.approval(run, candidate)).toBeNull();
        }
      } finally {
        db.close();
      }
    },
    30000,
  );
});
