import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { OrchestrationJournal } from "../src/adapters/orchestration-journal.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import { SdkAgentSessionContractSchema } from "../src/domain/types.js";
import { fixture, target } from "./fixtures/review.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

// The same test must compile on the baseline where this new boundary is absent.
// Absence is a failing contract check, never an uncached production fallback.
function snapshot<T>(journal: OrchestrationJournal, read: () => T): T {
  const boundary = journal as unknown as { readSnapshot?: (read: () => T) => T };
  if (!boundary.readSnapshot) throw new Error("Missing synchronous journal read snapshot");
  return boundary.readSnapshot(read);
}

async function history(f: Fixture, count = 1) {
  const workspace = await f.manager.create(f.authority, f.source, f.head, "diagnostic");
  const settings = { model: "worker-model", reasoningEffort: "high" as const };
  const agent = f.journal.agents.reserveAgent(
    f.authority,
    {
      ...target(workspace),
      role: "implementation",
      purpose: "specialist",
      taskId: f.taskId,
      candidateId: null,
      instructions: "Inspect the snapshot fixture without changing application source",
      confinementProfile: "test-only-supervisor",
      contract: SdkAgentSessionContractSchema.parse({
        runtime: "sdk",
        requested: settings,
        effective: settings,
      }),
    },
    f.journal.control(f.authority.runId).controlVersion,
  );
  const prepare = () => {
    const turn = f.journal.agents.prepareTurn(
      f.authority,
      agent,
      randomUUID(),
      "Retained diagnostic context. ".repeat(400),
      { type: "object" },
      f.journal.control(f.authority.runId).controlVersion,
    );
    return f.journal.agents.cancelPreparedTurn(f.authority, turn.identity);
  };
  const turns = Array.from({ length: count }, prepare);
  return { turns, prepare };
}

function readJournal(f: Fixture, verbose?: (message: unknown) => void) {
  const db = new Database(f.path, verbose ? { verbose } : {});
  // A real separate connection, with the owning store checking the current physical identity.
  const journal = new OrchestrationJournal(db, () => f.store.storageIdentity());
  return { db, journal };
}

