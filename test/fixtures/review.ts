import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach } from "vitest";
import { StateStore } from "../../src/adapters/store.js";
import { WorkspaceManager } from "../../src/adapters/workspaces.js";
import { ControlledSdkRuntime } from "../../src/adapters/controlled-sdk.js";
import { ActionKernel } from "../../src/kernel/actions.js";
import { registerAgentCapabilities } from "../../src/kernel/agents.js";
import { registerDeliveryCapabilities } from "../../src/kernel/delivery.js";
import { registerCommitCapabilities } from "../../src/kernel/commits.js";
import { registerPublicationCapabilities } from "../../src/kernel/publication.js";
import { registerReviewCapabilities } from "../../src/kernel/reviews.js";
import { RepositoryPolicySchema, RequiredCheckSchema } from "../../src/domain/repository-policy.js";
import { SdkAgentSessionContractSchema } from "../../src/domain/types.js";
import {
  type ActionResult,
  type ControllerAuthority,
  type KernelAction,
} from "../../src/domain/orchestration.js";
import type { CandidateIdentity } from "../../src/domain/delivery.js";
import type { AdaptiveReviewResult } from "../../src/domain/reviews.js";
import type { WorkspaceIdentity } from "../../src/domain/agents.js";
import { initialRun } from "./orchestration/state.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const emit = (value: unknown) => `printf '%s\\n' ${quote(JSON.stringify(value))}`;
export const target = (workspace: WorkspaceIdentity) => ({
  workspaceId: workspace.workspaceId,
  workspaceGeneration: workspace.workspaceGeneration,
});
export const check = RequiredCheckSchema.parse({
  id: "app-check",
  command: "/bin/sh",
  args: ["-c", 'test "$(cat app.txt)" = green'],
  cwd: ".",
  timeoutMs: 5000,
});
export const finding = {
  severity: "high" as const,
  title: "Missing behavior",
  detail: "The acceptance criterion is not met at the identified branch.",
  file: "app.txt",
  line: 1,
  remediation: "Handle this branch and add a regression check.",
};
export function git(path: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", path, ...args],
    { encoding: "utf8" },
  ).trim();
}
export function success(result: ActionResult) {
  if (result.status !== "succeeded") throw new Error(JSON.stringify(result));
  return result.result;
}
export function resource(result: ActionResult) {
  const payload = success(result);
  if (payload.kind !== "resource") throw new Error("Expected resource");
  return payload;
}

