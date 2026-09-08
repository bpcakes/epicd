import { randomUUID } from "node:crypto";
import {
  DispatchConflictError,
  MemoryReferenceError,
  type OrchestrationJournal,
} from "../adapters/orchestration-journal.js";
import {
  ActionPayloadSchema,
  KernelActionSchema,
  type ActionPayload,
  type ActionRecord,
  type ActionResult,
  type ControllerAuthority,
  type KernelAction,
  type ObservationInput,
  type OrchestratorDecision,
} from "../domain/orchestration.js";
import { redactSensitiveText } from "../util/redact.js";
import { assertCurrentDispatch, CapabilityRejected, OperationFailed } from "./guards.js";
import { actionContextRecord } from "./action-context.js";
import { AgentCoordinationError } from "../adapters/agent-journal.js";
import { DeliveryError } from "../adapters/delivery-journal.js";
import { DiagnosticRequestError } from "../adapters/diagnostic-journal.js";

type ActionKind = KernelAction["kind"];
export type ActionContext = {
  authority: ControllerAuthority;
  record: ActionRecord;
  signal: AbortSignal;
  observe(input: ObservationInput): void;
};
type Handler = {
  mode: "local" | "external";
  run: (context: ActionContext, action: KernelAction) => ActionPayload | Promise<ActionPayload>;
};

/** Registry and admission are deterministic. The model, not this registry, chooses the order. */
export class ActionKernel {
  private readonly handlers = new Map<ActionKind, Handler>();
  private readonly operations = new Map<
    string,
    { controller: AbortController; result: Promise<ActionResult> }
  >();
  private integrityError: Error | null = null;

