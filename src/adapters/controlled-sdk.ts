import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority, TurnIdentity } from "../domain/orchestration.js";
import type { TurnRecord } from "../domain/agents.js";
import {
  CodexLaunchSchema,
  type CodexLaunch,
  type CodexLaunchStop,
} from "../domain/codex-launch.js";
import { codexConfinementConfig, writeCodexConfinement } from "./codex-confinement.js";
import {
  controlCodexLaunch,
  materializeCodexLauncher,
  preventCodexLaunchStart,
  readCodexLaunchStop,
} from "./codex-launch.js";
import { normalizeCodexEvent } from "./codex.js";
import { redactSensitiveText } from "../util/redact.js";

export type ControlledSdkOptions = {
  root: string;
  executable: string;
  authCachePath: string | null;
  launcherEntrypoint?: string;
  turnTimeoutMs?: number;
};

/** Actual SDK dispatch through the persisted agent turn, not the legacy runtime's in-memory handle. */
export class ControlledSdkRuntime {
  readonly kind = "sdk";
  constructor(
    private readonly journal: OrchestrationJournal,
    private readonly options: ControlledSdkOptions,
  ) {
    if (!isAbsolute(options.root) || resolve(options.root) !== options.root || options.root === "/")
      throw new Error("Controlled runtime storage needs an explicit private root");
    if (
      options.turnTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.turnTimeoutMs) ||
        options.turnTimeoutMs < 1 ||
        options.turnTimeoutMs > 21_600_000)
    )
      throw new Error("Agent timeout must be between one millisecond and six hours");
  }

  async run(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    signal?: AbortSignal,
  ): Promise<TurnRecord> {
    this.journal.assertAuthority(authority);
    const initial = this.journal.agents.turn(authority.runId, identity);
    const agent = this.journal.agents.instance(authority.runId, identity);
    if (agent.contract.runtime !== "sdk")
      throw new Error("Controlled SDK dispatch requires an SDK assignment");
    if (initial.status !== "prepared" || initial.launch)
      throw new Error("Reconcile an existing launch instead of dispatching it again");
    const workspace = this.journal.agents.workspace(authority.runId, identity);
    const home = join(
      this.options.root,
      authority.runId,
      `${agent.agentId}-${agent.agentGeneration}`,
    );
    const manifest = CodexLaunchSchema.parse({
      generation: randomUUID(),
      confinement: {
        executable: this.options.executable,
        workspace: workspace.path,
        sourceMode: workspace.sourceMode === "immutable" ? "read-only" : "workspace-write",
        providerHome: join(home, "provider"),
        scratch: join(home, "scratch"),
        artifacts: join(home, "artifacts"),
      },
      model: agent.contract.effective.model,
      reasoningEffort: agent.contract.effective.reasoningEffort,
      authCachePath: this.options.authCachePath,
      controlDirectory: join(home, "launches", identity.turnId),
    });
    this.journal.agents.bindLaunch(authority, identity, manifest);
    // No await between reservation and dispatch admission. A second caller cannot
    // materialize or launch this turn after the first changes its durable state.
    const turn = this.journal.agents.markSubmitting(authority, identity);
    const request = new AbortController();
    const abort = () => request.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(
      () => request.abort(new Error("Agent turn deadline exceeded")),
      this.options.turnTimeoutMs ?? 1_800_000,
    );
    const check = () => {
      this.journal.assertAuthority(authority);
      const control = this.journal.control(authority.runId);
      const current = this.journal.agents.turn(authority.runId, identity);
      const owner = this.journal.agents.instance(authority.runId, identity);
      const copy = this.journal.agents.workspace(authority.runId, identity);
      if (
        control.status !== "active" ||
        control.policyDigest !== turn.policyDigest ||
        owner.status !== "busy" ||
        owner.activeTurnId !== identity.turnId ||
        copy.status !== "ready" ||
        copy.activeTurnId !== identity.turnId ||
        current.stopRequested ||
        current.stopEvidence !== null ||
        current.launch?.manifest.generation !== manifest.generation
      )
        throw new Error("Agent turn authority changed");
      request.signal.throwIfAborted();
    };
    const health = setInterval(() => {
      try {
        check();
      } catch (error) {
        request.abort(error);
      }
    }, 100);
    let invoked = false;
    let completed = false;
    let result: unknown = null;
    let diagnostic: string | null = null;
    let sequence = 0;
    let onStreamAbort: (() => void) | undefined;
    try {
      await this.prepareStorage(manifest);
      const launcher = await materializeCodexLauncher(manifest, this.options.launcherEntrypoint);
      check();
      const client = new Codex({
        codexPathOverride: launcher.executable,
        env: { PATH: "/usr/bin:/bin" },
      });
      const settings = {
        model: manifest.model,
        modelReasoningEffort: manifest.reasoningEffort,
        workingDirectory: workspace.path,
        approvalPolicy: "never" as const,
        skipGitRepoCheck: true,
        threadSource: `epicd-${agent.role}`,
      };
      const thread =
        agent.provider?.runtime === "sdk"
          ? client.resumeThread(agent.provider.sessionId, settings)
          : client.startThread(settings);
      invoked = true;
      const interrupted = new Promise<never>((_, reject) => {
        onStreamAbort = () => reject(new Error("Agent stream interrupted; reconcile its launcher"));
        request.signal.addEventListener("abort", onStreamAbort, { once: true });
        if (request.signal.aborted) onStreamAbort();
      });
      // Own interruption through the durable supervisor. SDK 0.153.4 removes
      // ChildProcess error listeners during iterator cleanup; aborting its spawn
      // signal afterward can emit an uncaught AbortError in the controller.
      await Promise.race([
        (async () => {
          const streamed = await thread.runStreamed(JSON.stringify(turn.prompt), {
            outputSchema: turn.outputSchema,
          });
          let response = "";
          for await (const event of streamed.events) {
            check();
            if (event.type === "thread.started")
              this.journal.agents.bindTurnProvider(authority, identity, {
                runtime: "sdk",
                sessionId: event.thread_id,
              });
            if (event.type === "turn.started") {
              if (!thread.id) throw new Error("SDK accepted a turn without a correlated session");
              this.journal.agents.acknowledgePrompt(
                authority,
                identity,
                turn.promptDigest,
                `SDK turn.started from launcher ${manifest.generation}, session ${thread.id}`,
              );
            }
            const normalized = normalizeCodexEvent(event);
            if (normalized)
              this.journal.appendObservation(authority, {
                source: "controlled-sdk",
                sourceEventId: `${identity.turnId}:${++sequence}`,
                kind: `runtime.${normalized.type}`,
                summary: redactSensitiveText(JSON.stringify(normalized), 7999),
                artifactIds: [],
                identity,
                wakesOrchestrator: true,
              });
            if (event.type === "turn.completed") completed = true;
            if (event.type === "item.completed" && event.item.type === "agent_message") {
              if (Buffer.byteLength(event.item.text) > 1024 * 1024)
                throw new Error("Agent result exceeds one MiB");
              response = event.item.text;
            }
            if (event.type === "error" || event.type === "turn.failed")
              throw new Error(event.type === "error" ? event.message : event.error.message);
          }
          check();
          if (!completed || !thread.id || !response.trim())
            throw new Error("SDK stream ended without a complete correlated result");
          result = JSON.parse(response);
        })(),
        interrupted,
      ]);
    } catch (error) {
      diagnostic = redactSensitiveText(
        error instanceof Error ? error.message : "Agent execution failed",
        7999,
      );
      request.abort(error);
    } finally {
      clearInterval(health);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (onStreamAbort) request.signal.removeEventListener("abort", onStreamAbort);
    }

    let stop: CodexLaunchStop | null = null;
    if (!invoked) {
      // This controller has not called the transport at all. This is definitive
      // even when filesystem admission failed before a control directory existed.
      stop = {
        generation: manifest.generation,
        stoppedAt: new Date().toISOString(),
        kind: "not_started",
        code: null,
        signal: null,
        interrupted: request.signal.aborted,
        processTreeStopped: true,
      };
    } else {
      stop = await this.observeStop(manifest, request.signal.aborted);
    }
    this.journal.assertAuthority(authority); // Old controllers can stop their process, but cannot publish its result.
    // A concurrent kernel interruption may already have settled this exact turn.
    // Its stored outcome wins; late stream output cannot replace it.
    const settled = this.journal.agents.turn(authority.runId, identity);
    if (settled.stopEvidence) return settled;
    if (diagnostic)
      this.journal.appendObservation(authority, {
        source: "controlled-sdk",
        sourceEventId: `${identity.turnId}:problem`,
        kind: "runtime.problem",
        summary: diagnostic,
        artifactIds: [],
        identity,
        wakesOrchestrator: true,
      });
    if (!stop)
      return this.journal.agents.markIndeterminate(
        authority,
        identity,
        "No trusted launcher stop receipt; workspace remains owned",
      );
    this.journal.agents.recordLaunchStop(authority, identity, stop);
    const cancelled =
      signal?.aborted ||
      this.journal.control(authority.runId).status !== "active" ||
      this.journal.agents.turn(authority.runId, identity).stopRequested;
    if (cancelled) this.journal.agents.requestStop(authority, identity);
    return this.journal.agents.finishTurn(authority, identity, {
      status: cancelled
        ? "cancelled"
        : completed && result !== null && !diagnostic && stop.code === 0 && !stop.interrupted
          ? "completed"
          : "failed",
      result,
      stopEvidence: JSON.stringify(stop),
    });
  }

  /** Cold recovery stops the recorded generation; it never replays an uncertain prompt. */
  async reconcile(authority: ControllerAuthority, identity: TurnIdentity): Promise<TurnRecord> {
    this.journal.assertAuthority(authority);
    const turn = this.journal.agents.turn(authority.runId, identity);
    if (turn.stopEvidence) return turn;
    if (turn.status === "prepared")
      return this.journal.agents.cancelPreparedTurn(authority, identity);
    if (!turn.launch)
      return this.journal.agents.markIndeterminate(
        authority,
        identity,
        "No controlled launch identity is available",
      );
    this.journal.agents.requestStop(authority, identity);
    const manifest = turn.launch.manifest;
    let stop = turn.launch.stop;
    if (!stop) {
      await this.ensureControlDirectory(manifest);
      stop = await this.observeStop(manifest, true);
    }
    this.journal.assertAuthority(authority);
    const settled = this.journal.agents.turn(authority.runId, identity);
    if (settled.stopEvidence) return settled;
    if (!stop)
      return this.journal.agents.markIndeterminate(
        authority,
        identity,
        "Recorded launcher is still running or has unknown stop state",
      );
    this.journal.agents.recordLaunchStop(authority, identity, stop);
    this.journal.appendObservation(authority, {
      source: "controlled-sdk",
      sourceEventId: `${identity.turnId}:recovery-gap`,
      kind: "runtime.observation_gap",
      summary:
        "Recovered process-stop evidence; an interrupted SDK event stream and unrecorded result cannot be reconstructed as completion",
      artifactIds: [],
      identity,
      wakesOrchestrator: true,
    });
    return this.journal.agents.finishTurn(authority, identity, {
      status: "cancelled",
      result: null,
      stopEvidence: JSON.stringify(stop),
    });
  }

  private async prepareStorage(manifest: CodexLaunch) {
    await this.ensureControlDirectory(manifest);
    for (const path of [
      manifest.confinement.providerHome,
      manifest.confinement.scratch,
      manifest.confinement.artifacts,
    ])
      await privateDirectory(path);
    const config = join(manifest.confinement.providerHome, "config.toml");
    try {
      if (
        (await realpath(config)) !== config ||
        (await readFile(config, "utf8")) !== codexConfinementConfig(manifest.confinement)
      )
        throw new Error("The private runtime profile changed");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        await writeCodexConfinement(manifest.confinement);
      else throw error;
    }
  }

  private async ensureControlDirectory(manifest: CodexLaunch) {
    // Every parent is kernel-derived and checked before proceeding to a child.
    const suffix = manifest.controlDirectory.slice(this.options.root.length + 1);
    if (
      !manifest.controlDirectory.startsWith(this.options.root + "/") ||
      suffix.split("/").some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new Error("Runtime control directory is outside the configured private root");
    await privateDirectory(this.options.root);
    let directory = this.options.root;
    for (const part of suffix.split("/")) {
      directory = join(directory, part);
      await privateDirectory(directory);
    }
  }

  private async observeStop(
    manifest: CodexLaunch,
    interrupt: boolean,
  ): Promise<CodexLaunchStop | null> {
    let stop = await readCodexLaunchStop(manifest);
    if (stop) return stop;
    if (interrupt) {
      await preventCodexLaunchStart(manifest);
    }
    const deadline = Date.now() + 5000;
    let nextInterrupt = 0;
    while (Date.now() < deadline) {
      stop = await readCodexLaunchStop(manifest);
      if (stop) return stop;
      // The start gate may exist before the socket is listening. Retry within
      // the stop deadline; a missing socket is not proof that no process exists.
      if (interrupt && Date.now() >= nextInterrupt) {
        await controlCodexLaunch(manifest, "interrupt").catch(() => undefined);
        nextInterrupt = Date.now() + 250;
      }
      await delay(100);
    }
    return null;
  }
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (await realpath(path)) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Runtime storage must be canonical and owner-only");
}