// Real private Git copies, SQLite ownership, supervisor and read-only process mounts.
// Provider judgments are explicitly scripted; this suite does not certify model competence.
export async function fixture(required = check, format: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync("/var/tmp/epicd-review-");
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "--quiet", `--object-format=${format}`);
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "app.txt"), "red\n");
  mkdirSync(join(source, ".beads"));
  writeFileSync(join(source, ".beads/issues.jsonl"), "tracker\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "baseline");
  const head = git(source, "rev-parse", "HEAD");
  const path = join(root, "state.sqlite3");
  let store = new StateStore(path);
  const state = store.createAdaptive(
    { ...initialRun(), repoPath: source, epicBaseRevision: head },
    RepositoryPolicySchema.parse({ schemaVersion: 1, requiredChecks: [required] }),
  );
  const lease = store.acquireLease(state.runId);
  let authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const journal = store.orchestration;
  const manager = new WorkspaceManager(journal, join(root, "managed"));
  const workspace = await manager.create(authority, source, head, "implementation");
  const settings = { model: "worker-model", reasoningEffort: "high" as const };
  const contract = SdkAgentSessionContractSchema.parse({
    runtime: "sdk",
    requested: settings,
    effective: settings,
  });
  const writer = journal.agents.reserveAgent(
    authority,
    {
      ...target(workspace),
      role: "implementation",
      purpose: "implementation",
      taskId: "demo.1",
      candidateId: null,
      instructions: "Implement green behavior",
      confinementProfile: "fixture-only",
      contract,
    },
    journal.control(state.runId).controlVersion,
  );
  writeFileSync(join(workspace.path, "app.txt"), "green\n");
  mkdirSync(join(root, "bin"));
  const executable = join(root, "bin/codex");
  copyFileSync("/bin/false", join(root, "bin/codex-code-mode-host"));
  const options = {
    root: join(root, "runtime"),
    executable,
    authCachePath: null,
    launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
    turnTimeoutMs: 30_000,
  };
  const driver = new ControlledSdkRuntime(journal, options);
  const kernel = new ActionKernel(journal);
  registerDeliveryCapabilities(kernel, manager);
  registerCommitCapabilities(kernel, manager);
  const publication = registerPublicationCapabilities(kernel, manager);
  registerAgentCapabilities(kernel, driver, () => contract);
  registerReviewCapabilities(kernel, manager, driver, () => contract);
  const decision = (action: KernelAction) => {
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(state.runId),
      journal.control(state.runId).controlVersion,
    );
    return {
      explanation: "Inspect current independent evidence",
      evidenceIds: [],
      request: {
        schemaVersion: 1 as const,
        decisionId: ticket.decisionId,
        observationCursor: ticket.observationCursor,
        expectedControlVersion: ticket.expectedControlVersion,
        action,
      },
    };
  };
  const dispatch = async (action: KernelAction) => {
    const result = await kernel.execute(decision(action), authority);
    return result.status === "running" ? await kernel.operation(result.operationId)! : result;
  };
  const { stage: _stage, ...proposedCheck } = required;
  const define = async () =>
    resource(
      await dispatch({
        kind: "define_validation_plan",
        taskId: "demo.1",
        acceptanceCriteria: ["The application reports green"],
        checks: [proposedCheck],
      }),
    ).resourceId;
  const capture = async (planId: string): Promise<CandidateIdentity> => {
    const result = resource(
      await dispatch({
        kind: "capture_candidate",
        taskId: "demo.1",
        ...target(workspace),
        validationPlanId: planId,
      }),
    );
    return { candidateId: result.resourceId, candidateGeneration: result.generation };
  };
  const copy = async (candidate: CandidateIdentity, revision: string | null = null) => {
    const result = resource(
      await dispatch({ kind: "create_review_workspace", ...candidate, revision }),
    );
    return journal.agents.workspace(state.runId, {
      workspaceId: result.resourceId,
      workspaceGeneration: result.generation,
    });
  };
  const validate = async (
    candidate: CandidateIdentity,
    reviewCopy: WorkspaceIdentity,
    checkId = required.id,
  ) => {
    const validationPlanId = journal.delivery.candidate(state.runId, candidate).validationPlanId;
    return success(
      await dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(reviewCopy),
        validationPlanId,
        checkId,
      }),
    );
  };
  const report = (
    candidate: CandidateIdentity,
    changes: Partial<AdaptiveReviewResult> = {},
  ): AdaptiveReviewResult => ({
    verdict: "approved",
    summary: "Scripted independent judgment",
    revision: journal.delivery.candidate(state.runId, candidate).snapshot!.snapshotRevision,
    validationPlanId: journal.delivery.candidate(state.runId, candidate).validationPlanId,
    planAdequacy: "adequate",
    adequacyReason: "The declared criteria have corresponding checks",
    requiredChecks: [],
    validationEvidenceIds: journal.delivery
      .preCommitEvidence(state.runId, candidate)
      .evidence.map((entry) => entry.evidenceId),
    findings: [],
    resolutions: [],
    residualRisks: [],
    ...changes,
  });
  const response = (result: unknown, commands: string[] = [], sessionId: string = randomUUID()) => {
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        'cat > "$CODEX_HOME/fixture-prompt.json"',
        emit({ type: "thread.started", thread_id: sessionId }),
        emit({ type: "turn.started" }),
        ...commands,
        emit({
          type: "item.completed",
          item: { id: "response", type: "agent_message", text: JSON.stringify(result) },
        }),
        emit({
          type: "turn.completed",
          usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 },
        }),
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
  };
  const review = async (
    candidate: CandidateIdentity,
    changes: Partial<AdaptiveReviewResult> = {},
    commands: string[] = [],
    revision: string | null = null,
  ) => {
    const reviewCopy = await copy(candidate, revision);
    const phase = revision === null ? "pre_commit" : "exact_revision";
    response(
      report(candidate, {
        ...(revision ? { revision } : {}),
        validationEvidenceIds: journal.delivery
          .validationEvidence(state.runId, candidate, phase, revision ?? undefined)
          .evidence.map((entry) => entry.evidenceId),
        ...changes,
      }),
      commands,
    );
    const action: KernelAction = {
      kind: "run_review",
      ...candidate,
      ...target(reviewCopy),
      agent: null,
      instructions: "Check all criteria, not the implementer's completion claim",
    };
    const result = await dispatch(action);
    return { result, reviewCopy, evidence: journal.reviews.records(state.runId).at(-1)! };
  };
  cleanups.push(async () => {
    kernel.interruptAll();
    let settled = true;
    const recovery = new ControlledSdkRuntime(store.orchestration, options);
    for (const turn of store.orchestration.agents.turns(state.runId))
      if (!turn.stopEvidence) {
        try {
          await recovery.reconcile(authority, turn.identity);
        } catch {
          settled = false;
        }
        if (!store.orchestration.agents.turn(state.runId, turn.identity).stopEvidence)
          settled = false;
      }
    store.close();
    if (!settled) throw new Error(`Preserved uncertain review processes at ${root}`);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    source,
    head,
    journal,
    manager,
    publication,
    workspace,
    writer,
    kernel,
    driver,
    decision,
    dispatch,
    define,
    capture,
    copy,
    validate,
    report,
    response,
    review,
    get store() {
      return store;
    },
    get authority() {
      return authority;
    },
    reopen: () => {
      store.close();
      store = new StateStore(path);
      return store;
    },
    newLease: () => {
      store.releaseLease(state.runId, authority.ownerToken);
      const next = store.acquireLease(state.runId);
      authority = { runId: state.runId, ownerToken: next.ownerToken, leaseId: next.leaseId };
      return authority;
    },
  };
}
export async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Review did not reach expected state");
    await delay(20);
  }
}