  constructor(
    readonly journal: OrchestrationJournal,
    private readonly beforeDispatch?: (signal: AbortSignal) => Promise<void>,
  ) {
    this.registerLocal("inspect_observation", ({ authority }, action) => {
      const observation = journal.observations(authority.runId, action.observationId - 1, 1)[0];
      if (observation?.id !== action.observationId)
        throw new CapabilityRejected("unknown_observation", "No such observation in this run");
      // Page the immutable, already-redacted record. Even maximum-size metadata
      // must not turn a read-only diagnostic into an unbounded model response.
      const retained = JSON.stringify(observation);
      if (action.offset > retained.length)
        throw new CapabilityRejected(
          "invalid_observation_offset",
          "Offset exceeds the retained observation",
        );
      const end = Math.min(retained.length, action.offset + action.limit);
      return {
        kind: "inspection",
        text: JSON.stringify({
          observationId: observation.id,
          offset: action.offset,
          nextOffset: end < retained.length ? end : null,
          totalCharacters: retained.length,
          content: retained.slice(action.offset, end),
        }),
        artifactIds: [],
      };
    });
    this.registerLocal("inspect_artifact", ({ authority }, action) => {
      try {
        const page = journal.diagnostics.read(
          authority.runId,
          action.artifactId,
          action.offset,
          action.limit,
        );
        return { kind: "inspection", text: JSON.stringify(page), artifactIds: [page.artifactId] };
      } catch (error) {
        if (error instanceof DiagnosticRequestError)
          throw new CapabilityRejected("invalid_artifact_reference", error.message);
        throw error;
      }
    });
    this.registerLocal("inspect_agent", ({ authority }, action) => {
      const agent = journal.agents.instance(authority.runId, action);
      const turns = journal.agents
        .turns(authority.runId)
        .filter(
          (turn) =>
            turn.identity.agentId === agent.agentId &&
            turn.identity.agentGeneration === agent.agentGeneration,
        );
      const latestResult = turns.findLast((turn) => turn.result !== null);
      const resultText = latestResult ? JSON.stringify(latestResult.result) : null;
      const content = {
        agent,
        assignment: journal.agents.assignment(authority.runId, agent.assignmentId),
        messages: journal.agents
          .messages(authority.runId, agent)
          .slice(-20)
          .map((message) => ({
            messageId: message.messageId,
            status: message.status,
            deliveryTurnId: message.deliveryTurnId,
          })),
        turns: turns.slice(-20).map((turn) => ({
          identity: turn.identity,
          status: turn.status,
          resultEligible: turn.resultEligible,
          stopEvidence: turn.stopEvidence ? redactSensitiveText(turn.stopEvidence, 500) : null,
        })),
        latestResult:
          latestResult && resultText
            ? {
                turnId: latestResult.identity.turnId,
                claim: redactSensitiveText(resultText, 7999),
                truncated: resultText.length > 7999,
                evidenceWarning:
                  "Agent-reported result, not kernel validation or independent approval evidence",
              }
            : null,
        omittedTurns: Math.max(0, turns.length - 20),
      };
      while (Buffer.byteLength(JSON.stringify(content)) > 64000 && content.turns.length) {
        content.turns.shift();
        content.omittedTurns += 1;
      }
      if (Buffer.byteLength(JSON.stringify(content)) > 64000)
        throw new CapabilityRejected(
          "inspection_too_large",
          "Agent metadata exceeds the bounded inspection budget",
        );
      return {
        kind: "inspection",
        text: JSON.stringify(content),
        artifactIds: [],
      };
    });
    this.registerLocal("message_agent", ({ authority, record }, action) => {
      const message = journal.agents.enqueueAgentMessage(
        authority,
        action,
        record.operationId,
        action.message,
      );
      return {
        kind: "message",
        messageId: message.messageId,
        delivery: message.status === "acknowledged" ? "acknowledged" : "queued",
      };
    });
    this.registerLocal("inspect_run", ({ authority }) => {
      const content = {
        objective: journal.runObjective(authority.runId),
        control: journal.control(authority.runId),
        agents: journal.agents.summaries(authority.runId),
        delivery: journal.delivery.summaries(authority.runId),
        reviews: journal.reviews.summaries(authority.runId),
        commits: journal.commits.summaries(authority.runId),
        trackerCommits: journal.trackerCommits.summaries(authority.runId),
        publications: journal.publications.summaries(authority.runId),
        tracker: journal.tracker.summary(authority.runId),
        diagnostics: journal.diagnostics.summary(authority.runId),
        fixtures: journal.fixtures.summary(authority.runId),
        memory: journal
          .memory(authority.runId)
          .slice(-20)
          .map((entry) => ({ ...entry, content: redactSensitiveText(entry.content, 500) })),
        actions: journal.actions(authority.runId).slice(-10).map(actionContextRecord),
        omittedActions: 0,
      };
      while (Buffer.byteLength(JSON.stringify(content)) > 64000 && content.actions.length) {
        content.actions.shift();
        content.omittedActions += 1;
      }
      return { kind: "inspection", text: JSON.stringify(content), artifactIds: [] };
    });
    this.registerLocal("record_memory", ({ authority }, action) => ({
      kind: "memory",
      memoryId: journal.recordMemory(authority, action.entry).memoryId,
    }));
    this.registerLocal("wait_for_events", ({ authority, record }, action) => {
      if (action.afterCursor !== record.request.observationCursor)
        throw new CapabilityRejected(
          "wrong_wait_cursor",
          "Wait must begin at the observed cursor, not skip unseen events",
        );
      // Only the frozen page can identify a pre-existing non-waking backlog.
      // New coordinator bookkeeping must not self-wake an ordinary wait.
      // Persist the immediate deadline so cold restart also drains the suffix.
      const execution = journal.decisionSource.execution(authority.runId, record.decisionId);
      const hasPending =
        execution !== null && JSON.parse(execution.contextJson).observationWindow.hasMore;
      return {
        kind: "wait",
        afterCursor: action.afterCursor,
        deadline: hasPending ? new Date().toISOString() : action.deadline,
      };
    });
    this.registerLocal("escalate", ({ authority }, action) => ({
      kind: "escalation",
      escalationId: journal.setEscalation(
        authority,
        action.question,
        action.reason,
        action.evidenceIds,
      ),
    }));
  }

  registerLocal<K extends ActionKind>(
    kind: K,
    run: (context: ActionContext, action: Extract<KernelAction, { kind: K }>) => ActionPayload,
  ): void {
    this.register(kind, "local", run);
  }
  registerExternal<K extends ActionKind>(
    kind: K,
    run: (
      context: ActionContext,
      action: Extract<KernelAction, { kind: K }>,
    ) => Promise<ActionPayload>,
  ): void {
    this.register(kind, "external", run);
  }
  private register<K extends ActionKind>(
    kind: K,
    mode: Handler["mode"],
    run: (
      context: ActionContext,
      action: Extract<KernelAction, { kind: K }>,
    ) => ActionPayload | Promise<ActionPayload>,
  ): void {
    if (this.handlers.has(kind)) throw new Error(`Capability ${kind} is already registered`);
    this.handlers.set(kind, {
      mode,
      run: (context, action) => {
        if (!isKind(action, kind)) throw new Error("Action registry discriminant mismatch");
        return run(context, action);
      },
    });
  }

  capabilities(): { kind: ActionKind; available: boolean; reason: string | null }[] {
    return KernelActionSchema.options.map((schema) => {
      const kind = schema.shape.kind.value;
      return {
        kind,
        available: this.handlers.has(kind),
        reason: this.handlers.has(kind) ? null : "Capability is not configured for this run",
      };
    });
  }

