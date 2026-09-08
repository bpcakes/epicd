import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority, TurnIdentity } from "../domain/orchestration.js";
import type { TurnRecord } from "../domain/agents.js";
import { NativeLaunchEndpointSchema, type NativeLaunchEndpoint } from "../domain/codex-launch.js";
import { ControlledLaunches, type ControlledLaunchOptions } from "./controlled-launch.js";
import { ControlledTranscript } from "./controlled-transcript.js";
import { HerdrArtifacts, herdrResultContract } from "./herdr-artifacts.js";
import { HerdrObserver, type NativeHerdrIdentity } from "./herdr-observer.js";
import { nativeCodexAcceptedPrompt, readNativeCodexSession } from "./codex-native-state.js";
import { herdrSocketIdentity, sendHerdrPrompt } from "./herdr-prompt.js";
import { CommandError, runCommand, runJson } from "../util/command.js";
import { redactSensitiveText } from "../util/redact.js";

export type ControlledHerdrOptions = ControlledLaunchOptions & {
  herdrPath: string;
  sessionName: string;
  workspaceId: string;
  env?: NodeJS.ProcessEnv;
};
const PaneSchema = z.object({
  pane_id: z.string(),
  tab_id: z.string(),
  terminal_id: z.string(),
  workspace_id: z.string(),
  agent: z.string().nullable().optional(),
});
const AgentSchema = z.object({
  result: z.object({
    agent: PaneSchema.extend({
      name: z.string().nullable().optional(),
      agent_status: z.string(),
      interactive_ready: z.boolean().optional(),
      launch_pending: z.boolean().optional(),
    }),
  }),
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Real native TUI turns, observed/steered by Herdr, with independent supervisor stop proof. */
export class ControlledHerdrRuntime {
  readonly kind = "herdr";
  private readonly launches: ControlledLaunches;
  private readonly env: NodeJS.ProcessEnv;
  constructor(
    private readonly journal: OrchestrationJournal,
    private readonly options: ControlledHerdrOptions,
  ) {
    if (process.env.HERDR_ENV !== "1") throw new Error("Controlled Herdr requires HERDR_ENV=1");
    z.string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
      .parse(options.sessionName);
    z.string().min(1).max(256).parse(options.workspaceId);
    this.launches = new ControlledLaunches(options);
    this.env = { ...(options.env ?? process.env) };
    for (const key of [
      "HERDR_PANE_ID",
      "HERDR_TAB_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_SOCKET",
      "HERDR_SOCKET_PATH",
    ])
      delete this.env[key];
  }

  async run(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    signal?: AbortSignal,
  ): Promise<TurnRecord> {
    this.journal.assertAuthority(authority);
    const agent = this.journal.agents.instance(authority.runId, identity);
    if (agent.contract.runtime !== "herdr")
      throw new Error("Controlled Herdr requires a native assignment");
    const { turn, manifest } = this.launches.reserve(this.journal, authority, identity);
    const request = new AbortController();
    const abort = () => request.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const deadline = Date.now() + (this.options.turnTimeoutMs ?? 1_800_000);
    const check = () => {
      this.journal.assertAuthority(authority);
      const current = this.journal.agents.turn(authority.runId, identity);
      const owner = this.journal.agents.instance(authority.runId, identity);
      const workspace = this.journal.agents.workspace(authority.runId, identity);
      const control = this.journal.control(authority.runId);
      if (
        control.status !== "active" ||
        control.policyDigest !== turn.policyDigest ||
        owner.status !== "busy" ||
        owner.activeTurnId !== identity.turnId ||
        workspace.status !== "ready" ||
        workspace.activeTurnId !== identity.turnId ||
        current.stopRequested ||
        current.stopEvidence ||
        Date.now() >= deadline
      )
        throw new Error("Native turn authority changed or its deadline expired");
      request.signal.throwIfAborted();
    };
    let native: NativeLaunchEndpoint | null = null;
    let diagnostic: string | null = null;
    let result: unknown = null;
    let dispatched = false;
    let successfulExit = false;
    let sequence = 0;
    let transcript: ControlledTranscript | undefined;
    let stopWatching: (() => Promise<void>) | undefined;
    let transcriptError: unknown;
    const sessionId = () =>
      this.journal.agents.instance(authority.runId, identity).provider?.sessionId ?? null;
    const observe = (kind: string, summary: string, sourceTruncated = false) => {
      const retained = this.journal.diagnostics.append(
        authority,
        {
          source: "controlled-herdr",
          sourceEventId: `${identity.turnId}:${++sequence}`,
          kind,
          summary: redactSensitiveText(summary, 7999),
          identity,
          wakesOrchestrator: true,
        },
        summary,
        sourceTruncated,
      );
      if (retained.artifact.omission === "budget_exhausted")
        throw new Error(
          "Retained diagnostic budget exhausted; stop this turn without accepting its result",
        );
    };
    try {
      const launcher = await this.launches.materialize(manifest);
      check();
      const artifacts = new HerdrArtifacts(manifest.confinement.artifacts);
      const artifact = await artifacts.prepare(identity);
      const prompt = herdrResultContract(JSON.stringify(turn.prompt), turn.outputSchema, artifact);
      transcript = new ControlledTranscript(this.journal, authority, identity, manifest, prompt);
      stopWatching = transcript.watch(sessionId, check, (error) => {
        transcriptError = error;
        request.abort(error);
      });
      const previous = await readNativeCodexSession(manifest, agent.provider?.sessionId ?? null);
      if (agent.provider?.sessionId && !previous)
        throw new Error("The recorded native conversation is missing");
      const server = await this.server();
      check();
      const name = `ed-${identity.turnId.replaceAll("-", "").slice(0, 24)}`;
      observe(
        "runtime.native_layout_requested",
        `Create one owned terminal for native launch ${manifest.generation}`,
      );
      const created = z
        .object({ result: z.object({ root_pane: PaneSchema }) })
        .parse(
          await this.cli(
            server,
            [
              "tab",
              "create",
              "--workspace",
              this.options.workspaceId,
              "--cwd",
              manifest.confinement.workspace,
              "--label",
              name,
              "--no-focus",
            ],
            request.signal,
          ),
        ).result.root_pane;
      if (created.workspace_id !== this.options.workspaceId)
        throw new Error("Herdr created the terminal in another workspace");
      native = NativeLaunchEndpointSchema.parse({
        ...server,
        name,
        workspaceId: created.workspace_id,
        paneId: created.pane_id,
        tabId: created.tab_id,
        terminalId: created.terminal_id,
      });
      check();
      this.journal.agents.bindNativeLaunch(authority, identity, native);
      await this.shellReady(native, check, request.signal);
      // Herdr's interactive_ready is available only for managed agent.start.
      // Install a private POSIX startup function so that managed launch still
      // replaces the host shell; no model input is used for this setup.
      const bootstrap = join(manifest.controlDirectory, "native-shell.sh");
      const readyPath = join(manifest.controlDirectory, "native-shell-ready");
      await writeFile(
        bootstrap,
        [
          "unset ENV BASH_ENV",
          `codex() { exec ${quote(launcher.executable)} "$@"; exit 125; }`,
          `printf '%s\\n' ${quote(manifest.generation)} > ${quote(readyPath)}`,
          "",
        ].join("\n"),
        { flag: "wx", mode: 0o600 },
      );
      check();
      await this.cli(
        native,
        [
          "pane",
          "run",
          native.paneId,
          `exec /usr/bin/env -u BASH_ENV ${quote(`ENV=${bootstrap}`)} /bin/sh -i`,
        ],
        request.signal,
      );
      const shellDeadline = Date.now() + 10_000;
      for (;;) {
        check();
        const ready = await readFile(readyPath, "utf8").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        });
        if (ready === manifest.generation + "\n") break;
        if (ready !== null || Date.now() >= shellDeadline)
          throw new Error("Owned native shell did not acknowledge its exact launch setup");
        await delay(100, undefined, { signal: request.signal });
      }
      await this.shellReady(native, check, request.signal);
      check();
      dispatched = true;
      const args = previous ? ["resume", previous.id, "--no-alt-screen"] : ["--no-alt-screen"];
      const started = AgentSchema.parse(
        await this.cli(
          native,
          [
            "agent",
            "start",
            native.name,
            "--kind",
            "codex",
            "--pane",
            native.paneId,
            "--timeout",
            "10000",
            "--",
            ...args,
          ],
          request.signal,
        ),
      ).result.agent;
      if (
        started.name !== native.name ||
        started.terminal_id !== native.terminalId ||
        started.tab_id !== native.tabId ||
        started.pane_id !== native.paneId ||
        started.workspace_id !== native.workspaceId
      )
        throw new Error("Managed native start returned another terminal");
      const observer = new HerdrObserver({
        cwd: manifest.confinement.workspace,
        herdrPath: this.options.herdrPath,
        sessionName: native.sessionName,
        env: this.env,
      });
      const expected: NativeHerdrIdentity = {
        name: native.name,
        paneId: native.paneId,
        tabId: native.tabId,
        terminalId: native.terminalId,
        providerSessionId: null,
      };
      const before = await observer.observe(native.name, expected, request.signal);
      check();
      if (!before.ready) throw new Error(`Native agent is not ready (${before.state})`);
      this.journal.agents.bindTurnProvider(authority, identity, {
        runtime: "herdr",
        name: native.name,
        paneId: native.paneId,
        tabId: native.tabId,
        terminalId: native.terminalId,
        sessionId: previous?.id ?? null,
      });
      await sendHerdrPrompt(native, prompt, request.signal);
      let lastObservation = "";
      let lastDiagnostic = "";
      let nextDiagnosticAt = 0;
      for (;;) {
        check();
        await this.assertServer(native);
        const current = await observer.observe(native.name, expected, request.signal);
        check();
        const observed = JSON.stringify(current);
        const changed = observed !== lastObservation;
        if (changed) {
          observe("runtime.agent.lifecycle", observed);
          lastObservation = observed;
        }
        if (changed || Date.now() >= nextDiagnosticAt) {
          const diagnostic = await observer.readDiagnostic(current.identity, request.signal);
          check();
          if (diagnostic.text !== lastDiagnostic) {
            observe("runtime.native_terminal", diagnostic.text, diagnostic.truncated);
            lastDiagnostic = diagnostic.text;
          }
          nextDiagnosticAt = Date.now() + 5000;
        }
        if (current.state === "blocked")
          throw new Error("Native agent requires approval or user input");
        const session = await readNativeCodexSession(manifest, previous?.id ?? null);
        if (session) {
          if (
            current.identity.providerSessionId &&
            current.identity.providerSessionId !== session.id
          )
            throw new Error("Herdr and the private provider disagree about session identity");
          this.journal.agents.bindTurnProvider(authority, identity, {
            runtime: "herdr",
            name: native.name,
            paneId: native.paneId,
            tabId: native.tabId,
            terminalId: native.terminalId,
            sessionId: session.id,
          });
          if (await nativeCodexAcceptedPrompt(manifest, session.id, prompt))
            this.journal.agents.acknowledgePrompt(
              authority,
              identity,
              turn.promptDigest,
              `Private Codex input history for session ${session.id} and launch ${manifest.generation}`,
            );
        }
        if (
          current.ready &&
          session?.model === manifest.model &&
          session.reasoning_effort === manifest.reasoningEffort &&
          this.journal.agents.turn(authority.runId, identity).submissionAcknowledgement
        ) {
          result = await artifacts.read(identity).catch((error: unknown) => {
            // A lifecycle change can settle before this turn has produced a
            // result. Keep observing this submission, never resend its prompt.
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
          });
          if (result === null) {
            await delay(250, undefined, { signal: request.signal });
            continue;
          }
          check();
          observe("runtime.agent_message", JSON.stringify(result));
          // Native readiness gates the exit key, not delivery evidence. Only the
          // outer supervisor's subsequent clean stop can make this result eligible.
          await this.cli(native, ["agent", "send-keys", native.name, "ctrl+d"], request.signal);
          const stopped = await this.launches.stop(manifest, false);
          successfulExit =
            stopped?.kind === "stopped" && stopped.code === 0 && !stopped.interrupted;
          if (!successfulExit)
            throw new Error("Native agent did not exit cleanly after its result");
          break;
        }
        await delay(250, undefined, { signal: request.signal });
      }
    } catch (error) {
      error = transcriptError ?? error;
      diagnostic = redactSensitiveText(
        error instanceof CommandError
          ? error.result.stderr || error.message
          : error instanceof Error
            ? error.message
            : "Native execution failed",
        7999,
      );
      request.abort(error);
    } finally {
      await stopWatching?.();
      signal?.removeEventListener("abort", abort);
    }
    const stop = !dispatched
      ? {
          generation: manifest.generation,
          stoppedAt: new Date().toISOString(),
          kind: "not_started" as const,
          code: null,
          signal: null,
          interrupted: request.signal.aborted,
          processTreeStopped: true as const,
        }
      : await this.launches.stop(manifest, !successfulExit);
    this.journal.assertAuthority(authority);
    const settled = this.journal.agents.turn(authority.runId, identity);
    if (settled.stopEvidence) return settled;
    if (stop && dispatched && transcript) {
      try {
        await transcript.finish(sessionId(), () => this.journal.assertAuthority(authority));
      } catch (error) {
        this.journal.assertAuthority(authority);
        const detail = redactSensitiveText(
          error instanceof Error ? error.message : "Native transcript capture failed",
          7999,
        );
        transcript.gap(detail);
        diagnostic ??= detail;
      }
    }
    if (diagnostic) observe("runtime.problem", diagnostic);
    if (!stop)
      return this.journal.agents.markIndeterminate(
        authority,
        identity,
        "Native launcher stop is unconfirmed; preserve the workspace and terminal",
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
        : successfulExit && result !== null && !diagnostic
          ? "completed"
          : "failed",
      result: cancelled ? null : result,
      stopEvidence: JSON.stringify(stop),
    });
  }

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
        "Native turn has no durable supervisor identity",
      );
    this.journal.agents.requestStop(authority, identity);
    const stop = turn.launch.stop ?? (await this.launches.stop(turn.launch.manifest, true));
    this.journal.assertAuthority(authority);
    const settled = this.journal.agents.turn(authority.runId, identity);
    if (settled.stopEvidence) return settled;
    if (!stop)
      return this.journal.agents.markIndeterminate(
        authority,
        identity,
        "Native supervisor stop is unknown; do not release its workspace",
      );
    const manifest = turn.launch.manifest;
    const artifact = new HerdrArtifacts(manifest.confinement.artifacts).locate(identity);
    const transcript = new ControlledTranscript(
      this.journal,
      authority,
      identity,
      manifest,
      herdrResultContract(JSON.stringify(turn.prompt), turn.outputSchema, artifact),
    );
    try {
      const session =
        this.journal.agents.instance(authority.runId, identity).provider?.sessionId ?? null;
      await transcript.finish(session, () => this.journal.assertAuthority(authority));
    } catch (error) {
      this.journal.assertAuthority(authority);
      transcript.gap(
        error instanceof Error ? error.message : "Cold native transcript capture failed",
      );
    }
    this.journal.agents.recordLaunchStop(authority, identity, stop);
    this.journal.appendObservation(authority, {
      source: "controlled-herdr",
      sourceEventId: `${identity.turnId}:recovery-gap`,
      kind: "runtime.observation_gap",
      summary:
        "Stopped the exact native launch; unrecorded result and terminal output remain unaccepted",
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

  private async server() {
    const listing = await runJson(
      this.options.herdrPath,
      ["session", "list", "--json"],
      { cwd: this.options.root, env: this.env, timeoutMs: 5000 },
      z.object({
        sessions: z.array(
          z.object({ name: z.string(), running: z.boolean(), socket_path: z.string() }),
        ),
      }),
    );
    const match = listing.sessions.filter(
      (session) => session.name === this.options.sessionName && session.running,
    );
    if (match.length !== 1) throw new Error("The selected native Herdr session is not running");
    const socketPath = match[0]!.socket_path;
    const server = {
      sessionName: this.options.sessionName,
      socketPath,
      socketIdentity: await herdrSocketIdentity(socketPath),
    };
    z.object({
      result: z.object({
        snapshot: z.object({ protocol: z.literal(20), version: z.literal("0.8.2") }),
      }),
    }).parse(await this.cli(server, ["api", "snapshot"]));
    return server;
  }
  private async assertServer(
    server: Pick<NativeLaunchEndpoint, "sessionName" | "socketPath" | "socketIdentity">,
  ) {
    if (
      server.sessionName !== this.options.sessionName ||
      (await herdrSocketIdentity(server.socketPath)) !== server.socketIdentity
    )
      throw new Error("Native Herdr server identity changed; do not reuse its terminal handles");
  }
  private async cli(
    server: Pick<NativeLaunchEndpoint, "sessionName" | "socketPath" | "socketIdentity">,
    args: string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.assertServer(server);
    const response = await runCommand(
      this.options.herdrPath,
      ["--session", server.sessionName, ...args],
      {
        cwd: this.options.root,
        env: this.env,
        timeoutMs: 15_000,
        ...(signal ? { signal } : {}),
      },
    );
    await this.assertServer(server);
    return response.stdout.trim() ? (JSON.parse(response.stdout) as unknown) : null;
  }
  private async pane(native: NativeLaunchEndpoint, signal?: AbortSignal) {
    const pane = z
      .object({ result: z.object({ pane: PaneSchema }) })
      .parse(await this.cli(native, ["pane", "get", native.paneId], signal)).result.pane;
    if (
      pane.pane_id !== native.paneId ||
      pane.tab_id !== native.tabId ||
      pane.terminal_id !== native.terminalId ||
      pane.workspace_id !== native.workspaceId
    )
      throw new Error("Owned native terminal identity changed");
    return pane;
  }
  private async shellReady(native: NativeLaunchEndpoint, check: () => void, signal: AbortSignal) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      check();
      const pane = await this.pane(native, signal);
      if (pane.agent) throw new Error("Owned native launch target already contains an agent");
      const info = z
        .object({
          result: z.object({
            process_info: z.object({
              shell_pid: z.number(),
              foreground_processes: z.array(z.object({ pid: z.number() })),
            }),
          }),
        })
        .parse(await this.cli(native, ["pane", "process-info", "--pane", native.paneId], signal))
        .result.process_info;
      if (
        info.foreground_processes.length === 1 &&
        info.foreground_processes[0]!.pid === info.shell_pid
      )
        return;
      await delay(100, undefined, { signal });
    }
    throw new Error("Owned Herdr shell did not become available");
  }
}
