import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import {
  DecisionSourceError,
  type DecisionSourceFailureCode,
} from "../src/domain/decision-source.js";
import type { ControllerAuthority, OrchestratorDecision } from "../src/domain/orchestration.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import { OrchestratorLoop, type DecisionSource } from "../src/orchestrator/loop.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const roots: string[] = [];
const stores: StateStore[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  const root = mkdtempSync(join(tmpdir(), "epicd-decision-source-"));
  roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new StateStore(path);
  stores.push(store);
  const state = store.createAdaptive(
    initialRun(),
    RepositoryPolicySchema.parse({ schemaVersion: 1 }),
  );
  const lease = store.acquireLease(state.runId);
  const authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const kernel = new ActionKernel(store.orchestration);
  return { root, path, store, journal: store.orchestration, kernel, authority };
}
function request(setup: ReturnType<typeof fixture>) {
  const context = buildOrchestratorContext(setup.kernel, setup.authority.runId);
  const ticket = setup.journal.beginDecision(
    setup.authority,
    context.observationCursor,
    context.control.controlVersion,
  );
  setup.journal.decisionSource.prepare(setup.authority, ticket, JSON.stringify(context));
  return { ticket, context };
}
function response(
  input: Pick<Parameters<DecisionSource["decide"]>[0], "ticket">,
): OrchestratorDecision {
  return {
    explanation: "A concrete operator choice is needed",
    evidenceIds: [],
    request: {
      schemaVersion: 1,
      decisionId: input.ticket.decisionId,
      observationCursor: input.ticket.observationCursor,
      expectedControlVersion: input.ticket.expectedControlVersion,
      action: {
        kind: "escalate",
        question: "May I provision the undeclared fixture?",
        reason: "authority",
        evidenceIds: [],
      },
    },
  };
}
function execution(setup: ReturnType<typeof fixture>) {
  return setup.journal.decisionSource.execution(
    setup.authority.runId,
    setup.journal.pendingDecision(setup.authority.runId)!.decisionId,
  )!;
}
async function until(predicate: () => boolean) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Condition did not become true");
}
function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

