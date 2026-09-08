import { Codex } from "@openai/codex-sdk";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority, TurnIdentity } from "../domain/orchestration.js";
import type { TurnRecord } from "../domain/agents.js";
import type { CodexLaunchStop } from "../domain/codex-launch.js";
import { ControlledLaunches, type ControlledLaunchOptions } from "./controlled-launch.js";
import { ControlledTranscript } from "./controlled-transcript.js";
import { normalizeCodexEvent } from "./codex.js";
import { redactSensitiveText } from "../util/redact.js";

export type ControlledSdkOptions = ControlledLaunchOptions;

/** Actual SDK dispatch through the persisted agent turn, not the legacy runtime's in-memory handle. */
export class ControlledSdkRuntime {
  readonly kind = "sdk";
  private readonly launches: ControlledLaunches;
  constructor(
    private readonly journal: OrchestrationJournal,
    private readonly options: ControlledSdkOptions,
  ) {
    this.launches = new ControlledLaunches(options);
  }

  async run(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    signal?: AbortSignal,
  ): Promise<TurnRecord> {
    this.journal.assertAuthority(authority);
    const agent = this.journal.agents.instance(authority.runId, identity);
    if (agent.contract.runtime !== "sdk")
      throw new Error("Controlled SDK dispatch requires an SDK assignment");
    const workspace = this.journal.agents.workspace(authority.runId, identity);
    const { manifest, turn, packet } = this.launches.reserve(this.journal, authority, identity);
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
    const transcript = new ControlledTranscript(
      this.journal,
      authority,
      identity,
      manifest,
      JSON.stringify(turn.prompt),
    );
    const sessionId = () =>
      this.journal.agents.instance(authority.runId, identity).provider?.sessionId ?? null;
    let stopWatching: (() => Promise<void>) | undefined;
    let transcriptError: unknown;
    try {
      const launcher = await this.launches.materialize(manifest, packet);
      check();
      stopWatching = transcript.watch(sessionId, check, (error) => {
        transcriptError = error;
        request.abort(error);
      });
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
            if (normalized) {
              const retained = this.journal.diagnostics.append(
                authority,
                {
                  source: "controlled-sdk",
                  sourceEventId: `${identity.turnId}:${++sequence}`,
                  kind: `runtime.${normalized.type}`,
                  summary: redactSensitiveText(JSON.stringify(normalized), 7999),
                  identity,
                  wakesOrchestrator: true,
                },
                JSON.stringify(normalized),
                normalized.type === "command.completed" && normalized.outputTruncated,
              );
              if (retained.artifact.omission === "budget_exhausted")
                throw new Error(
                  "Retained diagnostic budget exhausted; stop this turn without accepting its result",
                );
            }
            if (event.type === "turn.completed") {
              if (event.usage)
                this.journal.agents.recordSdkUsage(authority, identity, manifest.generation, {
                  inputTokens: event.usage.input_tokens,
                  cachedInputTokens: event.usage.cached_input_tokens,
                  outputTokens: event.usage.output_tokens,
                });
              completed = true;
            }
            if (event.type === "item.completed" && event.item.type === "agent_message") {
              if (Buffer.byteLength(event.item.text) > 1024 * 1024)
                throw new Error("Agent result exceeds one MiB");
              const retained = this.journal.diagnostics.append(
                authority,
                {
                  source: "controlled-sdk",
                  sourceEventId: `${identity.turnId}:${++sequence}`,
                  kind: "runtime.agent_message",
                  summary:
                    "Agent-reported message; inspect its retained diagnostic, not approval evidence",
                  identity,
                  wakesOrchestrator: true,
                },
                event.item.text,
              );
              if (retained.artifact.omission === "budget_exhausted")
                throw new Error(
                  "Retained diagnostic budget exhausted; stop this turn without accepting its result",
                );
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
      error = transcriptError ?? error;
      diagnostic = redactSensitiveText(
        error instanceof Error ? error.message : "Agent execution failed",
        7999,
      );
      request.abort(error);
    } finally {
      await stopWatching?.();
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
      stop = await this.launches.stop(manifest, request.signal.aborted);
    }
    this.journal.assertAuthority(authority); // Old controllers can stop their process, but cannot publish its result.
    // A concurrent kernel interruption may already have settled this exact turn.
    // Its stored outcome wins; late stream output cannot replace it.
    const settled = this.journal.agents.turn(authority.runId, identity);
    if (settled.stopEvidence) return settled;
    if (stop && invoked) {
      try {
        // Provider exit flushes the last transcript records. Diagnostics can be
        // recovered here, but never stand in for the SDK result or supervisor stop.
        await transcript.finish(sessionId(), () => this.journal.assertAuthority(authority));
      } catch (error) {
        this.journal.assertAuthority(authority);
        const detail = redactSensitiveText(
          error instanceof Error ? error.message : "Transcript capture failed",
          7999,
        );
        transcript.gap(detail);
        diagnostic ??= detail;
      }
    }
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
      stop = await this.launches.stop(manifest, true);
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
    const transcript = new ControlledTranscript(
      this.journal,
      authority,
      identity,
      manifest,
      JSON.stringify(turn.prompt),
    );
    try {
      const session =
        this.journal.agents.instance(authority.runId, identity).provider?.sessionId ?? null;
      await transcript.finish(session, () => this.journal.assertAuthority(authority));
    } catch (error) {
      this.journal.assertAuthority(authority);
      transcript.gap(error instanceof Error ? error.message : "Cold transcript capture failed");
    }
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
}
