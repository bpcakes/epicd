import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BeadsClient } from "../adapters/beads.js";
import { CodexRuntime } from "../adapters/codex.js";
import { GitClient } from "../adapters/git.js";
import { HerdrRuntime } from "../adapters/herdr.js";
import type {
  AgentRole,
  AgentRuntime,
  OpenedAgentSession,
  RunTurnOptions,
  RuntimeEvent,
  TurnExecution,
} from "../adapters/runtime.js";
import { StateStore, type RunLease } from "../adapters/store.js";
import { redactSensitiveText } from "../util/redact.js";
import { compareIssuesDeepestFirst, isIssueDescendant } from "../domain/issue-hierarchy.js";
import {
  IMPLEMENTATION_OUTPUT_SCHEMA,
  ImplementationResultSchema,
  REVIEW_OUTPUT_SCHEMA,
  ReviewResultSchema,
  SELECTION_OUTPUT_SCHEMA,
  SelectionResultSchema,
  AGENT_ROLES,
  AgentPreferencesSchema,
  createInactiveAgentSessions,
  DEFAULT_AGENT_PREFERENCES,
  DEFAULT_MAX_REVIEW_PASSES,
  resolveAgentRoleSettings,
  RUN_STATE_SCHEMA_VERSION,
  runAgentSessionId,
  runNeedsResume,
  runRecoveryKind,
  RunStateSchema,
  type AgentPreferences,
  type AgentRolePreferences,
  type AgentRoleSettings,
  type AgentSessionContract,
  type AgentAccessMode,
  type AgentCleanupAction,
  type EngineEvent,
  type EpicSnapshot,
  type EventLevel,
  type Issue,
  type RunPhase,
  type RunState,
  type RuntimeKind,
  type ReasoningEffort,
} from "../domain/types.js";
import {
  finalEpicReviewPrompt,
  fixPrompt,
  implementationPrompt,
  reviewFixesPrompt,
  selectionPrompt,
  taskReviewPrompt,
  taskVerificationPrompt,
} from "./prompts.js";
import { requireAcceptedImplementationResult } from "./result-policy.js";
import { AgentCleanupRequiredError, WorkflowCompletionReportingError } from "./errors.js";

export type EpicEngineOptions = {
  repoPath: string;
  epicId: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  agentSettings?: Partial<Record<AgentRole, Partial<AgentRolePreferences>>>;
  runtime?: RuntimeKind;
  codexPath?: string;
  herdrPath?: string;
  maxReviewPasses?: number;
  accessMode?: AgentAccessMode;
};

type ResumeEngineOptions = Omit<EpicEngineOptions, "repoPath" | "epicId">;
type RunInvocationKind = "workflow" | "cleanup";

export function assertResumeOptionsAllowed(state: RunState, options: ResumeEngineOptions): void {
  if (state.phase !== "complete" || !runNeedsResume(state)) return;
  const hasFutureThreadOverrides =
    options.model !== undefined ||
    options.reasoningEffort !== undefined ||
    options.agentSettings !== undefined ||
    options.runtime !== undefined ||
    options.codexPath !== undefined ||
    options.maxReviewPasses !== undefined ||
    options.accessMode !== undefined;
  if (!hasFutureThreadOverrides) return;
  const remaining =
    runRecoveryKind(state) === "diagnostic"
      ? "only a saved diagnostic remains"
      : "only agent cleanup remains";
  throw new Error(
    `Run ${state.runId.slice(0, 8)} is complete and ${remaining}; omit model, reasoning, runtime executable, permission, and review-budget overrides because no new thread will be created`,
  );
}

type ComparableAgentSettings = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
};

const MAX_AGENT_SESSION_PREPARATIONS = 3;

function sameAgentRoleSettings(
  left: ComparableAgentSettings,
  right: ComparableAgentSettings,
): boolean {
  return left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}

function sameAgentSettings(left: AgentPreferences, right: AgentPreferences): boolean {
  return AGENT_ROLES.every((role) => sameAgentRoleSettings(left[role], right[role]));
}

function mapAgentPreferences(
  mapper: (role: AgentRole) => AgentPreferences[AgentRole],
): AgentPreferences {
  return AgentPreferencesSchema.parse(
    Object.fromEntries(AGENT_ROLES.map((role) => [role, mapper(role)])),
  );
}

function applyAgentSettings(
  base: AgentPreferences,
  options: Pick<EpicEngineOptions, "agentSettings">,
): AgentPreferences {
  return mapAgentPreferences((role) => {
    const roleOverride = options.agentSettings?.[role];
    const hasModelOverride = roleOverride
      ? Object.prototype.hasOwnProperty.call(roleOverride, "model")
      : false;
    const hasReasoningOverride = roleOverride
      ? Object.prototype.hasOwnProperty.call(roleOverride, "reasoningEffort")
      : false;
    return {
      model: hasModelOverride ? (roleOverride?.model ?? null) : base[role].model,
      reasoningEffort: hasReasoningOverride
        ? (roleOverride?.reasoningEffort ?? null)
        : base[role].reasoningEffort,
    };
  });
}

function withAgentSettings(
  source: RunState,
  settings: AgentPreferences,
  model = source.model,
  reasoningEffort = source.reasoningEffort,
): RunState {
  const agentSettings = AgentPreferencesSchema.parse(settings);
  return RunStateSchema.parse({
    ...source,
    model,
    reasoningEffort,
    agentSettings,
  });
}

function createAgentRuntime(
  runtime: RuntimeKind,
  state: RunState,
  options: EpicEngineOptions,
  accessMode: AgentAccessMode,
): AgentRuntime {
  return runtime === "herdr"
    ? new HerdrRuntime({
        repoPath: state.repoPath,
        runId: state.runId,
        agentNamespace: state.agentNamespace,
        herdrPath: options.herdrPath,
        accessMode,
        legacyAgentIds: [
          ...AGENT_ROLES.flatMap((role) => {
            const session = state.agentSessions[role];
            return session.status === "inactive" ? [] : [session.sessionId];
          }),
          ...state.pendingAgentCleanup.flatMap((action) =>
            action.kind === "session" && action.runtime === "herdr" ? [action.sessionId] : [],
          ),
        ],
      })
    : new CodexRuntime({
        repoPath: state.repoPath,
        codexPath: options.codexPath,
        accessMode,
      });
}

class ObserverSet<Value> {
  private readonly listeners = new Set<(value: Value) => void>();
  private readonly warnedListeners = new Set<(value: Value) => void>();

  subscribe(listener: (value: Value) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.warnedListeners.delete(listener);
    };
  }

  notify(value: Value): void {
    for (const listener of this.listeners) {
      try {
        listener(value);
        // A later failure is a new degraded episode and deserves a fresh warning.
        this.warnedListeners.delete(listener);
      } catch (error) {
        // Observers must not participate in controller control flow.
        if (this.warnedListeners.has(listener)) continue;
        this.warnedListeners.add(listener);
        const failureType = error instanceof Error ? error.name : typeof error;
        try {
          process.emitWarning(
            `Epicd ${failureType} observer failure; controller execution continued`,
            { code: "EPICD_OBSERVER_FAILURE" },
          );
        } catch {
          // Diagnostics must not reintroduce observer failures into controller flow.
        }
      }
    }
  }
}

