import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import { OrchestratorLoop, type DecisionSource } from "../src/orchestrator/loop.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type { ControllerAuthority, KernelAction } from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const roots: string[] = [];
const stores = new Set<StateStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(policy = RepositoryPolicySchema.parse({ schemaVersion: 1 })) {
  const root = mkdtempSync(join(tmpdir(), "epicd-context-"));
  roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new StateStore(path);
  stores.add(store);
  const run = store.create(initialRun(), policy);
  const lease = store.acquireLease(run.runId);
  const authority: ControllerAuthority = {
    runId: run.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  return { store, path, authority, kernel: new ActionKernel(store.orchestration) };
}

function appendBacklog(setup: ReturnType<typeof fixture>, count: number) {
  return Array.from({ length: count }, (_, index) =>
    setup.store.orchestration.appendObservation(setup.authority, {
      source: "native-event-source".padEnd(128, "x"),
      sourceEventId: `event-${index}`.padEnd(256, "x"),
      kind: "runtime.output",
      summary: `${index}: ${"日誌 and diagnostic detail ".repeat(200)}`,
      artifactIds: Array.from({ length: 8 }, (_, part) => `artifact-${part}`.padEnd(160, "x")),
      identity: {
        runId: setup.authority.runId,
        agentId: "agent".padEnd(128, "x"),
        agentGeneration: 1,
        turnId: "turn".padEnd(128, "x"),
        operationId: "operation".padEnd(128, "x"),
        assignmentId: "assignment".padEnd(128, "x"),
        workspaceId: "workspace".padEnd(128, "x"),
        workspaceGeneration: 1,
      },
      wakesOrchestrator: false,
    }),
  );
}

function response(
  input: Pick<Parameters<DecisionSource["decide"]>[0], "ticket">,
  action: KernelAction,
) {
  return {
    explanation: "Inspect the next bounded observation page",
    evidenceIds: [],
    request: {
      schemaVersion: 1 as const,
      decisionId: input.ticket.decisionId,
      observationCursor: input.ticket.observationCursor,
      expectedControlVersion: input.ticket.expectedControlVersion,
      action,
    },
  };
}

function ticketFor(setup: ReturnType<typeof fixture>) {
  const context = buildOrchestratorContext(setup.kernel, setup.authority.runId);
  return {
    context,
    ticket: setup.store.orchestration.beginDecision(
      setup.authority,
      context.observationCursor,
      context.control.controlVersion,
    ),
  };
}

describe("bounded observation context", () => {
  it("drains metadata-heavy prefixes in order across admission and a cold restart, including non-waking events", async () => {
    const setup = fixture();
    const retained = appendBacklog(setup, 137);
    const first = buildOrchestratorContext(setup.kernel, setup.authority.runId);
    expect(first.observationWindow).toEqual({ afterCursor: 0, hasMore: true });
    expect(first.observations.length).toBeGreaterThan(0);
    expect(first.observations.length).toBeLessThan(100);
    expect(first.observations.map((event) => event.id)).toEqual(
      retained.slice(0, first.observations.length).map((event) => event.id),
    );
    expect(first.observationCursor).toBe(first.observations.at(-1)!.id);
    expect(first.observations[0]!.summary).toContain("shortened; use inspect_observation");
    expect(first.observations[0]!.identity).toEqual(retained[0]!.identity);
    expect(first.observations[0]!.artifactIds).toEqual(retained[0]!.artifactIds);
    expect(buildOrchestratorContext(setup.kernel, setup.authority.runId)).toEqual(first);
    expect(setup.store.orchestration.observations(setup.authority.runId, 0, 1000)).toEqual(
      retained,
    );
    expect(setup.store.orchestration.control(setup.authority.runId).observationCursor).toBe(0);

    const firstInput = ticketFor(setup);
    setup.store.orchestration.decisionSource.prepare(
      setup.authority,
      firstInput.ticket,
      JSON.stringify(firstInput.context),
    );
    const result = await setup.kernel.execute(
      response(firstInput, {
        kind: "wait_for_events",
        afterCursor: first.observationCursor,
        deadline: null,
      }),
      setup.authority,
    );
    expect(result).toMatchObject({
      status: "succeeded",
      result: { kind: "wait", afterCursor: first.observationCursor },
    });
    if (result.status !== "succeeded" || result.result.kind !== "wait")
      throw new Error("Expected wait");
    expect(Date.parse(result.result.deadline!)).toBeLessThanOrEqual(Date.now());
    expect(setup.store.orchestration.control(setup.authority.runId).decisionsUsed).toBe(1);
    setup.store.close();
    stores.delete(setup.store);
    const reopened = new StateStore(setup.path);
    stores.add(reopened);
    expect(reopened.orchestration.control(setup.authority.runId)).toMatchObject({
      observationCursor: first.observationCursor,
      decisionsUsed: 1,
    });
    const delivered = first.observations.map((event) => event.id);
    let calls = 0;
    const source: DecisionSource = {
      async decide(input) {
        calls += 1;
        expect(Buffer.byteLength(JSON.stringify(input.context))).toBeLessThanOrEqual(65536);
        expect(input.context.observationWindow.afterCursor).toBe(delivered.at(-1));
        const expected = reopened.orchestration.observations(
          setup.authority.runId,
          delivered.at(-1),
          input.context.observations.length,
        );
        expect(input.context.observations.map((event) => event.id)).toEqual(
          expected.map((event) => event.id),
        );
        delivered.push(...input.context.observations.map((event) => event.id));
        expect(input.ticket.observationCursor).toBe(delivered.at(-1));
        expect(input.context.control.decisionsUsed).toBe(calls);
        return response(
          input,
          input.context.observationWindow.hasMore
            ? {
                kind: "wait_for_events",
                afterCursor: input.ticket.observationCursor,
                deadline: null,
              }
            : {
                kind: "escalate",
                question: "Observation paging test finished",
                reason: "authority",
                evidenceIds: [],
              },
        );
      },
    };
    expect(
      await new OrchestratorLoop(new ActionKernel(reopened.orchestration), source).run(
        setup.authority,
        AbortSignal.timeout(5000),
      ),
    ).toBe("awaiting_user");
    expect(calls).toBeGreaterThan(1);
    expect(delivered.filter((id) => id <= retained.at(-1)!.id)).toEqual(
      retained.map((event) => event.id),
    );
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(reopened.orchestration.control(setup.authority.runId).decisionsUsed).toBe(calls + 1);
    expect(reopened.orchestration.observations(setup.authority.runId, 0, retained.length)).toEqual(
      retained,
    );
  });

  it("uses row lookahead even when 100 small observations fit", () => {
    const setup = fixture();
    for (let index = 0; index < 101; index += 1)
      setup.store.orchestration.appendObservation(setup.authority, {
        source: "test",
        sourceEventId: String(index),
        kind: "event",
        summary: "",
        artifactIds: [],
        identity: null,
        wakesOrchestrator: false,
      });
    const context = buildOrchestratorContext(setup.kernel, setup.authority.runId);
    expect(context.observations).toHaveLength(100);
    expect(context.observationCursor).toBe(100);
    expect(context.observationWindow.hasMore).toBe(true);
  });

  it("rejects a frozen context without explicit observation-window semantics", () => {
    const setup = fixture();
    const input = ticketFor(setup);
    const { observationWindow: _omitted, ...incomplete } = input.context;
    expect(() =>
      setup.store.orchestration.decisionSource.prepare(
        setup.authority,
        input.ticket,
        JSON.stringify(incomplete),
      ),
    ).toThrow("Decision context does not match its ticket");
    expect(
      setup.store.orchestration.decisionSource.execution(
        setup.authority.runId,
        input.ticket.decisionId,
      ),
    ).toBeNull();
  });

  it("does not acknowledge a page through a mismatched decision cursor", async () => {
    const setup = fixture();
    appendBacklog(setup, 101);
    const input = ticketFor(setup);
    const decision = response(input, { kind: "inspect_run" });
    decision.request.observationCursor = setup.store.orchestration.latestObservationCursor(
      setup.authority.runId,
    );
    expect(await setup.kernel.execute(decision, setup.authority)).toMatchObject({
      status: "rejected",
      code: "wrong_cursor",
    });
    expect(setup.store.orchestration.control(setup.authority.runId)).toMatchObject({
      observationCursor: 0,
      decisionsUsed: 1,
    });
    expect(buildOrchestratorContext(setup.kernel, setup.authority.runId).observations[0]!.id).toBe(
      input.context.observations[0]!.id,
    );
  });

  it("refuses oversized mandatory policy instead of hiding authority constraints", () => {
    const setup = fixture(
      RepositoryPolicySchema.parse({
        schemaVersion: 1,
        writableScratch: Array.from(
          { length: 20 },
          (_, index) => `scratch-${index}/${"x".repeat(4000)}`,
        ),
      }),
    );
    expect(() => buildOrchestratorContext(setup.kernel, setup.authority.runId)).toThrow(
      "Mandatory orchestration context exceeds",
    );
    expect(setup.store.orchestration.control(setup.authority.runId)).toMatchObject({
      observationCursor: 0,
      decisionsUsed: 0,
    });
  });

  it("refuses a single oversized identity-bearing event instead of returning an empty no-progress page", () => {
    const setup = fixture();
    setup.store.orchestration.appendObservation(setup.authority, {
      source: "test",
      sourceEventId: "oversized",
      kind: "event",
      summary: "",
      artifactIds: Array.from({ length: 100 }, () => "界".repeat(256)),
      identity: null,
      wakesOrchestrator: false,
    });
    expect(() => buildOrchestratorContext(setup.kernel, setup.authority.runId)).toThrow(
      "Mandatory orchestration context exceeds",
    );
    expect(setup.store.orchestration.control(setup.authority.runId).observationCursor).toBe(0);
  });

  it("retrieves every retained character in bounded pages and preserves the latest lookup in pressured context", async () => {
    const setup = fixture();
    const retained = appendBacklog(setup, 101)[0]!;
    let offset: number | null = 0;
    let combined = "";
    while (offset !== null) {
      const input = ticketFor(setup);
      const result = await setup.kernel.execute(
        response(input, {
          kind: "inspect_observation",
          observationId: retained.id,
          offset,
          limit: 4000,
        }),
        setup.authority,
      );
      if (result.status !== "succeeded" || result.result.kind !== "inspection")
        throw new Error("Expected inspection");
      const page = JSON.parse(result.result.text);
      expect(page.observationId).toBe(retained.id);
      expect(page.offset).toBe(offset);
      expect(page.content.length).toBeLessThanOrEqual(4000);
      combined += page.content;
      offset = page.nextOffset;
      const context = buildOrchestratorContext(setup.kernel, setup.authority.runId);
      expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(65536);
      expect((context.latestActionOutcome ?? context.actions.at(-1))!.result).toEqual(result);
    }
    expect(JSON.parse(combined)).toEqual(retained);
    expect(setup.store.orchestration.observations(setup.authority.runId, 0, 1)[0]).toEqual(
      retained,
    );
  });

  it("rejects foreign, absent and out-of-range observation reads", async () => {
    const setup = fixture();
    const retained = appendBacklog(setup, 1)[0]!;
    const other = setup.store.create(
      initialRun("other-run"),
      RepositoryPolicySchema.parse({ schemaVersion: 1 }),
    );
    const lease = setup.store.acquireLease(other.runId);
    const foreign = setup.store.orchestration.appendObservation(
      { runId: other.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId },
      {
        source: "other",
        sourceEventId: "foreign",
        kind: "private",
        summary: "Other run",
        artifactIds: [],
        identity: null,
        wakesOrchestrator: false,
      },
    );
    for (const observationId of [foreign.id, 999999]) {
      expect(
        await setup.kernel.execute(
          response(ticketFor(setup), {
            kind: "inspect_observation",
            observationId,
            offset: 0,
            limit: 4000,
          }),
          setup.authority,
        ),
      ).toMatchObject({ status: "rejected", code: "unknown_observation" });
    }
    expect(
      await setup.kernel.execute(
        response(ticketFor(setup), {
          kind: "inspect_observation",
          observationId: retained.id,
          offset: 999999,
          limit: 4000,
        }),
        setup.authority,
      ),
    ).toMatchObject({ status: "rejected", code: "invalid_observation_offset" });
  });

  it("retains a rejected action's outcome when its valid request arguments alone exceed the snapshot budget", async () => {
    const setup = fixture();
    const action: KernelAction = {
      kind: "define_validation_plan",
      taskId: "example",
      acceptanceCriteria: Array.from({ length: 20 }, () => "x".repeat(4000)),
      checks: [
        {
          id: "check",
          command: "/usr/bin/true",
          args: [],
          cwd: ".",
          timeoutMs: 1000,
          environmentBindings: [],
        },
      ],
    };
    const result = await setup.kernel.execute(response(ticketFor(setup), action), setup.authority);
    expect(result.status).toBe("rejected"); // This fixture has no delivery handler.
    const recorded = setup.store.orchestration.actions(setup.authority.runId).at(-1)!;
    expect(Buffer.byteLength(JSON.stringify(recorded.request))).toBeGreaterThan(65536);
    const context = buildOrchestratorContext(setup.kernel, setup.authority.runId);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(65536);
    expect(context.actions).toEqual([]);
    expect(context.latestActionOutcome).toEqual({
      actionId: recorded.actionId,
      operationId: recorded.operationId,
      kind: action.kind,
      status: "rejected",
      result,
      requestArgumentsOmitted: true,
    });
    expect(buildOrchestratorContext(setup.kernel, setup.authority.runId)).toEqual(context);
    expect(setup.store.orchestration.actions(setup.authority.runId).at(-1)!.request.action).toEqual(
      action,
    );
  });
});