describe("consistent journal read snapshots", () => {
  it("builds the public context without decoding complete turn history for every predicate", async () => {
    const f = await fixture();
    const plan = await f.define();
    const candidate = await f.capture(plan);
    await f.validate(candidate, await f.copy(candidate));
    const retained = await history(f, 24);
    let fullHistoryReads = 0;
    const { db, journal } = readJournal(f, (message) => {
      if (
        typeof message === "string" &&
        message.includes("SELECT record_json FROM agent_turns WHERE run_id =") &&
        message.includes("ORDER BY rowid")
      )
        fullHistoryReads += 1;
    });
    try {
      const context = buildOrchestratorContext(new ActionKernel(journal), f.authority.runId);
      expect(context.delivery.candidates).toContainEqual(
        expect.objectContaining({
          candidateId: candidate.candidateId,
          current: true,
        }),
      );
      expect(context.delivery.validation).toContainEqual(
        expect.objectContaining({
          candidateId: candidate.candidateId,
          satisfiesCheck: true,
          status: "succeeded",
        }),
      );
      expect(context.control).toEqual(f.journal.control(f.authority.runId));
      expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(65536);
      // Work-count regression is paired with actual safety facts above, not a mocked result.
      expect(fullHistoryReads).toBe(1);
      expect(journal.agents.turns(f.authority.runId)).toEqual(retained.turns);
      expect(fullHistoryReads).toBe(2); // An ordinary subsequent read is fresh.
    } finally {
      db.close();
    }
  });

  it("reuses only immutable validated records inside the current snapshot", async () => {
    const f = await fixture();
    const retained = await history(f);
    const { db, journal } = readJournal(f);
    try {
      const before = journal.agents.turns(f.authority.runId);
      const view = snapshot(journal, () => {
        const turns = journal.agents.turns(f.authority.runId);
        expect(journal.agents.turns(f.authority.runId)).toBe(turns);
        expect(turns).toEqual(before);
        expect(Object.isFrozen(turns)).toBe(true);
        expect(Object.isFrozen(turns[0]!.prompt.identity)).toBe(true);
        expect(() => {
          turns[0]!.prompt.instructions = "forged";
        }).toThrow(TypeError);
        expect(() => turns.pop()).toThrow(TypeError);
        expect(journal.agents.turns("another-run")).toEqual([]);
        expect(journal.agents.turns(f.authority.runId)).toEqual(before);
        return turns;
      });
      expect(journal.agents.turns(f.authority.runId)).not.toBe(view);
      retained.prepare();
      expect(snapshot(journal, () => journal.agents.turns(f.authority.runId))).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("refuses journal mutations and restores write access after the read completes", async () => {
    const f = await fixture();
    const { db, journal } = readJournal(f);
    const observation = {
      source: "test",
      sourceEventId: randomUUID(),
      kind: "read-snapshot-test",
      summary: "A genuine observation after read-only inspection",
      artifactIds: [],
      identity: null,
      wakesOrchestrator: false,
    };
    try {
      const before = journal.latestObservationCursor(f.authority.runId);
      snapshot(journal, () => {
        expect(db.inTransaction).toBe(true);
        expect(db.pragma("query_only", { simple: true })).toBe(1);
        expect(() => journal.appendObservation(f.authority, observation)).toThrow(/readonly/i);
        expect(journal.latestObservationCursor(f.authority.runId)).toBe(before);
      });
      expect(db.inTransaction).toBe(false);
      expect(db.pragma("query_only", { simple: true })).toBe(0);
      const recorded = journal.appendObservation(f.authority, observation);
      expect(recorded.id).toBeGreaterThan(before);
      expect(journal.latestObservationCursor(f.authority.runId)).toBe(recorded.id);
    } finally {
      db.close();
    }
  });

  it("nests safely and clears its cache after an exception", async () => {
    const f = await fixture();
    const retained = await history(f);
    const { db, journal } = readJournal(f);
    try {
      expect(() =>
        snapshot(journal, () => {
          const turns = journal.agents.turns(f.authority.runId);
          snapshot(journal, () => {
            expect(journal.agents.turns(f.authority.runId)).toBe(turns);
            expect(db.pragma("query_only", { simple: true })).toBe(1);
          });
          expect(db.pragma("query_only", { simple: true })).toBe(1);
          throw new Error("Reader failed");
        }),
      ).toThrow("Reader failed");
      expect(db.inTransaction).toBe(false);
      expect(db.pragma("query_only", { simple: true })).toBe(0);
      retained.prepare();
      expect(snapshot(journal, () => journal.agents.turns(f.authority.runId))).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("preserves an already read-only connection and rejects asynchronous callbacks", async () => {
    const f = await fixture();
    const { db, journal } = readJournal(f);
    try {
      db.pragma("query_only = ON");
      expect(snapshot(journal, () => journal.control(f.authority.runId))).toEqual(
        f.journal.control(f.authority.runId),
      );
      expect(db.pragma("query_only", { simple: true })).toBe(1);
      expect(() => snapshot(journal, () => Promise.resolve("late read"))).toThrow(/promise/i);
      expect(db.inTransaction).toBe(false);
      expect(db.pragma("query_only", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("cannot reuse previously validated history after later corruption", async () => {
    const f = await fixture();
    const retained = await history(f);
    const { db, journal } = readJournal(f);
    const id = retained.turns[0]!.identity.turnId;
    const original = db
      .prepare("SELECT record_json FROM agent_turns WHERE turn_id = ?")
      .get(id) as { record_json: string };
    try {
      expect(snapshot(journal, () => journal.agents.turns(f.authority.runId))).toHaveLength(1);
      db.prepare(
        "UPDATE agent_turns SET record_json = json_set(record_json, '$.promptDigest', ?) WHERE turn_id = ?",
      ).run("0".repeat(64), id);
      expect(() => journal.agents.turns(f.authority.runId)).toThrow(/digest|inconsistent/i);
      expect(() => snapshot(journal, () => journal.agents.turns(f.authority.runId))).toThrow(
        /digest|inconsistent/i,
      );
    } finally {
      db.prepare("UPDATE agent_turns SET record_json = ? WHERE turn_id = ?").run(
        original.record_json,
        id,
      );
      db.close();
    }
  });

  it("does not detach a nested read from an outer mutation transaction or its rollback", async () => {
    const f = await fixture();
    const { db, journal } = readJournal(f);
    try {
      const before = journal.control(f.authority.runId);
      expect(() =>
        db.transaction(() => {
          db.prepare(
            "UPDATE orchestration_runs SET control_version = control_version + 1 WHERE run_id = ?",
          ).run(f.authority.runId);
          expect(snapshot(journal, () => journal.control(f.authority.runId).controlVersion)).toBe(
            before.controlVersion + 1,
          );
          expect(db.inTransaction).toBe(true);
          expect(db.pragma("query_only", { simple: true })).toBe(0);
          throw new Error("Outer rollback");
        })(),
      ).toThrow("Outer rollback");
      expect(journal.control(f.authority.runId)).toEqual(before);
      expect(snapshot(journal, () => journal.control(f.authority.runId))).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("keeps a concurrent writer outside the current view and observes it in the next view", async () => {
    const f = await fixture();
    const retained = await history(f);
    const { db, journal } = readJournal(f);
    try {
      const count = () =>
        db
          .prepare("SELECT count(*) AS count FROM agent_turns WHERE run_id = ?")
          .get(f.authority.runId);
      snapshot(journal, () => {
        expect(journal.agents.turns(f.authority.runId)).toEqual(retained.turns);
        // The fixture writes through its independent WAL connection, not the read-only one.
        const next = retained.prepare();
        expect(f.journal.agents.turns(f.authority.runId)).toEqual([...retained.turns, next]);
        // An uncached SQL query must see the same pinned view as the cached history.
        expect(count()).toEqual({ count: 1 });
        expect(journal.agents.turns(f.authority.runId)).toEqual(retained.turns);
      });
      expect(count()).toEqual({ count: 2 });
      expect(snapshot(journal, () => journal.agents.turns(f.authority.runId))).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