describe("durable coordinator transport attempts", () => {
  it("charges one decision for three attempts and freezes the input despite new observations", async () => {
    const setup = fixture();
    const inputs: string[] = [];
    const attemptIds: string[] = [];
    const source: DecisionSource = {
      async decide(input) {
        inputs.push(JSON.stringify({ ticket: input.ticket, context: input.context }));
        attemptIds.push(input.attemptId);
        expect(JSON.stringify(input)).not.toContain(setup.authority.leaseId);
        expect(JSON.stringify(input)).not.toContain(setup.authority.ownerToken);
        if (inputs.length === 1)
          setup.journal.appendObservation(setup.authority, {
            source: "worker",
            sourceEventId: "late",
            kind: "validation.failed",
            summary: "New evidence",
            identity: null,
            artifactIds: [],
            wakesOrchestrator: true,
          });
        if (inputs.length < 3) throw new DecisionSourceError("transient", "Provider overloaded");
        return response(input);
      },
    };
    const running = new OrchestratorLoop(setup.kernel, source, { pollMs: 1 }).run(setup.authority);
    await until(() => execution(setup).attempts[0]?.outcome?.kind === "failure");
    expect(() =>
      setup.journal.decisionSource.start(setup.authority, execution(setup).ticket.decisionId),
    ).toThrow("not due");
    advance(2000);
    await until(() => execution(setup).attempts[1]?.outcome?.kind === "failure");
    advance(3999);
    await delay(5);
    expect(inputs).toHaveLength(2);
    advance(1);
    expect(await running).toBe("awaiting_user");
    expect(new Set(inputs).size).toBe(1);
    expect(new Set(attemptIds).size).toBe(3);
    expect(inputs).toHaveLength(3);
    expect(setup.journal.control(setup.authority.runId).decisionsUsed).toBe(1);
    expect(setup.journal.actions(setup.authority.runId)).toHaveLength(1);
    expect(
      setup.journal
        .observations(setup.authority.runId)
        .some((item) => item.sourceEventId === "late"),
    ).toBe(true);
  });

  it("stops after three confirmed transient failures and records only one escalation", async () => {
    const setup = fixture();
    const decide = vi.fn(async () => {
      throw new DecisionSourceError("transient", "Overload");
    });
    const loop = new OrchestratorLoop(setup.kernel, { decide }, { pollMs: 1 });
    const running = loop.run(setup.authority);
    await until(() => execution(setup).attempts[0]?.outcome?.kind === "failure");
    advance(2000);
    await until(() => execution(setup).attempts[1]?.outcome?.kind === "failure");
    advance(4000);
    expect(await running).toBe("awaiting_user");
    expect(decide).toHaveBeenCalledTimes(3);
    expect(execution(setup).attempts[2]?.retryNotBefore).toBeNull();
    expect(setup.journal.control(setup.authority.runId).decisionsUsed).toBe(1);
    expect(setup.journal.actions(setup.authority.runId)).toEqual([]);
    expect(await loop.run(setup.authority)).toBe("awaiting_user");
    expect(decide).toHaveBeenCalledTimes(3);
    expect(
      setup.store
        .events(setup.authority.runId)
        .filter((item) => item.kind === "orchestrator.escalated"),
    ).toHaveLength(1);
  });

  it.each<DecisionSourceFailureCode>([
    "authentication",
    "quota",
    "model_unavailable",
    "configuration",
    "safety_stop",
  ])("does not retry a %s failure, change model, or execute a delivery action", async (code) => {
    const setup = fixture();
    const decide = vi.fn(async () => {
      throw new DecisionSourceError(code, "token=private-token");
    });
    expect(await new OrchestratorLoop(setup.kernel, { decide }).run(setup.authority)).toBe(
      "awaiting_user",
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execution(setup).attempts[0]).toMatchObject({
      outcome: { kind: "failure", code, detail: "token=[REDACTED]" },
      retryNotBefore: null,
    });
    expect(setup.journal.actions(setup.authority.runId)).toHaveLength(0);
    expect(setup.journal.policy(setup.authority.runId).coordinator.model).toBe("gpt-6-astra");
  });

  it("does not interpret an unknown native error as retryable or allow another dispatch after resume", async () => {
    const setup = fixture();
    const decide = vi.fn(async () => {
      throw new Error("Herdr screen says rate limit, agent state unknown");
    });
    expect(await new OrchestratorLoop(setup.kernel, { decide }).run(setup.authority)).toBe(
      "awaiting_user",
    );
    expect(execution(setup).attempts[0]?.outcome?.kind).toBe("indeterminate");
    setup.journal.changeStatus(setup.authority, "active");
    const fresh = request(setup);
    expect(() =>
      setup.journal.decisionSource.start(setup.authority, fresh.ticket.decisionId),
    ).toThrow("reconciliation");
    expect(await new OrchestratorLoop(setup.kernel, { decide }).run(setup.authority)).toBe(
      "awaiting_user",
    );
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("honors a longer provider deadline, checks health while waiting, and resumes without resetting attempts", async () => {
    const setup = fixture();
    const input = request(setup);
    const attempt = setup.journal.decisionSource.start(setup.authority, input.ticket.decisionId);
    setup.journal.decisionSource.finish(setup.authority, attempt.attemptId, {
      kind: "failure",
      code: "transient",
      detail: "Rate-limited request definitely stopped",
      retryAfterMs: 60_000,
    });
    const reopened = new StateStore(setup.path);
    stores.push(reopened);
    const health = vi.fn(async () => {});
    const decide = vi.fn(async (next: Parameters<DecisionSource["decide"]>[0]) => {
      expect({ ticket: next.ticket, context: next.context }).toEqual(input);
      return response(next);
    });
    const running = new OrchestratorLoop(
      new ActionKernel(reopened.orchestration),
      { decide },
      { pollMs: 1, onHealthCheck: health },
    ).run(setup.authority);
    advance(30_000);
    await until(() => health.mock.calls.length === 1);
    advance(29_999);
    await delay(5);
    expect(decide).not.toHaveBeenCalled();
    advance(1);
    expect(await running).toBe("awaiting_user");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(
      setup.journal.decisionSource.execution(setup.authority.runId, input.ticket.decisionId)
        ?.attempts,
    ).toHaveLength(2);
    expect(setup.journal.control(setup.authority.runId).decisionsUsed).toBe(1);
  });

  it("cancels a backoff promptly without dispatch or refilling its allowance", async () => {
    const setup = fixture();
    const abort = new AbortController();
    const decide = vi.fn(async () => {
      throw new DecisionSourceError("transient", "Overload");
    });
    const running = new OrchestratorLoop(setup.kernel, { decide }, { pollMs: 1 }).run(
      setup.authority,
      abort.signal,
    );
    const rejected = expect(running).rejects.toThrow();
    await until(() => execution(setup).attempts[0]?.retryNotBefore !== null);
    abort.abort();
    await rejected;
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execution(setup).attempts).toHaveLength(1);
    expect(setup.journal.control(setup.authority.runId).status).toBe("active");
  });

  it("replays a durably returned decision after reopening without recalling the source, even at the budget limit", async () => {
    const setup = fixture();
    const input = request(setup);
    const attempt = setup.journal.decisionSource.start(setup.authority, input.ticket.decisionId);
    setup.journal.decisionSource.finish(setup.authority, attempt.attemptId, {
      kind: "decision",
      decision: response(input),
    });
    const db = new Database(setup.path);
    databases.push(db);
    db.prepare("UPDATE orchestration_runs SET decisions_used = max_decisions WHERE run_id = ?").run(
      setup.authority.runId,
    );
    const reopened = new StateStore(setup.path);
    stores.push(reopened);
    const decide = vi.fn(async () => {
      throw new Error("must not run");
    });
    expect(
      await new OrchestratorLoop(new ActionKernel(reopened.orchestration), { decide }).run(
        setup.authority,
      ),
    ).toBe("awaiting_user");
    expect(decide).not.toHaveBeenCalled();
    expect(setup.journal.actions(setup.authority.runId)[0]?.request.decisionId).toBe(
      input.ticket.decisionId,
    );
  });

  it("preserves an interrupted dispatch and refuses a late old-lease result", async () => {
    const setup = fixture();
    const input = request(setup);
    const attempt = setup.journal.decisionSource.start(setup.authority, input.ticket.decisionId);
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    const lease = setup.store.acquireLease(setup.authority.runId);
    const nextAuthority = {
      ...setup.authority,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    expect(() =>
      setup.journal.decisionSource.finish(setup.authority, attempt.attemptId, {
        kind: "decision",
        decision: response(input),
      }),
    ).toThrow("lease");
    expect(() =>
      setup.journal.decisionSource.finish(nextAuthority, attempt.attemptId, {
        kind: "decision",
        decision: response(input),
      }),
    ).toThrow("another controller lease");
    const decide = vi.fn(async () => response(input));
    expect(await new OrchestratorLoop(setup.kernel, { decide }).run(nextAuthority)).toBe(
      "awaiting_user",
    );
    expect(decide).not.toHaveBeenCalled();
    expect(execution(setup).attempts[0]?.outcome).toBeNull();
    expect(setup.journal.actions(setup.authority.runId)).toEqual([]);
  });

  it("invalidates a waiting retry when settings or pause changes control authority", async () => {
    const setup = fixture();
    const decide = vi.fn(async () => {
      throw new DecisionSourceError("transient", "Overload");
    });
    const running = new OrchestratorLoop(setup.kernel, { decide }, { pollMs: 1 }).run(
      setup.authority,
    );
    await until(() => execution(setup).attempts[0]?.outcome?.kind === "failure");
    const previous = execution(setup);
    setup.journal.changeStatus(setup.authority, "paused");
    expect(await running).toBe("paused");
    advance(2000);
    expect(() =>
      setup.journal.decisionSource.start(setup.authority, previous.ticket.decisionId),
    ).toThrow("stale");
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("pauses a source that ignores cancellation and never admits its late response", async () => {
    const setup = fixture();
    let finish!: () => void;
    let requestSignal: AbortSignal | undefined;
    const source: DecisionSource = {
      decide(input, signal) {
        requestSignal = signal;
        return new Promise((resolve) => {
          finish = () => resolve(response(input));
        });
      },
    };
    const running = new OrchestratorLoop(setup.kernel, source, { pollMs: 1 }).run(setup.authority);
    await until(() => requestSignal !== undefined);
    const ticket = execution(setup).ticket;
    setup.journal.changeStatus(setup.authority, "paused");
    expect(await running).toBe("paused");
    expect(requestSignal!.aborted).toBe(true);
    expect(execution(setup).attempts[0]?.outcome?.kind).toBe("indeterminate");
    finish();
    await delay(5);
    expect(
      setup.journal.decisionSource.execution(setup.authority.runId, ticket.decisionId)?.attempts[0]
        ?.outcome?.kind,
    ).toBe("indeterminate");
    expect(setup.journal.actions(setup.authority.runId)).toEqual([]);
  });

  it("detects lease loss during a hung source request and preserves uncertainty for the new controller", async () => {
    const setup = fixture();
    let requestSignal: AbortSignal | undefined;
    let finish!: () => void;
    const source: DecisionSource = {
      decide(input, signal) {
        requestSignal = signal;
        return new Promise((resolve) => {
          finish = () => resolve(response(input));
        });
      },
    };
    const running = new OrchestratorLoop(setup.kernel, source, { pollMs: 1 }).run(setup.authority);
    const failed = expect(running).rejects.toThrow("lease");
    await until(() => requestSignal !== undefined);
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    const lease = setup.store.acquireLease(setup.authority.runId);
    await failed;
    expect(requestSignal!.aborted).toBe(true);
    expect(execution(setup).attempts[0]?.outcome).toBeNull();
    finish();
    await delay(5);
    const decide = vi.fn(async () => {
      throw new Error("must not dispatch");
    });
    const nextAuthority = {
      ...setup.authority,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    expect(await new OrchestratorLoop(setup.kernel, { decide }).run(nextAuthority)).toBe(
      "awaiting_user",
    );
    expect(decide).not.toHaveBeenCalled();
    expect(setup.journal.actions(setup.authority.runId)).toEqual([]);
  });

  it("requests worker interruption when the coordinator becomes unavailable", async () => {
    const setup = fixture();
    let workerSignal: AbortSignal | undefined;
    setup.kernel.registerExternal("start_agent", async (context) => {
      workerSignal = context.signal;
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { kind: "resource", resourceId: "interrupted-worker", generation: 1 };
    });
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls += 1;
        if (calls > 1)
          throw new DecisionSourceError("model_unavailable", "Astra access unavailable");
        const result = response(input);
        result.request.action = {
          kind: "start_agent",
          role: "review",
          purpose: "verification",
          taskId: "demo.1",
          workspaceId: "copy",
          workspaceGeneration: 1,
          candidateId: "candidate",
          instructions: "Verify independently",
        };
        return result;
      },
    };
    expect(await new OrchestratorLoop(setup.kernel, source).run(setup.authority)).toBe(
      "awaiting_user",
    );
    expect(workerSignal?.aborted).toBe(true);
    const action = setup.journal.actions(setup.authority.runId)[0]!;
    await setup.kernel.operation(action.operationId);
    expect(setup.journal.actions(setup.authority.runId)).toHaveLength(1);
  });

  it("handles synchronous adapter rejection without unhandled cancellation promises", async () => {
    const setup = fixture();
    const decide = vi.fn(() => {
      throw new DecisionSourceError("authentication", "Authentication expired");
    });
    expect(await new OrchestratorLoop(setup.kernel, { decide }).run(setup.authority)).toBe(
      "awaiting_user",
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execution(setup).attempts[0]?.outcome).toMatchObject({
      kind: "failure",
      code: "authentication",
    });
  });

  it("migrates version 4 with a snapshot and includes source records in raw quarantine", () => {
    const setup = fixture();
    const db = new Database(setup.path);
    databases.push(db);
    db.exec(
      "DROP TABLE decision_source_attempts; DROP TABLE decision_executions; DELETE FROM orchestration_schema; INSERT INTO orchestration_schema VALUES(4)",
    );
    const migrated = new StateStore(setup.path);
    stores.push(migrated);
    const backupName = readdirSync(setup.root).find((name) =>
      name.includes(".before-orchestration-"),
    )!;
    const backup = new Database(join(setup.root, backupName), { readonly: true });
    databases.push(backup);
    expect(
      backup.prepare("SELECT MAX(version) AS version FROM orchestration_schema").get(),
    ).toEqual({ version: 4 });
    expect(
      backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'decision_executions'").get(),
    ).toBeUndefined();
    const input = request(setup);
    setup.journal.decisionSource.start(setup.authority, input.ticket.decisionId);
    // Use the real quarantine path through corrupted persisted state, preserving raw attempt/input rows.
    db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{}", setup.authority.runId);
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    setup.store.quarantineInvalidRun(setup.authority.runId);
    const tables = db
      .prepare("SELECT source_table FROM quarantined_orchestration WHERE run_id = ?")
      .all(setup.authority.runId);
    expect(tables).toContainEqual({ source_table: "decision_executions" });
    expect(tables).toContainEqual({ source_table: "decision_source_attempts" });
  });
});
