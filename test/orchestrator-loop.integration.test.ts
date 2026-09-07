import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { OrchestratorLoop, type DecisionSource } from "../src/orchestrator/loop.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type {
  ControllerAuthority,
  KernelAction,
  MemoryInput,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { OperationFailed, CapabilityRejected } from "../src/kernel/guards.js";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(beforeDispatch?: (signal: AbortSignal) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "epicd-loop-"));
  roots.push(root);
  const store = new StateStore(join(root, "state.sqlite3"));
  stores.push(store);
  const state = store.create(initialRun(), RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  const lease = store.acquireLease(state.runId);
  const authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const kernel = new ActionKernel(store.orchestration, beforeDispatch);
  return { store, kernel, authority };
}

function response(input: Parameters<DecisionSource["decide"]>[0], action: KernelAction) {
  return {
    explanation: "Choose the next useful action from the observed evidence",
    evidenceIds: [],
    request: {
      schemaVersion: 1,
      decisionId: input.ticket.decisionId,
      observationCursor: input.ticket.observationCursor,
      expectedControlVersion: input.ticket.expectedControlVersion,
      action,
    },
  };
}
const question: KernelAction = {
  kind: "escalate",
  question: "May I access the separately owned fixture?",
  reason: "authority",
  evidenceIds: [],
};
const memory: MemoryInput = {
  kind: "strategy",
  content: "Investigate the reported failure before review",
  scope: "run",
  taskId: null,
  confidence: "hypothesis",
  observationIds: [],
  evidenceIds: [],
  revision: null,
  environmentGeneration: null,
  supersedes: null,
};

