import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BeadsClient } from "../adapters/beads.js";
import { CodexRuntime } from "../adapters/codex.js";
import { GitClient } from "../adapters/git.js";
import { HerdrRuntime } from "../adapters/herdr.js";
import type { AgentRole, AgentRuntime, RuntimeEvent } from "../adapters/runtime.js";
import { StateStore } from "../adapters/store.js";
import { redactSensitiveText } from "../util/redact.js";
import {
  IMPLEMENTATION_OUTPUT_SCHEMA,
  ImplementationResultSchema,
  REVIEW_OUTPUT_SCHEMA,
  ReviewResultSchema,
  SELECTION_OUTPUT_SCHEMA,
  SelectionResultSchema,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_MAX_REVIEW_PASSES,
  type AgentRoleSettings,
  type AgentSettings,
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

export type EpicEngineOptions = {
  repoPath: string;
  epicId: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  agentSettings?: Partial<Record<AgentRole, Partial<AgentRoleSettings>>>;
  runtime?: RuntimeKind;
  codexPath?: string;
  herdrPath?: string;
  maxReviewPasses?: number;
};

const agentRoles = ["orchestrator", "implementation", "review"] as const;

function applyAgentSettings(
  base: AgentSettings,
  options: Pick<EpicEngineOptions, "model" | "reasoningEffort" | "agentSettings">,
): AgentSettings {
  return Object.fromEntries(
    agentRoles.map((role) => {
      const roleOverride = options.agentSettings?.[role];
      return [
        role,
        {
          model: roleOverride?.model ?? options.model ?? base[role].model,
          reasoningEffort:
            roleOverride?.reasoningEffort ?? options.reasoningEffort ?? base[role].reasoningEffort,
        },
      ];
    }),
  ) as AgentSettings;
}

function effectiveAgentSettings(state: RunState): AgentSettings {
  return Object.fromEntries(
    agentRoles.map((role) => [
      role,
      { ...state.agentSettings[role], model: state.agentSettings[role].model ?? state.model },
    ]),
  ) as AgentSettings;
}

type EngineEvents = {
  event: [EngineEvent];
  state: [RunState];
};

function taskIssues(snapshot: EpicSnapshot): Issue[] {
  return snapshot.issues.filter(
    (issue) => issue.issue_type !== "epic" && issue.status !== "tombstone",
  );
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

export class EpicEngine {
  private readonly emitter = new EventEmitter<EngineEvents>();
  private readonly beads: BeadsClient;
  private readonly git: GitClient;
  private readonly runtime: AgentRuntime;
  private pendingRuntimeSwitch: RuntimeKind | null;
  private pauseRequested = false;
  private resumeRequested = false;

  private constructor(
    readonly store: StateStore,
    readonly state: RunState,
    private readonly options: Required<Pick<EpicEngineOptions, "maxReviewPasses">> &
      EpicEngineOptions,
  ) {
    this.beads = new BeadsClient(state.repoPath);
    this.git = new GitClient(state.repoPath);
    const settings = effectiveAgentSettings(state);
    const runtime = options.runtime ?? state.runtime;
    this.pendingRuntimeSwitch = runtime === state.runtime ? null : runtime;
    this.runtime =
      runtime === "herdr"
        ? new HerdrRuntime(state.repoPath, state.runId, settings, options.herdrPath)
        : new CodexRuntime(state.repoPath, settings, options.codexPath);
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
      runId: randomUUID(),
      repoPath,
      epicId: snapshot.epic.id,
      epicTitle: snapshot.epic.title,
      model: options.model ?? null,
      runtime: options.runtime ?? "sdk",
      agentSettings: applyAgentSettings(DEFAULT_AGENT_SETTINGS, options),
      maxReviewPasses: options.maxReviewPasses ?? DEFAULT_MAX_REVIEW_PASSES,
      phase: "preparing",
      currentBeadId: null,
      currentBeadTitle: null,
      orchestratorThreadId: null,
      implementationThreadId: null,
      reviewThreadId: null,
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
    store.create(state);
    const engine = new EpicEngine(store, state, {
      ...options,
      repoPath,
      maxReviewPasses: state.maxReviewPasses,
    });
    engine.emit(
      "success",
      "run.created",
      `Prepared ${snapshot.epic.id}`,
      `${state.totalTasks} implementation tasks`,
    );
    engine.transition("selecting");
    return engine;
  }

  static resume(
    state: RunState,
    options: Omit<EpicEngineOptions, "repoPath" | "epicId"> = {},
    store = new StateStore(),
  ): EpicEngine {
    if (
      options.maxReviewPasses !== undefined &&
      options.maxReviewPasses !== state.maxReviewPasses
    ) {
      throw new Error(
        `Run ${state.runId.slice(0, 8)} has a persisted repair budget of ${state.maxReviewPasses} passes; start a new run to change it`,
      );
    }
    const currentSettings = effectiveAgentSettings(state);
    const requestedSettings = applyAgentSettings(currentSettings, options);
    if (JSON.stringify(requestedSettings) !== JSON.stringify(currentSettings)) {
      throw new Error(
        `Run ${state.runId.slice(0, 8)} has persisted per-role model/reasoning settings; start a new run to change them`,
      );
    }
    return new EpicEngine(store, state, {
      ...options,
      repoPath: state.repoPath,
      epicId: state.epicId,
      maxReviewPasses: state.maxReviewPasses,
    });
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  onState(listener: (state: RunState) => void): () => void {
    this.emitter.on("state", listener);
    return () => this.emitter.off("state", listener);
  }

  requestPause(): void {
    this.pauseRequested = true;
    this.emit(
      "warning",
      "run.pause_requested",
      "Pause requested; epicd will stop after the current operation",
    );
  }

  continueRun(): void {
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
    const event = this.store.addEvent(this.state.runId, level, kind, message, detail);
    this.emitter.emit("event", event);
  }

  private save(): void {
    this.store.save(this.state);
    this.emitter.emit("state", { ...this.state, pendingFindings: [...this.state.pendingFindings] });
  }

  private transition(phase: RunPhase): void {
    this.state.phase = phase;
    this.state.lastError = null;
    this.save();
  }

  private block(error: unknown): void {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    if (this.state.phase !== "blocked") this.state.resumePhase = this.state.phase;
    this.state.phase = "blocked";
    this.state.lastError = message;
    this.save();
    this.emit("error", "run.blocked", "Run needs attention", message);
  }

  private applyPendingRuntimeSwitch(): void {
    const runtime = this.pendingRuntimeSwitch;
    if (!runtime) return;

    const previousRuntime = this.state.runtime;
    this.state.runtime = runtime;
    this.state.orchestratorThreadId = null;
    this.state.implementationThreadId = null;
    this.state.reviewThreadId = null;
    this.save();
    this.pendingRuntimeSwitch = null;
    this.emit(
      "warning",
      "runtime.switched",
      `Switched runtime from ${previousRuntime} to ${runtime}`,
      "Previous agent sessions were discarded; workflow and Git state were preserved",
    );
  }

  async run(signal?: AbortSignal): Promise<RunState> {
    let lease: string;
    try {
      lease = this.store.acquireLease(this.state.runId);
    } catch (error) {
      this.emit(
        "error",
        "run.already_active",
        "Another epicd process already controls this run",
        error instanceof Error ? error.message : String(error),
      );
      return this.state;
    }
    try {
      this.applyPendingRuntimeSwitch();
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
      this.block(error);
    } finally {
      this.store.releaseLease(this.state.runId, lease);
    }
    return this.state;
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
      this.state.reviewThreadId = null;
      this.transition("final_review");
      return;
    }

    const candidates = snapshot.readyIssues.filter(
      (issue) =>
        issue.issue_type !== "epic" &&
        issue.status !== "closed" &&
        openTasks.some((task) => task.id === issue.id),
    );
    if (candidates.length === 0) {
      throw new Error(
        `${openTasks.length} implementation tasks remain, but br ready returned no concrete descendant`,
      );
    }

    const orchestratorThreadId = this.state.orchestratorThreadId;
    const firstTurn = orchestratorThreadId === null;
    const beforeSelection = await this.git.reviewFingerprint();
    const thread = firstTurn
      ? this.runtime.start("orchestrator")
      : this.runtime.resume(orchestratorThreadId, "orchestrator");
    this.emit(
      "info",
      "orchestrator.select",
      "Orchestrator is selecting the next dependency-safe task",
    );
    const execution = await this.runtime.run(
      thread,
      selectionPrompt(
        { ...snapshot, readyIssues: candidates },
        firstTurn,
        this.state.recentOutcomes,
      ),
      {
        outputSchema: SELECTION_OUTPUT_SCHEMA,
        signal,
        onEvent: this.runtimeEvents("orchestrator"),
      },
    );
    this.state.orchestratorThreadId = execution.sessionId;
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
    this.state.implementationThreadId = null;
    this.state.reviewThreadId = null;
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
    const assignee = typeof existing.assignee === "string" ? existing.assignee : null;
    if (existing.status === "in_progress" && assignee === `epicd:${this.state.runId}`) {
      this.emit("info", "beads.claim_recovered", `Recovered completed claim for ${beadId}`);
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
    const implementationThreadId = this.state.implementationThreadId;
    const recovery = implementationThreadId !== null || (await this.git.changedPaths()).length > 0;
    const thread = implementationThreadId
      ? this.runtime.resume(implementationThreadId, "implementation")
      : this.runtime.start("implementation");
    this.emit(
      "info",
      "implementation.started",
      recovery
        ? `Resuming implementation of ${issue.id}`
        : `Starting implementation of ${issue.id}`,
    );
    const execution = await this.runtime.run(thread, implementationPrompt(epic, issue, recovery), {
      outputSchema: IMPLEMENTATION_OUTPUT_SCHEMA,
      signal,
      onEvent: this.runtimeEvents("implementation"),
    });
    this.state.implementationThreadId = execution.sessionId;
    const result = parseStructured(execution.finalResponse, ImplementationResultSchema);
    this.emit(
      result.status === "completed" ? "success" : "warning",
      "implementation.result",
      result.summary,
    );
    if (result.status === "blocked")
      throw new Error(`Implementation blocked: ${result.blockers.join("; ")}`);
    if (
      !result.tests.some((test) => test.outcome === "passed") ||
      result.tests.some((test) => test.outcome === "failed")
    ) {
      throw new Error(
        `Implementation did not provide a passing, failure-free validation result for ${issue.id}`,
      );
    }
    const paths = await this.git.changedPaths();
    if (paths.length === 0)
      throw new Error(
        `Implementation thread for ${issue.id} completed without application changes`,
      );
    this.state.reviewThreadId = null;
    this.transition("reviewing");
  }

  private async reviewCurrent(exactRevision: boolean, signal?: AbortSignal): Promise<void> {
    const issue = await this.beads.show(this.requireCurrentBead());
    const epic = await this.beads.show(this.state.epicId);
    const before = await this.git.status();
    const reviewThreadId = this.state.reviewThreadId;
    const verifyingFixes =
      !exactRevision && reviewThreadId !== null && this.state.pendingFindings.length > 0;
    const thread = reviewThreadId
      ? this.runtime.resume(reviewThreadId, "review")
      : this.runtime.start("review");
    const baseRevision = this.state.baseRevision;
    if (!baseRevision) throw new Error("Review requires a persisted base revision");
    const revision = exactRevision ? this.state.candidateRevision : null;
    if (exactRevision && !revision)
      throw new Error("Exact verification requires a candidate revision");
    if (revision) await this.git.assertExactRevision(revision);
    const beforeFingerprint = await this.git.reviewFingerprint();
    if (
      this.state.reviewBaselineFingerprint &&
      beforeFingerprint !== this.state.reviewBaselineFingerprint
    ) {
      throw new Error(
        "The working tree changed after an interrupted review; restore the original review state before resuming",
      );
    }
    if (!this.state.reviewBaselineFingerprint) {
      this.state.reviewBaselineFingerprint = beforeFingerprint;
      this.save();
    }
    this.emit(
      "info",
      exactRevision ? "verification.started" : "review.started",
      exactRevision
        ? `Verifying ${revision}`
        : verifyingFixes
          ? `Verifying fixes from review pass ${this.state.reviewPass}`
          : `Starting independent review pass ${this.state.reviewPass + 1}`,
    );
    const prompt = exactRevision
      ? taskVerificationPrompt(issue, revision as string)
      : verifyingFixes
        ? reviewFixesPrompt(
            issue,
            this.state.pendingFindings,
            baseRevision,
            this.state.candidateRevision,
          )
        : taskReviewPrompt(epic, issue, baseRevision);
    const execution = await this.runtime.run(thread, prompt, {
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      signal,
      onEvent: this.runtimeEvents("review"),
    });
    this.state.reviewThreadId = execution.sessionId;
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
      this.state.reviewThreadId = null;
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
    const implementationThreadId = this.state.implementationThreadId;
    const thread = implementationThreadId
      ? this.runtime.resume(implementationThreadId, "implementation")
      : this.runtime.start("implementation");
    this.emit(
      "info",
      "fix.started",
      implementationThreadId
        ? `Sending ${this.state.pendingFindings.length} finding(s) to the implementation thread`
        : `Starting a fresh implementation session for ${this.state.pendingFindings.length} finding(s)`,
    );
    const execution = await this.runtime.run(
      thread,
      fixPrompt(issue, this.state.pendingFindings, this.state.candidateRevision),
      {
        outputSchema: IMPLEMENTATION_OUTPUT_SCHEMA,
        signal,
        onEvent: this.runtimeEvents("implementation"),
      },
    );
    this.state.implementationThreadId = execution.sessionId;
    const result = parseStructured(execution.finalResponse, ImplementationResultSchema);
    if (result.status === "blocked") throw new Error(`Fix blocked: ${result.blockers.join("; ")}`);
    if (
      !result.tests.some((test) => test.outcome === "passed") ||
      result.tests.some((test) => test.outcome === "failed")
    ) {
      throw new Error(
        `Fix turn did not provide a passing, failure-free validation result for ${issue.id}`,
      );
    }
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
      this.state.reviewBaselineFingerprint = null;
      this.state.reviewedFingerprint = null;
      this.state.reviewedTree = null;
      this.state.reviewThreadId = null;
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
    this.state.reviewBaselineFingerprint = null;
    this.state.reviewedFingerprint = null;
    this.state.reviewedTree = null;
    this.state.reviewThreadId = null;
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
    this.state.currentBeadId = null;
    this.state.currentBeadTitle = null;
    this.state.baseRevision = null;
    this.state.candidateRevision = null;
    this.state.reviewBaselineFingerprint = null;
    this.state.reviewedFingerprint = null;
    this.state.reviewedTree = null;
    this.state.implementationThreadId = null;
    this.state.reviewThreadId = null;
    this.state.reviewPass = 0;
    this.state.pendingFindings = [];
    this.transition("selecting");
  }

  private async finalReview(signal?: AbortSignal): Promise<void> {
    const snapshot = await this.beads.snapshot(this.state.epicId);
    const head = await this.git.head();
    await this.git.assertExactRevision(head);
    const before = await this.git.status();
    const beforeFingerprint = await this.git.reviewFingerprint();
    if (
      this.state.reviewBaselineFingerprint &&
      beforeFingerprint !== this.state.reviewBaselineFingerprint
    ) {
      throw new Error(
        "The working tree changed after an interrupted final review; restore the original review state before resuming",
      );
    }
    if (!this.state.reviewBaselineFingerprint) {
      this.state.reviewBaselineFingerprint = beforeFingerprint;
      this.save();
    }
    const reviewThreadId = this.state.reviewThreadId;
    const thread = reviewThreadId
      ? this.runtime.resume(reviewThreadId, "review")
      : this.runtime.start("review");
    this.emit("info", "epic.review_started", `Final epic verification at ${head.slice(0, 12)}`);
    const execution = await this.runtime.run(
      thread,
      finalEpicReviewPrompt(snapshot, this.state.epicBaseRevision, head),
      {
        outputSchema: REVIEW_OUTPUT_SCHEMA,
        signal,
        onEvent: this.runtimeEvents("review"),
      },
    );
    this.state.reviewThreadId = execution.sessionId;
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

    if (snapshot.epic.status !== "closed") {
      await this.beads.close(
        snapshot.epic.id,
        `All descendant work independently verified at ${head}`,
      );
      await this.beads.sync();
      await this.git.commitBeadsIfChanged(`chore(beads): close ${snapshot.epic.id}`);
    }
    this.state.reviewThreadId = null;
    this.state.reviewBaselineFingerprint = null;
    this.transition("complete");
    this.emit(
      "success",
      "epic.complete",
      `${snapshot.epic.id} is complete`,
      `Verified revision ${head}`,
    );
  }

  private async closeSatisfiedContainers(snapshot: EpicSnapshot): Promise<boolean> {
    const containers = snapshot.issues
      .filter(
        (issue) =>
          issue.issue_type === "epic" && issue.status !== "closed" && issue.status !== "tombstone",
      )
      .sort((a, b) => b.id.split(".").length - a.id.split(".").length);
    let changed = false;
    for (const container of containers) {
      const descendants = snapshot.issues.filter((issue) =>
        issue.id.startsWith(`${container.id}.`),
      );
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

  private runtimeEvents(role: AgentRole): (event: RuntimeEvent) => void {
    return (event) => {
      if (event.type === "session.started") {
        if (role === "orchestrator") this.state.orchestratorThreadId = event.sessionId;
        else if (role === "implementation") this.state.implementationThreadId = event.sessionId;
        else this.state.reviewThreadId = event.sessionId;
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