  async execute(
    decision: OrchestratorDecision,
    authority: ControllerAuthority,
  ): Promise<ActionResult> {
    this.assertHealthy();
    const admitted = this.journal.acceptAction(authority, decision);
    if (admitted.kind === "rejected") return admitted.result;
    const record = admitted.action;
    if (record.result) return record.result;
    if (record.status === "running")
      return { status: "running", actionId: record.actionId, operationId: record.operationId };
    if (record.status !== "accepted")
      throw new Error("Action without an executable intent or recorded result");
    const handler = this.handlers.get(record.request.action.kind);
    if (!handler)
      return this.journal.rejectAcceptedAction(
        authority,
        record.actionId,
        "capability_unavailable",
        "This capability is not configured for the run",
      );
    const controller = new AbortController();
    const context: ActionContext = {
      authority,
      record,
      signal: controller.signal,
      observe: (input) => {
        this.journal.appendObservation(authority, input);
      },
    };
    try {
      if (handler.mode === "local") {
        if (this.beforeDispatch) await this.beforeDispatch(controller.signal);
        const settled = this.journal.executeLocalAction(authority, record.actionId, () => {
          const payload = handler.run(context, record.request.action);
          // Local handlers cannot commit a transaction before an asynchronous effect completes.
          return ActionPayloadSchema.parse(payload);
        });
        return settled.result!;
      }
      this.journal.startAction(authority, record.actionId);
    } catch (error) {
      if (
        error instanceof CapabilityRejected ||
        error instanceof DispatchConflictError ||
        error instanceof MemoryReferenceError ||
        error instanceof AgentCoordinationError ||
        error instanceof DeliveryError
      ) {
        return this.journal.rejectAcceptedAction(
          authority,
          record.actionId,
          error instanceof CapabilityRejected ||
            error instanceof AgentCoordinationError ||
            error instanceof DeliveryError
            ? error.code
            : error instanceof MemoryReferenceError
              ? "invalid_memory_reference"
              : "stale_dispatch",
          error.message,
        );
      }
      throw error;
    }

    const result = Promise.resolve().then(async (): Promise<ActionResult> => {
      let outcome: ActionResult;
      try {
        assertCurrentDispatch(this.journal, authority, record);
        controller.signal.throwIfAborted();
        if (this.beforeDispatch) {
          await this.beforeDispatch(controller.signal);
          assertCurrentDispatch(this.journal, authority, record);
          controller.signal.throwIfAborted();
        }
        const payload = ActionPayloadSchema.parse(
          await handler.run(context, record.request.action),
        );
        outcome = controller.signal.aborted
          ? {
              status: "cancelled",
              actionId: record.actionId,
              problemId: `cancelled-${record.actionId}`,
            }
          : { status: "succeeded", actionId: record.actionId, result: payload };
      } catch (error) {
        // Authority/storage errors while recording the problem remain integrity failures below.
        const problemId = randomUUID();
        this.journal.appendObservation(authority, {
          source: "kernel",
          sourceEventId: problemId,
          kind: "operation.problem",
          summary: redactSensitiveText(
            error instanceof Error ? error.message : "Operation failed",
            7999,
          ),
          artifactIds: [],
          identity: null,
          wakesOrchestrator: true,
        });
        outcome =
          error instanceof CapabilityRejected ||
          error instanceof AgentCoordinationError ||
          error instanceof DeliveryError
            ? {
                status: "rejected",
                actionId: record.actionId,
                code: error.code,
                detail: error.message,
              }
            : {
                status:
                  error instanceof OperationFailed
                    ? controller.signal.aborted
                      ? "cancelled"
                      : "failed"
                    : "indeterminate",
                actionId: record.actionId,
                problemId,
              };
      }
      return this.journal.settleAction(authority, record.actionId, "running", outcome).result!;
    });
    this.operations.set(record.operationId, { controller, result });
    void result.then(
      () => {
        this.operations.delete(record.operationId);
      },
      (error) => {
        this.integrityError =
          error instanceof Error ? error : new Error("Operation persistence failed");
        this.interruptAll();
      },
    );
    return { status: "running", actionId: record.actionId, operationId: record.operationId };
  }

  interruptAll(): void {
    for (const operation of this.operations.values())
      operation.controller.abort(new Error("Controller stopped admitting work"));
  }
  operation(operationId: string): Promise<ActionResult> | null {
    return this.operations.get(operationId)?.result ?? null;
  }

  /** Settle dispatched handlers before releasing their controller lease. */
  async drain(timeoutMs = 30_000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error("Invalid controller drain deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled([...this.operations.values()].map((operation) => operation.result)).then(
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  assertHealthy(): void {
    if (this.integrityError) throw this.integrityError;
  }
}

function isKind<K extends ActionKind>(
  action: KernelAction,
  kind: K,
): action is Extract<KernelAction, { kind: K }> {
  return action.kind === kind;
}