describe("always engaged action loop", () => {
  it("returns an unknown tracker-operation rejection to the model instead of crashing the terminal-wait check", async () => {
    const { kernel, authority } = fixture();
    kernel.registerExternal("reconcile_tracker_operation", async () => {
      throw new CapabilityRejected("unknown_tracker", "No such tracker operation");
    });
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls += 1;
        return response(
          input,
          calls === 1
            ? { kind: "reconcile_tracker_operation", trackerOperationId: "unknown-operation" }
            : question,
        );
      },
    };
    expect(await new OrchestratorLoop(kernel, source).run(authority)).toBe("awaiting_user");
    expect(await kernel.drain()).toBe(true);
    expect(calls).toBe(2);
    expect(kernel.journal.actions(authority.runId)[0]?.status).toBe("rejected");
  });
  it("interrupts the exact pending completion operation on cancellation without starting more reasoning", async () => {
    const { kernel, authority } = fixture();
    const cancelled = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    kernel.registerExternal("complete_run", async ({ signal }) => {
      started();
      await delay(10000, undefined, { signal }).catch(() => {});
      throw new OperationFailed("Terminal inspection cancelled");
    });
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls += 1;
        return response(input, { kind: "complete_run" });
      },
    };
    const execution = new OrchestratorLoop(kernel, source, { pollMs: 10 }).run(
      authority,
      cancelled.signal,
    );
    await ready;
    cancelled.abort();
    await expect(execution).rejects.toThrow();
    expect(await kernel.drain()).toBe(true);
    expect(calls).toBe(1);
    expect(kernel.journal.control(authority.runId).status).toBe("active");
    expect(kernel.journal.actions(authority.runId).at(-1)?.status).toBe("cancelled");
  });
  it("honors an operator pause during pre-decision preparation without creating or dispatching a ticket", async () => {
    const { store, kernel, authority } = fixture();
    const source: DecisionSource = {
      async decide() {
        throw new Error("Paused preparation must not invoke the coordinator");
      },
    };
    const status = await new OrchestratorLoop(kernel, source, {
      beforeDecision: async () => {
        await delay(1);
        store.orchestration.operatorControl(
          authority.runId,
          store.orchestration.control(authority.runId).controlVersion,
          { kind: "pause" },
        );
      },
    }).run(authority);
    expect(status).toBe("paused");
    expect(store.orchestration.control(authority.runId).decisionsUsed).toBe(0);
    expect(store.orchestration.pendingDecision(authority.runId)).toBeNull();
    expect(store.orchestration.actions(authority.runId)).toEqual([]);
  });
  it("does not recursively grow inspection context across repeated decisions", async () => {
    const { kernel, authority } = fixture();
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls += 1;
        expect(Buffer.byteLength(JSON.stringify(input.context))).toBeLessThanOrEqual(65536);
        return response(input, calls <= 12 ? { kind: "inspect_run" } : question);
      },
    };
    expect(await new OrchestratorLoop(kernel, source).run(authority)).toBe("awaiting_user");
    expect(calls).toBe(13);
  });
  it("receives a worker event and chooses intervention before that worker's turn finishes", async () => {
    const { store, kernel, authority } = fixture();
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let workerActive = false;
    kernel.registerExternal("start_agent", async (context) => {
      workerActive = true;
      context.observe({
        source: "worker",
        sourceEventId: "started-command",
        kind: "command.started",
        summary: "Verifier is invoking a receipt-producing wrapper",
        artifactIds: [],
        identity: null,
        wakesOrchestrator: true,
      });
      await barrier;
      workerActive = false;
      return { kind: "resource", resourceId: "worker-result", generation: 1 };
    });
    kernel.registerLocal("interrupt_agent", () => {
      expect(workerActive).toBe(true);
      finish();
      return { kind: "resource", resourceId: "interruption-request", generation: 1 };
    });
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls += 1;
        if (calls === 1)
          return response(input, {
            kind: "start_agent",
            role: "review",
            purpose: "verification",
            taskId: "demo.1",
            workspaceId: "copy",
            workspaceGeneration: 1,
            candidateId: "candidate",
            instructions: "Verify independently",
          });
        if (calls === 2) {
          expect(workerActive).toBe(true);
          expect(input.context.observations.some((event) => event.kind === "command.started")).toBe(
            true,
          );
          expect(input.context.actions.some((action) => action.status === "running")).toBe(true);
          return response(input, {
            kind: "interrupt_agent",
            agentId: "worker",
            agentGeneration: 1,
            turnId: "turn",
          });
        }
        return response(input, question);
      },
    };
    expect(await new OrchestratorLoop(kernel, source).run(authority)).toBe("awaiting_user");
    expect(calls).toBe(3);
    await barrier;
    expect(
      store.orchestration.actions(authority.runId).map((action) => action.request.action.kind),
    ).toEqual(["start_agent", "interrupt_agent", "escalate"]);
  });

  it("waits for a genuinely delayed dispatch guard, then intervenes on the worker event before completion", async () => {
    let releaseGuard!: () => void, finishWorker!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    const worker = new Promise<void>((resolve) => {
      finishWorker = resolve;
    });
    let guardVerified = false,
      workerActive = false;
    const { store, kernel, authority } = fixture(async () => {
      await gate;
      guardVerified = true;
    });
    kernel.registerExternal("start_agent", async (context) => {
      expect(guardVerified).toBe(true);
      workerActive = true;
      context.observe({
        source: "worker",
        sourceEventId: "guarded-command",
        kind: "command.started",
        summary: "The worker started only after repository ownership was checked",
        artifactIds: [],
        identity: null,
        wakesOrchestrator: true,
      });
      await worker;
      workerActive = false;
      return { kind: "resource", resourceId: "worker-result", generation: 1 };
    });
    kernel.registerLocal("interrupt_agent", () => {
      expect(workerActive).toBe(true);
      finishWorker();
      return { kind: "resource", resourceId: "interrupted", generation: 1 };
    });
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls++;
        if (calls === 1)
          return response(input, {
            kind: "start_agent",
            role: "implementation",
            purpose: "implementation",
            taskId: "demo.1",
            workspaceId: "copy",
            workspaceGeneration: 1,
            candidateId: null,
            instructions: "Implement independently",
          });
        if (calls === 2) {
          expect(workerActive).toBe(false);
          expect(guardVerified).toBe(false);
          expect(input.context.observations.some((event) => event.kind === "command.started")).toBe(
            false,
          );
          releaseGuard();
          return response(input, {
            kind: "wait_for_events",
            afterCursor: input.context.observationCursor,
            deadline: null,
          });
        }
        if (calls === 3) {
          expect(workerActive).toBe(true);
          expect(input.context.observations.some((event) => event.kind === "command.started")).toBe(
            true,
          );
          return response(input, {
            kind: "interrupt_agent",
            agentId: "worker",
            agentGeneration: 1,
            turnId: "turn",
          });
        }
        return response(input, question);
      },
    };
    try {
      expect(await new OrchestratorLoop(kernel, source).run(authority)).toBe("awaiting_user");
      expect(calls).toBe(4);
      expect(
        store.orchestration.actions(authority.runId).map((action) => action.request.action.kind),
      ).toEqual(["start_agent", "wait_for_events", "interrupt_agent", "escalate"]);
    } finally {
      releaseGuard();
      finishWorker();
      kernel.interruptAll();
      await kernel.drain();
    }
  });

  it("rechecks an operator pause after an asynchronous guard and never starts the external handler", async () => {
    let releaseGuard!: () => void, enteredGuard!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredGuard = resolve;
    });
    const { store, kernel, authority } = fixture(async () => {
      enteredGuard();
      await gate;
    });
    let invoked = false;
    kernel.registerExternal("start_agent", async () => {
      invoked = true;
      return { kind: "resource", resourceId: "unexpected-worker", generation: 1 };
    });
    const journal = store.orchestration;
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(authority.runId),
      journal.control(authority.runId).controlVersion,
    );
    const running = await kernel.execute(
      {
        explanation: "Guarded worker admission",
        evidenceIds: [],
        request: {
          schemaVersion: 1,
          decisionId: ticket.decisionId,
          observationCursor: ticket.observationCursor,
          expectedControlVersion: ticket.expectedControlVersion,
          action: {
            kind: "start_agent",
            role: "implementation",
            purpose: "implementation",
            taskId: "demo.1",
            workspaceId: "copy",
            workspaceGeneration: 1,
            candidateId: null,
            instructions: "Implement only while authorized",
          },
        },
      },
      authority,
    );
    if (running.status !== "running") throw new Error("Expected guarded operation");
    const operation = kernel.operation(running.operationId)!;
    try {
      await entered;
      journal.operatorControl(authority.runId, journal.control(authority.runId).controlVersion, {
        kind: "pause",
      });
      releaseGuard();
      expect(await operation).toMatchObject({ status: "rejected", code: "stale_dispatch" });
      expect(invoked).toBe(false);
    } finally {
      releaseGuard();
      kernel.interruptAll();
      await kernel.drain();
    }
  });

  it("cancels and drains a health inspection before dispatching the completed coordinator decision", async () => {
    const { kernel, authority } = fixture();
    const abort = new AbortController();
    let releaseDecision!: () => void,
      releaseHealth!: () => void,
      enteredHealth!: () => void,
      stoppedHealth!: () => void;
    const decisionReady = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const healthDrain = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const healthEntered = new Promise<void>((resolve) => {
      enteredHealth = resolve;
    });
    const stopRequested = new Promise<void>((resolve) => {
      stoppedHealth = resolve;
    });
    let drained = false,
      workerStarted = false,
      calls = 0;
    kernel.registerExternal("start_agent", async () => {
      expect(drained).toBe(true);
      workerStarted = true;
      return { kind: "resource", resourceId: "guarded-worker", generation: 1 };
    });
    const source: DecisionSource = {
      async decide(input) {
        calls++;
        if (calls > 1) return response(input, question);
        await decisionReady;
        return response(input, {
          kind: "start_agent",
          role: "implementation",
          purpose: "implementation",
          taskId: "demo.1",
          workspaceId: "copy",
          workspaceGeneration: 1,
          candidateId: null,
          instructions: "Start only after the coordinator monitor has settled",
        });
      },
    };
    const running = new OrchestratorLoop(kernel, source, {
      pollMs: 1,
      healthIntervalMs: 1,
      onHealthCheck: async (signal) => {
        enteredHealth();
        if (!signal) throw new Error("Health inspection needs its monitor's cancellation signal");
        await new Promise<void>((resolve) => {
          const stop = () => {
            stoppedHealth();
            resolve();
          };
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        });
        await healthDrain;
        drained = true;
      },
    }).run(authority, abort.signal);
    const outcome = running.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const premature = outcome.then(() => {
      throw new Error("Loop finished before its health inspection drained");
    });
    // Attach immediately: a failed assertion must not create an unhandled watcher rejection.
    void premature.catch(() => undefined);
    try {
      await Promise.race([healthEntered, premature]);
      releaseDecision();
      await Promise.race([stopRequested, premature]);
      await delay(1); // Give queued dispatch callbacks a turn while the explicit drain barrier remains held.
      expect(workerStarted).toBe(false);
      expect(drained).toBe(false);
      releaseHealth();
      const result = await outcome;
      if ("error" in result) throw result.error;
      expect(result.value).toBe("awaiting_user");
      expect(workerStarted).toBe(true);
      expect(drained).toBe(true);
      expect(calls).toBe(2);
    } finally {
      abort.abort();
      releaseDecision();
      releaseHealth();
      await outcome;
      await kernel.drain();
    }
  });

  it.each([true, false])(
    "executes different legal action orders for the same lifecycle (memory first: %s)",
    async (memoryFirst) => {
      const { store, kernel, authority } = fixture();
      const memoryAction: KernelAction = { kind: "record_memory", entry: memory };
      const inspect: KernelAction = { kind: "inspect_run" };
      const sequence = memoryFirst
        ? [memoryAction, inspect, question]
        : [inspect, memoryAction, question];
      let index = 0;
      const source: DecisionSource = {
        async decide(input) {
          return response(input, sequence[index++]!);
        },
      };
      await new OrchestratorLoop(kernel, source).run(authority);
      expect(
        store.orchestration.actions(authority.runId).map((action) => action.request.action.kind),
      ).toEqual(sequence.map((action) => action.kind));
      expect(store.orchestration.memory(authority.runId)[0]?.content).toBe(memory.content);
      expect(store.get(authority.runId)).not.toHaveProperty("phase"); // No persisted lifecycle phase schedules these actions.
    },
  );

  it("waits for an external event without self-waking on its action journal", async () => {
    const { store, kernel, authority } = fixture();
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls += 1;
        return response(
          input,
          calls === 1
            ? {
                kind: "wait_for_events",
                afterCursor: input.ticket.observationCursor,
                deadline: null,
              }
            : question,
        );
      },
    };
    const pending = new OrchestratorLoop(kernel, source, { pollMs: 5 }).run(authority);
    await delay(40);
    expect(calls).toBe(1);
    store.orchestration.appendObservation(authority, {
      source: "worker",
      sourceEventId: "failed-browser",
      kind: "validation.failed",
      summary: "Browser authentication failed",
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
    expect(await pending).toBe("awaiting_user");
    expect(calls).toBe(2);
  });

  it("feeds rejected capabilities and malformed model output back without blocking the run", async () => {
    const { store, kernel, authority } = fixture();
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls += 1;
        if (calls === 1) return "not a decision";
        if (calls === 2)
          return response(input, {
            kind: "request_beads_transition",
            transition: "claim",
            taskId: "demo.1",
            revision: null,
          });
        expect(input.context.actions[0]?.result).toMatchObject({
          status: "rejected",
          code: "capability_unavailable",
        });
        return response(input, question);
      },
    };
    expect(await new OrchestratorLoop(kernel, source).run(authority)).toBe("awaiting_user");
    expect(calls).toBe(3);
    expect(
      store.orchestration
        .observations(authority.runId)
        .some((event) => event.kind === "orchestrator.invalid_output"),
    ).toBe(true);
  });

  it("preserves mandatory constraints and excludes lease credentials from context", async () => {
    const { kernel, authority } = fixture();
    const source: DecisionSource = {
      async decide(input) {
        expect(JSON.stringify(input.context)).not.toContain(authority.ownerToken);
        expect(JSON.stringify(input.context)).not.toContain(authority.leaseId);
        expect(input.context.constraints.join(" ")).toContain("independent evidence");
        expect(Buffer.byteLength(JSON.stringify(input.context))).toBeLessThanOrEqual(65536);
        return response(input, question);
      },
    };
    await new OrchestratorLoop(kernel, source).run(authority);
  });
});
