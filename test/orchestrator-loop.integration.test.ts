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

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "epicd-loop-"));
  roots.push(root);
  const store = new StateStore(join(root, "state.sqlite3"));
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
      expect(store.get(authority.runId)?.phase).toBe("selecting"); // A display phase never scheduled these actions.
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