function taskIssues(snapshot: EpicSnapshot): Issue[] {
  return snapshot.issues.filter(
    (issue) => issue.issue_type !== "epic" && issue.status !== "tombstone",
  );
}

function issueAssignee(issue: Issue): string | null {
  const assignee = typeof issue.assignee === "string" ? issue.assignee.trim() : "";
  return assignee || null;
}

function isApproved(result: ReturnType<typeof ReviewResultSchema.parse>): boolean {
  return (
    result.verdict === "approved" &&
    result.findings.length === 0 &&
    result.tests.some((test) => test.outcome === "passed") &&
    !result.tests.some((test) => test.outcome === "failed")
  );
}

function parseStructured<T>(text: string, parser: { parse(value: unknown): T }): T {
  try {
    return parser.parse(JSON.parse(text));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent returned invalid structured output: ${redactSensitiveText(reason)}`);
  }
}

function commitSubject(issue: Issue): string {
  const suffix = ` (${issue.id})`;
  const available = Math.max(20, 72 - suffix.length);
  return `${issue.title.slice(0, available).trim()}${suffix}`;
}

function cleanupActionKey(action: AgentCleanupAction): string {
  return action.kind === "run"
    ? `run:${action.runtime}`
    : `session:${action.runtime}:${action.sessionId}`;
}

export class EpicEngine {
  private readonly eventObservers = new ObserverSet<EngineEvent>();
  private readonly stateObservers = new ObserverSet<RunState>();
  private readonly beads: BeadsClient;
  private readonly git: GitClient;
  // Persisted runtime selection is validated on decode and may change during a cold handoff,
  // so this boundary remains a dynamically checked union rather than infecting the engine type.
  private runtime!: AgentRuntime;
  private pendingRuntimeSwitch: RuntimeKind | null;
  private pendingAccessModeSwitch: AgentAccessMode | null;
  private activeLease: string | null = null;
  private pauseRequested = false;
  private resumeRequested = false;
  private resumeSettingsPending = false;
  private resumeOptionsToValidate: ResumeEngineOptions | null = null;

  private constructor(
    private readonly store: StateStore,
    private readonly state: RunState,
    private readonly options: Required<Pick<EpicEngineOptions, "maxReviewPasses">> &
      EpicEngineOptions,
  ) {
    this.beads = new BeadsClient(state.repoPath);
    this.git = new GitClient(state.repoPath);
    this.pendingRuntimeSwitch = null;
    this.pendingAccessModeSwitch = null;
    this.refreshRuntimeContract();
  }

  private refreshRuntimeContract(): void {
    const runtime = this.options.runtime ?? this.state.runtime;
    const accessMode = this.options.accessMode ?? this.state.agentAccessMode;
    this.pendingRuntimeSwitch = runtime === this.state.runtime ? null : runtime;
    this.pendingAccessModeSwitch = accessMode === this.state.agentAccessMode ? null : accessMode;
    this.runtime = createAgentRuntime(runtime, this.state, this.options, accessMode);
  }

  static async create(options: EpicEngineOptions, store = new StateStore()): Promise<EpicEngine> {
    const requestedPath = resolve(options.repoPath);
    const requestedGit = new GitClient(requestedPath);
    const repoPath = resolve(await requestedGit.root());
    const git = new GitClient(repoPath);
    await git.assertClean();

    const beads = new BeadsClient(repoPath);
    const snapshot = await beads.snapshot(options.epicId);
    if (snapshot.epic.status === "closed" || snapshot.epic.status === "tombstone") {
      throw new Error(`${snapshot.epic.id} is already ${snapshot.epic.status}`);
    }
    const now = new Date().toISOString();
    const state: RunState = {
      stateSchemaVersion: RUN_STATE_SCHEMA_VERSION,
      runId: randomUUID(),
      agentNamespace: randomUUID().replaceAll("-", "").slice(0, 20),
      repoPath,
      epicId: snapshot.epic.id,
      epicTitle: snapshot.epic.title,
      model: options.model ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
      runtime: options.runtime ?? "sdk",
      agentSettings: applyAgentSettings(DEFAULT_AGENT_PREFERENCES, options),
      agentAccessMode: options.accessMode ?? "sandboxed",
      maxReviewPasses: options.maxReviewPasses ?? DEFAULT_MAX_REVIEW_PASSES,
      phase: "selecting",
      currentBeadId: null,
      currentBeadTitle: null,
      agentSessions: createInactiveAgentSessions(),
      pendingAgentCleanup: [],
      baseRevision: null,
      epicBaseRevision: await git.head(),
      candidateRevision: null,
      reviewBaselineFingerprint: null,
      reviewedFingerprint: null,
      reviewedTree: null,
      completedTasks: taskIssues(snapshot).filter((issue) => issue.status === "closed").length,
      totalTasks: taskIssues(snapshot).length,
      reviewPass: 0,
      pendingFindings: [],
      recentOutcomes: [],
      lastReviewSummary: null,
      resumePhase: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    const engine = new EpicEngine(store, state, {
      ...options,
      repoPath,
      maxReviewPasses: state.maxReviewPasses,
    });
    store.create(state);
    engine.emit(
      "success",
      "run.created",
      `Prepared ${snapshot.epic.id}`,
      `${state.totalTasks} implementation tasks`,
    );
    return engine;
  }

  static resume(
    runId: string,
    options: ResumeEngineOptions = {},
    store = new StateStore(),
  ): EpicEngine {
    const resumedState = store.get(runId);
    if (!resumedState) throw new Error(`Unknown epicd run ${runId}`);
    if (!runNeedsResume(resumedState)) {
      throw new Error(`Run ${resumedState.runId.slice(0, 8)} is already complete`);
    }
    assertResumeOptionsAllowed(resumedState, options);
    if (
      options.maxReviewPasses !== undefined &&
      options.maxReviewPasses !== resumedState.maxReviewPasses
    ) {
      throw new Error(
        `Run ${resumedState.runId.slice(0, 8)} has a persisted repair budget of ${resumedState.maxReviewPasses} passes; start a new run to change it`,
      );
    }
    const requestedSettings = applyAgentSettings(resumedState.agentSettings, options);
    const requestedModel = options.model === undefined ? resumedState.model : options.model;
    const requestedReasoningEffort =
      options.reasoningEffort === undefined
        ? resumedState.reasoningEffort
        : options.reasoningEffort;
    const previewState =
      requestedModel === resumedState.model &&
      requestedReasoningEffort === resumedState.reasoningEffort &&
      sameAgentSettings(requestedSettings, resumedState.agentSettings)
        ? resumedState
        : withAgentSettings(
            resumedState,
            requestedSettings,
            requestedModel,
            requestedReasoningEffort,
          );
    const engine = new EpicEngine(store, previewState, {
      ...options,
      repoPath: resumedState.repoPath,
      epicId: resumedState.epicId,
      maxReviewPasses: resumedState.maxReviewPasses,
    });
    engine.resumeSettingsPending = true;
    engine.resumeOptionsToValidate = structuredClone(options);
    engine.prepareResume();
    return engine;
  }

  private applyRequestedSettings(): void {
    if (!this.resumeSettingsPending) return;
    const requestedSettings = applyAgentSettings(this.state.agentSettings, this.options);
    const requestedModel = this.options.model === undefined ? this.state.model : this.options.model;
    const requestedReasoningEffort =
      this.options.reasoningEffort === undefined
        ? this.state.reasoningEffort
        : this.options.reasoningEffort;
    if (
      requestedModel === this.state.model &&
      requestedReasoningEffort === this.state.reasoningEffort &&
      sameAgentSettings(requestedSettings, this.state.agentSettings)
    ) {
      this.resumeSettingsPending = false;
      return;
    }
    Object.assign(
      this.state,
      withAgentSettings(this.state, requestedSettings, requestedModel, requestedReasoningEffort),
    );
    this.save();
    this.resumeSettingsPending = false;
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    return this.eventObservers.subscribe(listener);
  }

  onState(listener: (state: RunState) => void): () => void {
    return this.stateObservers.subscribe(listener);
  }

  snapshot(): RunState {
    return RunStateSchema.parse(this.state);
  }

  configureFutureAgentSettings(settings: AgentPreferences): void {
    const activeOwnerToken = this.activeLease;
    const parsedSettings = AgentPreferencesSchema.parse(settings);
    const runWide = {
      model: this.state.model,
      reasoningEffort: this.state.reasoningEffort,
    };
    const { event, ...updated } = activeOwnerToken
      ? this.store.updateAgentSettingsWithLease(
          this.state.runId,
          activeOwnerToken,
          parsedSettings,
          runWide,
        )
      : this.store.updateAgentSettings(this.state.runId, parsedSettings, runWide);
    // The store returns only the projection owned by this command. Workflow
    // fields may have advanced in memory while the settings row was updated.
    Object.assign(this.state, updated);
    this.notifyState(this.snapshot());
    // The live editor starts from the resume preview; saving its complete draft
    // intentionally supersedes, rather than re-applies, pending CLI settings.
    this.resumeSettingsPending = false;
    this.notifyEvent(event);
  }

  recentEvents(limit = 200): EngineEvent[] {
    return this.store.events(this.state.runId, limit);
  }

  requestPause(): void {
    this.emit(
      "warning",
      "run.pause_requested",
      "Pause requested; epicd will stop after the current operation",
    );
    this.pauseRequested = true;
  }

  async resumeRun(signal?: AbortSignal): Promise<RunState> {
    if (this.state.phase !== "paused" && this.state.phase !== "blocked") {
      throw new Error(`Cannot resume a run in phase ${this.state.phase}`);
    }
    this.prepareResume();
    return await this.run(signal);
  }

  private prepareResume(): void {
    if (this.state.phase !== "paused" && this.state.phase !== "blocked") return;
    this.resumeRequested = true;
    this.pauseRequested = false;
  }

  private emit(
    level: EventLevel,
    kind: string,
    message: string,
    detail: string | null = null,
  ): void {
    const event = this.activeLease
      ? this.store.addEventWithLease(
          this.state.runId,
          this.activeLease,
          level,
          kind,
          message,
          detail,
        )
      : this.store.addEvent(this.state.runId, level, kind, message, detail);
    this.notifyEvent(event);
  }

  private notifyEvent(event: EngineEvent): void {
    this.eventObservers.notify(event);
  }

  private notifyState(state: RunState): void {
    this.stateObservers.notify(state);
  }

  private save(): void {
    if (this.activeLease) this.store.saveWithLease(this.state, this.activeLease);
    else this.store.save(this.state);
    this.notifyState(this.snapshot());
  }

  private transition(phase: RunPhase): void {
    this.state.phase = phase;
    this.state.lastError = null;
    this.save();
  }

  private futureAgentSettings(role: AgentRole): AgentRoleSettings {
    return resolveAgentRoleSettings(this.state, role);
  }

  private async prepareSessionContract(
    role: AgentRole,
    settings: AgentRoleSettings,
    previous: AgentSessionContract | undefined,
    signal?: AbortSignal,
  ): Promise<AgentSessionContract> {
    const runtime = this.runtime;
    if (runtime.kind === "sdk" && (!previous || previous.runtime === "sdk")) {
      return await runtime.prepareNewSession(role, settings, previous, signal);
    }
    if (runtime.kind === "herdr" && (!previous || previous.runtime === "herdr")) {
      return await runtime.prepareNewSession(role, settings, previous, signal);
    }
    throw new Error("Prepared session contract does not match the selected runtime");
  }

  private async openPreparedSession(
    role: AgentRole,
    contract: AgentSessionContract,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<OpenedAgentSession> {
    const runtime = this.runtime;
    const spec =
      sessionId === undefined ? { kind: "new" as const } : { kind: "existing" as const, sessionId };
    if (runtime.kind === "sdk" && contract.runtime === "sdk") {
      return await runtime.open(role, { ...spec, contract }, signal);
    }
    if (runtime.kind === "herdr" && contract.runtime === "herdr") {
      return await runtime.open(role, { ...spec, contract }, signal);
    }
    throw new Error("Session contract does not match the selected runtime");
  }

  private async openAgentSession(
    role: AgentRole,
    signal?: AbortSignal,
  ): Promise<OpenedAgentSession> {
    const activeSession = this.state.agentSessions[role];
    if (activeSession.status === "unresolved") {
      throw new Error(`Cannot open unresolved ${role} session before compatibility migration`);
    }
    if (activeSession.status === "active") {
      return await this.openPreparedSession(
        role,
        activeSession.contract,
        signal,
        activeSession.sessionId,
      );
    }
    let previousContract: AgentSessionContract | undefined;
    let observedChanges = 0;
    for (let attempt = 1; attempt <= MAX_AGENT_SESSION_PREPARATIONS; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error("Run interrupted");
      const settings = this.futureAgentSettings(role);
      const contract = await this.prepareSessionContract(role, settings, previousContract, signal);
      if (sameAgentRoleSettings(settings, this.futureAgentSettings(role))) {
        if (observedChanges > 0) {
          this.emit(
            "warning",
            "agent.settings_changed_during_open",
            `Applied updated ${role} settings before creating its session`,
            `${observedChanges} change${observedChanges === 1 ? "" : "s"} observed across ${attempt} preparation attempts; no external session was created`,
          );
        }
        return await this.openPreparedSession(role, contract, signal);
      }
      previousContract = contract;
      observedChanges += 1;
      if (attempt === MAX_AGENT_SESSION_PREPARATIONS) {
        this.emit(
          "warning",
          "agent.settings_changed_during_open",
          `Pinned ${role} settings after repeated changes during session preparation`,
          `${observedChanges} changes observed across ${attempt} preparation attempts; settings saved after the final preparation apply to the next session`,
        );
        return await this.openPreparedSession(role, contract, signal);
      }
    }
    throw new Error("Agent session preparation exhausted without producing a contract");
  }

  private async openReviewSessionWithIntegrityGuard(
    phase: "review" | "verification" | "final review",
    signal?: AbortSignal,
  ): Promise<{ agent: OpenedAgentSession; beforeStatus: string }> {
    const beforeStatus = await this.git.status();
    const beforeFingerprint = await this.git.reviewFingerprint();
    if (
      this.state.reviewBaselineFingerprint &&
      beforeFingerprint !== this.state.reviewBaselineFingerprint
    ) {
      throw new Error(
        `The working tree changed after an interrupted ${phase}; restore the original review state before resuming`,
      );
    }

    const agent = await this.openAgentSession("review", signal);
    const afterOpenStatus = await this.git.status();
    const afterOpenFingerprint = await this.git.reviewFingerprint();
    if (afterOpenFingerprint !== beforeFingerprint) {
      const label = `${phase[0]?.toUpperCase() ?? ""}${phase.slice(1)}`;
      throw new Error(
        `${label} session setup modified the working tree; refusing to include provider startup changes in the review baseline\nBefore:\n${beforeStatus}\nAfter:\n${afterOpenStatus}`,
      );
    }

    if (!this.state.reviewBaselineFingerprint) {
      this.state.reviewBaselineFingerprint = afterOpenFingerprint;
      this.save();
    }
    return { agent, beforeStatus };
  }

  private async runAgentTurn(
    role: AgentRole,
    opened: OpenedAgentSession,
    prompt: string,
    outputSchema: unknown,
    signal?: AbortSignal,
  ): Promise<TurnExecution> {
    const options: RunTurnOptions = {
      outputSchema,
      signal,
      onEvent: this.runtimeEvents(role, opened.contract),
    };
    const runtime = this.runtime;
    let execution: TurnExecution;
    if (runtime.kind === "sdk" && opened.runtime === "sdk") {
      execution = await runtime.run(opened, prompt, options);
    } else if (runtime.kind === "herdr" && opened.runtime === "herdr") {
      execution = await runtime.run(opened, prompt, options);
    } else {
      throw new Error("Opened session does not match the selected runtime");
    }
    this.setSession(role, execution.sessionId, opened.contract);
    return execution;
  }

  private sessionId(role: AgentRole): string | null {
    return runAgentSessionId(this.state, role);
  }

  private setSession(role: AgentRole, sessionId: string, contract: AgentSessionContract): void {
    this.state.agentSessions[role] = {
      status: "active",
      sessionId,
      contract,
    };
  }

  private clearSession(role: AgentRole): void {
    this.state.agentSessions[role] = { status: "inactive" };
  }

  private block(error: unknown, invocation: RunInvocationKind): string {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    let reportingError: unknown;
    try {
      this.persistBlockedState(message, invocation);
    } catch (saveError) {
      reportingError = saveError;
    }
    try {
      const cleanupOnly = invocation === "cleanup";
      this.emit(
        "error",
        cleanupOnly ? "agent.cleanup_needs_attention" : "run.blocked",
        cleanupOnly ? "Agent cleanup needs attention" : "Run needs attention",
        message,
      );
    } catch (eventError) {
      reportingError ??= eventError;
    }
    if (reportingError) {
      const detail =
        reportingError instanceof Error ? reportingError.message : String(reportingError);
      throw new Error(
        `${message}; additionally failed to persist the blocked-state report: ${detail}`,
        {
          cause: new AggregateError([error, reportingError]),
        },
      );
    }
    return message;
  }

  private persistBlockedState(message: string, invocation: RunInvocationKind): void {
    const failureFields = (
      source: RunState,
    ): Pick<RunState, "phase" | "resumePhase" | "lastError"> =>
      invocation === "cleanup"
        ? { phase: "complete", resumePhase: null, lastError: message }
        : {
            phase: "blocked",
            resumePhase:
              source.phase === "blocked" || source.phase === "paused"
                ? source.resumePhase
                : source.phase,
            lastError: message,
          };
    const failedState = (source: RunState): RunState =>
      RunStateSchema.parse({ ...source, ...failureFields(source) });

    const reportingSource =
      invocation === "workflow" && this.state.phase === "complete"
        ? this.store.get(this.state.runId)
        : this.state;
    if (!reportingSource) throw new Error(`Unknown epicd run ${this.state.runId}`);
    const candidate = RunStateSchema.safeParse({
      ...reportingSource,
      ...failureFields(reportingSource),
    });
    if (candidate.success) {
      Object.assign(this.state, candidate.data);
    } else {
      // A failed transition may leave the mutable aggregate between valid
      // phases. Error persistence must start from the last durable checkpoint,
      // not depend on the invariant that just failed.
      const checkpoint = this.store.get(this.state.runId);
      if (!checkpoint) throw new Error(`Unknown epicd run ${this.state.runId}`);
      Object.assign(this.state, failedState(checkpoint));
    }
    this.save();
  }

  private enqueueSessionCleanup(
    role: AgentRole,
    sessionId: string | null,
    runtime: RuntimeKind,
  ): void {
    if (!sessionId) return;
    const action: AgentCleanupAction = { kind: "session", runtime, role, sessionId };
    const key = cleanupActionKey(action);
    if (!this.state.pendingAgentCleanup.some((pending) => cleanupActionKey(pending) === key)) {
      this.state.pendingAgentCleanup.push(action);
    }
    if (this.sessionId(role) === sessionId) this.clearSession(role);
  }

  private async retireAgent(
    role: AgentRole,
    sessionId: string | null,
    runtime = this.state.runtime,
  ): Promise<void> {
    if (!sessionId) return;
    this.enqueueSessionCleanup(role, sessionId, runtime);
    this.save();
    await this.drainAgentCleanup();
  }

  private async retireRunAgents(runtime = this.state.runtime): Promise<void> {
    this.enqueueSessionCleanup("orchestrator", this.sessionId("orchestrator"), runtime);
    this.enqueueSessionCleanup("implementation", this.sessionId("implementation"), runtime);
    this.enqueueSessionCleanup("review", this.sessionId("review"), runtime);
    const runAction: AgentCleanupAction = { kind: "run", runtime };
    const runKey = cleanupActionKey(runAction);
    if (!this.state.pendingAgentCleanup.some((action) => cleanupActionKey(action) === runKey)) {
      this.state.pendingAgentCleanup.push(runAction);
    }
    this.save();
    await this.drainAgentCleanup();
  }

  private async drainAgentCleanup(): Promise<void> {
    const actions = [...this.state.pendingAgentCleanup].sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "run" ? -1 : 1,
    );
    for (const action of actions) {
      const key = cleanupActionKey(action);
      if (!this.state.pendingAgentCleanup.some((pending) => cleanupActionKey(pending) === key)) {
        continue;
      }
      try {
        // SDK sessions own no external resources. Acknowledging their cleanup intent must not
        // depend on an installed SDK binary; only Herdr cleanup needs a live runtime adapter.
        if (action.runtime === "herdr") {
          const runtime = createAgentRuntime(
            action.runtime,
            this.state,
            this.options,
            this.state.agentAccessMode,
          );
          if (action.kind === "run") await runtime.releaseAll();
          else await runtime.release(action.sessionId);
        }
      } catch (error) {
        const target =
          action.kind === "run"
            ? `every ${action.runtime} resource owned by this run`
            : `${action.role} session ${action.sessionId}`;
        this.emit(
          "warning",
          "agent.cleanup_failed",
          `Could not close ${target}`,
          redactSensitiveText(error instanceof Error ? error.message : String(error)),
        );
        continue;
      }

      const pendingBeforeSave = this.state.pendingAgentCleanup;
      this.state.pendingAgentCleanup = pendingBeforeSave.filter(
        (pending) => cleanupActionKey(pending) !== key,
      );
      try {
        this.save();
      } catch (error) {
        this.state.pendingAgentCleanup = pendingBeforeSave;
        throw error;
      }
      if (action.kind === "session" && action.reason === "unverifiable-session-contract") {
        this.emit(
          "warning",
          "agent.legacy_session_rotated",
          `Retired legacy ${action.role} session ${action.sessionId.slice(0, 12)}`,
          "Its exact SDK model contract could not be proven; the next turn will use a fresh session",
        );
      }
    }
  }

  private clearCompletedCleanupError(): void {
    if (
      this.state.phase !== "complete" ||
      this.state.pendingAgentCleanup.length > 0 ||
      AGENT_ROLES.some((role) => this.state.agentSessions[role].status !== "inactive") ||
      this.state.lastError === null
    ) {
      return;
    }
    this.state.lastError = null;
    this.save();
  }

  private applyPendingAgentContractSwitch(): void {
    const runtime = this.pendingRuntimeSwitch;
    const accessMode = this.pendingAccessModeSwitch;
    if (!runtime && accessMode === null) return;

    const previousRuntime = this.state.runtime;
    if (runtime) this.state.runtime = runtime;
    if (accessMode !== null) this.state.agentAccessMode = accessMode;
    for (const role of AGENT_ROLES) this.clearSession(role);
    this.save();
    this.pendingRuntimeSwitch = null;
    this.pendingAccessModeSwitch = null;
    const detail = "Previous agent sessions were discarded; workflow and Git state were preserved";
    if (runtime) {
      this.emit(
        "warning",
        "runtime.switched",
        `Switched runtime from ${previousRuntime} to ${runtime}`,
        detail,
      );
    }
    if (accessMode !== null) {
      this.emit(
        "warning",
        "permissions.switched",
        accessMode === "danger-full-access"
          ? "Enabled dangerous full access for all agents"
          : "Restored sandboxed agent permissions",
        detail,
      );
    }
  }

  async run(signal?: AbortSignal): Promise<RunState> {
    const lease: RunLease = this.store.acquireLease(this.state.runId);
    this.activeLease = lease.ownerToken;
    try {
      Object.assign(this.state, lease.state);
      const invocation: RunInvocationKind =
        this.state.phase === "complete" ? "cleanup" : "workflow";
      if (this.state.phase === "complete" && !runNeedsResume(this.state)) {
        this.notifyState(this.snapshot());
        return this.snapshot();
      }
      // Resume construction is only a preview. Revalidate options against the state protected
      // by this lease so a stale engine cannot apply workflow settings to cleanup-only work.
      if (this.resumeOptionsToValidate) {
        assertResumeOptionsAllowed(this.state, this.resumeOptionsToValidate);
      }
      try {
        this.applyRequestedSettings();
        this.refreshRuntimeContract();
        this.notifyState(this.snapshot());
        await this.drainAgentCleanup();
        this.clearCompletedCleanupError();
        if (this.pendingRuntimeSwitch || this.pendingAccessModeSwitch !== null) {
          await this.retireRunAgents(this.state.runtime);
        }
        this.applyPendingAgentContractSwitch();
        if (
          this.resumeRequested &&
          (this.state.phase === "paused" || this.state.phase === "blocked")
        ) {
          const recoversLegacyPostCommitBudget =
            this.state.phase === "blocked" &&
            this.state.resumePhase === "fixing" &&
            this.state.candidateRevision !== null &&
            /^Review did not converge after \d+ fix passes$/.test(this.state.lastError ?? "");
          if (recoversLegacyPostCommitBudget) {
            this.state.reviewPass = 0;
            this.emit(
              "warning",
              "repair.budget_recovered",
              "Recovered a fresh repair budget for post-commit verification findings",
              this.state.candidateRevision,
            );
          }
          const next = this.state.resumePhase ?? "selecting";
          this.state.lastError = null;
          this.state.resumePhase = null;
          this.resumeRequested = false;
          this.transition(next);
        }
        while (!new Set<RunPhase>(["complete", "blocked", "paused"]).has(this.state.phase)) {
          if (signal?.aborted) throw signal.reason ?? new Error("Run interrupted");
          if (this.pauseRequested) {
            this.state.resumePhase = this.state.phase;
            this.transition("paused");
            this.emit("warning", "run.paused", "Run paused safely between operations");
            break;
          }

          switch (this.state.phase) {
            case "preparing":
              this.transition("selecting");
              break;
            case "selecting":
              await this.selectNext(signal);
              break;
            case "claiming":
              await this.claimCurrent();
              break;
            case "implementing":
              await this.implementCurrent(signal);
              break;
            case "reviewing":
              await this.reviewCurrent(false, signal);
              break;
            case "fixing":
              await this.fixCurrent(signal);
              break;
            case "committing":
              await this.commitCurrent();
              break;
            case "verifying":
              await this.reviewCurrent(true, signal);
              break;
            case "closing":
              await this.closeCurrent();
              break;
            case "final_review":
              await this.finalReview(signal);
              break;
            case "paused":
            case "blocked":
            case "complete":
              break;
          }
        }
      } catch (error) {
        if (invocation === "workflow") {
          // Completion-event failure has its own explicit boundary. Mutable phase is not a
          // reliable proxy because a failed completion save also leaves it set to `complete`.
          if (error instanceof WorkflowCompletionReportingError) throw error;
          this.block(error, invocation);
        } else {
          let message: string;
          let cause = error;
          try {
            message = this.block(error, invocation);
          } catch (reportingError) {
            message =
              reportingError instanceof Error ? reportingError.message : String(reportingError);
            cause = reportingError;
          }
          throw new AgentCleanupRequiredError(this.state.runId, this.state.epicId, message, {
            cause,
          });
        }
      }
    } finally {
      try {
        this.store.releaseLease(this.state.runId, lease.ownerToken);
      } catch {
        process.emitWarning(
          `Could not release the controller lease for run ${this.state.runId}; inspect it with epicd status before resuming`,
        );
      } finally {
        this.activeLease = null;
      }
    }
    return this.snapshot();
  }

  private async selectNext(signal?: AbortSignal): Promise<void> {
    this.emit("info", "beads.refresh", "Refreshing epic graph and authoritative ready set");
    let snapshot = await this.beads.snapshot(this.state.epicId);
    if (await this.closeSatisfiedContainers(snapshot))
      snapshot = await this.beads.snapshot(this.state.epicId);

    const tasks = taskIssues(snapshot);
    this.state.completedTasks = tasks.filter((issue) => issue.status === "closed").length;
    this.state.totalTasks = tasks.length;
    this.save();

    const openTasks = tasks.filter((issue) => issue.status !== "closed");
    if (openTasks.length === 0) {
      this.emit(
        "success",
        "epic.tasks_complete",
        "All implementation tasks are closed; starting final epic verification",
      );
      this.clearSession("review");
      this.transition("final_review");
      return;
    }

    const readyCandidates = snapshot.readyIssues.filter(
      (issue) =>
        issue.issue_type !== "epic" &&
        issue.status !== "closed" &&
        openTasks.some((task) => task.id === issue.id),
    );
    const blockedIds = new Set((snapshot.blockedIssues ?? []).map((issue) => issue.id));
    const recoverableCandidates = openTasks.filter(
      (issue) =>
        issue.status === "in_progress" &&
        !blockedIds.has(issue.id) &&
        (issueAssignee(issue) === null || issueAssignee(issue) === `epicd:${this.state.runId}`),
    );
    const candidates = [
      ...new Map(
        [...readyCandidates, ...recoverableCandidates].map((issue) => [issue.id, issue]),
      ).values(),
    ];
    if (candidates.length === 0) {
      const ownership = openTasks
        .filter((issue) => issue.status === "in_progress")
        .map((issue) => {
          const owner = issueAssignee(issue) ?? "unassigned";
          const blocked = blockedIds.has(issue.id) ? ", dependency-blocked" : "";
          return `${issue.id} (${owner}${blocked})`;
        });
      const statuses = openTasks
        .filter((issue) => issue.status !== "in_progress")
        .map((issue) => `${issue.id} (${issue.status})`);
      const detail = [...ownership, ...statuses].join(", ");
      throw new Error(
        `${openTasks.length} implementation tasks remain, but none is claimable${detail ? `: ${detail}` : ""}`,
      );
    }

    const orchestratorSession = this.state.agentSessions.orchestrator;
    if (
      orchestratorSession.status === "active" &&
      !sameAgentRoleSettings(
        orchestratorSession.contract.requested,
        this.futureAgentSettings("orchestrator"),
      )
    ) {
      await this.retireAgent("orchestrator", orchestratorSession.sessionId);
      this.emit(
        "info",
        "orchestrator.settings_rotated",
        "Retired the coordinator so its updated settings apply to the next selection",
      );
    }
    const firstTurn = this.sessionId("orchestrator") === null;
    const beforeSelection = await this.git.reviewFingerprint();
    const agent = await this.openAgentSession("orchestrator", signal);
    this.emit(
      "info",
      "orchestrator.select",
      "Orchestrator is selecting the next dependency-safe task",
    );
    const execution = await this.runAgentTurn(
      "orchestrator",
      agent,
      selectionPrompt(
        { ...snapshot, readyIssues: candidates },
        firstTurn,
        this.state.recentOutcomes,
      ),
      SELECTION_OUTPUT_SCHEMA,
      signal,
    );
    if ((await this.git.reviewFingerprint()) !== beforeSelection) {
      throw new Error("Orchestrator modified the working tree while selecting the next task");
    }
    const selection = parseStructured(execution.finalResponse, SelectionResultSchema);
    const selected = candidates.find((issue) => issue.id === selection.candidateId);
    if (!selected)
      throw new Error(
        `Orchestrator selected ${selection.candidateId}, which is not in the exact ready candidate set`,
      );

    this.state.currentBeadId = selected.id;
    this.state.currentBeadTitle = selected.title;
    this.state.baseRevision = await this.git.head();
    this.state.candidateRevision = null;
    this.state.reviewBaselineFingerprint = null;
    this.state.reviewedFingerprint = null;
    this.state.reviewedTree = null;
    this.clearSession("implementation");
    this.clearSession("review");
    this.state.reviewPass = 0;
    this.state.pendingFindings = [];
    this.state.lastReviewSummary = null;
    this.emit(
      "success",
      "orchestrator.selected",
      `${selected.id}: ${selected.title}`,
      selection.rationale,
    );
    this.transition("claiming");
  }

  private async claimCurrent(): Promise<void> {
    const beadId = this.requireCurrentBead();
    const existing = await this.beads.show(beadId);
    const assignee = issueAssignee(existing);
    if (existing.status === "in_progress" && assignee === `epicd:${this.state.runId}`) {
      this.emit("info", "beads.claim_recovered", `Recovered completed claim for ${beadId}`);
    } else if (existing.status === "in_progress" && assignee === null) {
      this.emit(
        "warning",
        "beads.claim_reconciling",
        `Adopting unowned in-progress task ${beadId}`,
      );
      await this.beads.adoptUnownedInProgress(this.state.epicId, beadId, this.state.runId);
      this.emit("success", "beads.claim_reconciled", `Adopted ${beadId} for this run`);
    } else {
      this.emit(
        "info",
        "beads.claim_gate",
        `Running immediate br ready and br show gate for ${beadId}`,
      );
      await this.beads.claim(this.state.epicId, beadId, this.state.runId);
      this.emit("success", "beads.claimed", `Claimed ${beadId}`);
    }
    this.transition("implementing");
  }

  private async implementCurrent(signal?: AbortSignal): Promise<void> {
    const issue = await this.beads.show(this.requireCurrentBead());
    const epic = await this.beads.show(this.state.epicId);
    const implementationThreadId = this.sessionId("implementation");
    const recovery = implementationThreadId !== null || (await this.git.changedPaths()).length > 0;
    const agent = await this.openAgentSession("implementation", signal);
    this.emit(
      "info",
      "implementation.started",
      recovery
        ? `Resuming implementation of ${issue.id}`
        : `Starting implementation of ${issue.id}`,
    );
    const execution = await this.runAgentTurn(
      "implementation",
      agent,
      implementationPrompt(epic, issue, recovery),
      IMPLEMENTATION_OUTPUT_SCHEMA,
      signal,
    );
    const result = parseStructured(execution.finalResponse, ImplementationResultSchema);
    this.emit(
      result.status === "completed" ? "success" : "warning",
      "implementation.result",
      result.summary,
    );
    requireAcceptedImplementationResult(result, "implementation", issue.id);
    const paths = await this.git.changedPaths();
    if (paths.length === 0)
      throw new Error(
        `Implementation thread for ${issue.id} completed without application changes`,
      );
    this.clearSession("review");
    this.transition("reviewing");
  }

  private async reviewCurrent(exactRevision: boolean, signal?: AbortSignal): Promise<void> {
    const issue = await this.beads.show(this.requireCurrentBead());
    const epic = await this.beads.show(this.state.epicId);
    const reviewThreadId = this.sessionId("review");
    const verifyingFixes =
      !exactRevision && reviewThreadId !== null && this.state.pendingFindings.length > 0;
    const baseRevision = this.state.baseRevision;
    if (!baseRevision) throw new Error("Review requires a persisted base revision");
    const revision = exactRevision ? this.state.candidateRevision : null;
    if (exactRevision && !revision)
      throw new Error("Exact verification requires a candidate revision");
    if (revision) await this.git.assertExactRevision(revision);
    const { agent, beforeStatus: before } = await this.openReviewSessionWithIntegrityGuard(
      exactRevision ? "verification" : "review",
      signal,
    );
    this.emit(
      "info",
      exactRevision ? "verification.started" : "review.started",
      exactRevision
        ? `Verifying ${revision}`
        : verifyingFixes
          ? `Verifying fixes from review pass ${this.state.reviewPass}`
          : `Starting independent review pass ${this.state.reviewPass + 1}`,
    );
    const prompt = revision
      ? taskVerificationPrompt(issue, revision)
      : verifyingFixes
        ? reviewFixesPrompt(
            issue,
            this.state.pendingFindings,
            baseRevision,
            this.state.candidateRevision,
          )
        : taskReviewPrompt(epic, issue, baseRevision);
    const execution = await this.runAgentTurn(
      "review",
      agent,
      prompt,
      REVIEW_OUTPUT_SCHEMA,
      signal,
    );
    const after = await this.git.status();
    const afterFingerprint = await this.git.reviewFingerprint();
    if (afterFingerprint !== this.state.reviewBaselineFingerprint)
      throw new Error(
        `Reviewer modified the working tree; refusing to treat the review as independent\nBefore:\n${before}\nAfter:\n${after}`,
      );
    if (revision) await this.git.assertExactRevision(revision);

    const result = parseStructured(execution.finalResponse, ReviewResultSchema);
    this.state.lastReviewSummary = result.summary;
    if (exactRevision && result.revision !== revision) {
      throw new Error(
        `Verifier cited ${result.revision ?? "no revision"}; expected exact revision ${revision}`,
      );
    }

    if (isApproved(result)) {
      this.state.pendingFindings = [];
      this.state.reviewBaselineFingerprint = null;
      this.state.reviewedFingerprint = exactRevision ? null : afterFingerprint;
      this.state.reviewedTree = exactRevision ? null : await this.git.prospectiveTree();
      if (!exactRevision) this.state.reviewPass = 0;
      this.emit(
        "success",
        exactRevision ? "verification.approved" : "review.approved",
        result.summary,
        revision,
      );
      await this.retireAgent("review", this.sessionId("review"));
      this.transition(exactRevision ? "closing" : "committing");
      return;
    }

    if (result.verdict === "blocked") {
      throw new Error(`Review blocked: ${result.summary}`);
    }
    const failedTestFindings = result.tests
      .filter((test) => test.outcome === "failed")
      .map((test) => ({
        severity: "medium" as const,
        title: `Reviewer validation failed: ${test.command}`,
        detail: test.detail,
        file: null,
        line: null,
        remediation: `Diagnose and make ${test.command} pass without weakening its assertions.`,
      }));
    this.state.pendingFindings = [...result.findings, ...failedTestFindings];
    this.state.reviewBaselineFingerprint = null;
    this.state.reviewedFingerprint = null;
    this.state.reviewedTree = null;
    if (this.state.pendingFindings.length === 0) {
      throw new Error(
        `Reviewer requested changes without an actionable finding: ${result.summary}`,
      );
    }
    this.emit(
      "warning",
      "review.changes_requested",
      `${this.state.pendingFindings.length} finding(s) require fixes`,
      result.summary,
    );
    this.transition("fixing");
  }

  private async fixCurrent(signal?: AbortSignal): Promise<void> {
    if (this.state.reviewPass >= this.options.maxReviewPasses) {
      throw new Error(`Repair budget exhausted after ${this.options.maxReviewPasses} fix passes`);
    }
    const issue = await this.beads.show(this.requireCurrentBead());
    if (this.state.pendingFindings.length === 0)
      throw new Error("Fix phase has no persisted findings");
    const implementationThreadId = this.sessionId("implementation");
    const agent = await this.openAgentSession("implementation", signal);
    this.emit(
      "info",
      "fix.started",
      implementationThreadId
        ? `Sending ${this.state.pendingFindings.length} finding(s) to the implementation thread`
        : `Starting a fresh implementation session for ${this.state.pendingFindings.length} finding(s)`,
    );
    const execution = await this.runAgentTurn(
      "implementation",
      agent,
      fixPrompt(issue, this.state.pendingFindings, this.state.candidateRevision),
      IMPLEMENTATION_OUTPUT_SCHEMA,
      signal,
    );
    const result = parseStructured(execution.finalResponse, ImplementationResultSchema);
    requireAcceptedImplementationResult(result, "fix", issue.id);
    this.state.reviewPass += 1;
    this.state.reviewBaselineFingerprint = null;
    this.state.reviewedFingerprint = null;
    this.state.reviewedTree = null;
    this.emit("success", "fix.completed", result.summary);
    this.transition("reviewing");
  }

  private async commitCurrent(): Promise<void> {
    const issue = await this.beads.show(this.requireCurrentBead());
    const head = await this.git.head();
    const paths = await this.git.changedPaths();

    if (paths.length === 0 && this.state.baseRevision && head !== this.state.baseRevision) {
      if (!this.state.reviewedTree || (await this.git.tree(head)) !== this.state.reviewedTree) {
        throw new Error("HEAD changed after review and does not match the approved candidate tree");
      }
      this.state.candidateRevision = head;
      await this.retireAgent("review", this.sessionId("review"));
      this.state.reviewBaselineFingerprint = null;
      this.state.reviewedFingerprint = null;
      this.state.reviewedTree = null;
      this.emit("info", "git.commit_recovered", `Recovered candidate commit ${head}`);
      this.transition("verifying");
      return;
    }
    if (paths.length === 0) throw new Error("No application changes are available to commit");
    if (!this.state.reviewedFingerprint || !this.state.reviewedTree) {
      throw new Error("No approved working-tree evidence is available for this candidate");
    }
    const currentFingerprint = await this.git.reviewFingerprint();
    if (currentFingerprint !== this.state.reviewedFingerprint) {
      throw new Error(
        "The working tree changed after review; refusing to commit unreviewed content",
      );
    }

    this.emit("info", "git.committing", `Committing ${paths.length} changed path(s)`);
    await this.git.stageImplementation();
    const revision = await this.git.commit(commitSubject(issue));
    if ((await this.git.tree(revision)) !== this.state.reviewedTree) {
      throw new Error("Committed tree does not match the candidate approved by review");
    }
    this.state.candidateRevision = revision;
    await this.retireAgent("review", this.sessionId("review"));
    this.state.reviewBaselineFingerprint = null;
    this.state.reviewedFingerprint = null;
    this.state.reviewedTree = null;
    this.emit(
      "success",
      "git.committed",
      `Created candidate commit ${revision.slice(0, 12)}`,
      revision,
    );
    this.transition("verifying");
  }

  private async closeCurrent(): Promise<void> {
    const beadId = this.requireCurrentBead();
    const revision = this.state.candidateRevision;
    if (!revision)
      throw new Error("Cannot close a Bead without an independently verified revision");
    await this.git.assertExactRevision(revision);
    const issue = await this.beads.show(beadId);
    if (issue.status !== "closed") {
      await this.beads.close(beadId, `Completed and independently verified at ${revision}`);
    }
    await this.beads.sync();
    const trackerRevision = await this.git.commitBeadsIfChanged(`chore(beads): close ${beadId}`);
    this.emit(
      "success",
      "beads.closed",
      `Closed ${beadId}`,
      trackerRevision ? `Tracker revision ${trackerRevision}` : null,
    );

    this.state.recentOutcomes = [
      ...this.state.recentOutcomes,
      {
        beadId,
        title: this.state.currentBeadTitle ?? issue.title,
        verifiedRevision: revision,
        reviewSummary:
          this.state.lastReviewSummary ?? "Approved by an independent exact-revision verifier",
      },
    ].slice(-100);

    this.state.completedTasks += 1;
    await this.retireAgent("implementation", this.sessionId("implementation"));
    await this.retireAgent("review", this.sessionId("review"));
    this.state.currentBeadId = null;
    this.state.currentBeadTitle = null;
    this.state.baseRevision = null;
    this.state.candidateRevision = null;
    this.state.reviewBaselineFingerprint = null;
    this.state.reviewedFingerprint = null;
    this.state.reviewedTree = null;
    this.state.reviewPass = 0;
    this.state.pendingFindings = [];
    this.transition("selecting");
  }

  private async finalReview(signal?: AbortSignal): Promise<void> {
    const snapshot = await this.beads.snapshot(this.state.epicId);
    const head = await this.git.head();
    await this.git.assertExactRevision(head);
    const { agent, beforeStatus: before } = await this.openReviewSessionWithIntegrityGuard(
      "final review",
      signal,
    );
    this.emit("info", "epic.review_started", `Final epic verification at ${head.slice(0, 12)}`);
    const execution = await this.runAgentTurn(
      "review",
      agent,
      finalEpicReviewPrompt(snapshot, this.state.epicBaseRevision, head),
      REVIEW_OUTPUT_SCHEMA,
      signal,
    );
    const after = await this.git.status();
    const afterFingerprint = await this.git.reviewFingerprint();
    if (afterFingerprint !== this.state.reviewBaselineFingerprint)
      throw new Error(
        `Final reviewer modified the working tree\nBefore:\n${before}\nAfter:\n${after}`,
      );
    await this.git.assertExactRevision(head);
    const result = parseStructured(execution.finalResponse, ReviewResultSchema);
    if (result.revision !== head)
      throw new Error(`Final verifier did not cite exact revision ${head}`);
    if (!isApproved(result)) {
      this.state.pendingFindings = result.findings;
      this.state.reviewBaselineFingerprint = null;
      throw new Error(`Final epic verification failed: ${result.summary}`);
    }

    await this.completeVerifiedEpic(snapshot, head);
  }

  private async completeVerifiedEpic(snapshot: EpicSnapshot, head: string): Promise<void> {
    // The read-only review is over. Persist that boundary before the controller changes
    // tracker files, so recovery never compares its own closure commit to the review baseline.
    this.state.reviewBaselineFingerprint = null;
    this.save();
    if (snapshot.epic.status !== "closed") {
      await this.beads.close(
        snapshot.epic.id,
        `All descendant work independently verified at ${head}`,
      );
      await this.beads.sync();
      await this.git.commitBeadsIfChanged(`chore(beads): close ${snapshot.epic.id}`);
    }
    await this.retireRunAgents();
    this.transition("complete");
    try {
      this.emit(
        "success",
        "epic.complete",
        `${snapshot.epic.id} is complete`,
        `Verified revision ${head}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowCompletionReportingError(this.state.runId, this.state.epicId, message, {
        cause: error,
      });
    }
  }

  private async closeSatisfiedContainers(snapshot: EpicSnapshot): Promise<boolean> {
    const containers = snapshot.issues
      .filter(
        (issue) =>
          issue.issue_type === "epic" && issue.status !== "closed" && issue.status !== "tombstone",
      )
      .sort(compareIssuesDeepestFirst);
    let changed = false;
    for (const container of containers) {
      const descendants = snapshot.issues.filter((issue) => isIssueDescendant(issue, container));
      if (
        descendants.length > 0 &&
        descendants.every((issue) => issue.status === "closed" || issue.status === "tombstone")
      ) {
        await this.beads.close(
          container.id,
          "All descendant implementation work independently verified",
        );
        container.status = "closed";
        changed = true;
        this.emit(
          "success",
          "beads.container_closed",
          `Closed completed container ${container.id}`,
        );
      }
    }
    if (changed) {
      await this.beads.sync();
      await this.git.commitBeadsIfChanged("chore(beads): close completed epic containers");
    }
    return changed;
  }

  private requireCurrentBead(): string {
    if (!this.state.currentBeadId)
      throw new Error(`Phase ${this.state.phase} requires a current Bead`);
    return this.state.currentBeadId;
  }

  private runtimeEvents(
    role: AgentRole,
    contract: AgentSessionContract,
  ): (event: RuntimeEvent) => void {
    return (event) => {
      if (event.type === "session.started") {
        this.setSession(role, event.sessionId, contract);
        this.save();
        this.emit(
          "info",
          "agent.started",
          `${role} ${this.state.runtime} session ${event.sessionId.slice(0, 12)} started`,
          event.sessionId,
        );
        return;
      }
      if (event.type === "command.completed") {
        const level: EventLevel = event.status === "failed" ? "error" : "debug";
        const detail = event.exitCode === undefined ? event.status : `exit ${event.exitCode}`;
        this.emit(level, "agent.command", redactSensitiveText(event.command, 4_000), detail);
      } else if (event.type === "files.changed") {
        this.emit(
          "info",
          "agent.files",
          `${role} changed ${event.paths.length} file(s)`,
          event.paths.join("\n"),
        );
      } else if (event.type === "error") {
        this.emit("error", "agent.error", event.message);
      }
    };
  }
}
