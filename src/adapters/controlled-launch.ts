import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority, TurnIdentity } from "../domain/orchestration.js";
import type { AgentInstance } from "../domain/agents.js";
import {
  CodexLaunchSchema,
  type CodexLaunch,
  type CodexLaunchStop,
} from "../domain/codex-launch.js";
import { writeCodexConfinement } from "./codex-confinement.js";
import {
  controlCodexLaunch,
  materializeCodexLauncher,
  preventCodexLaunchStart,
  readCodexLaunchStop,
} from "./codex-launch.js";
import { reviewPacketBinding } from "../domain/review-packet.js";
import { digestJson } from "../domain/repository-policy.js";

export type ControlledLaunchOptions = {
  root: string;
  executable: string;
  launcherEntrypoint?: string;
  turnTimeoutMs?: number;
};

export function providerHomeForAgent(agent: AgentInstance): string {
  return (
    agent.conversationContinuation?.providerHome ??
    join(
      agent.execution.runtimeRoot,
      agent.runId,
      `${agent.agentId}-${agent.agentGeneration}`,
      "provider",
    )
  );
}

/** Validate the caller's adapter tuple before any launch reservation or I/O. */
export function assertControlledExecution(
  agent: AgentInstance,
  options: ControlledLaunchOptions,
  runtime: "sdk" | "herdr",
): number {
  const timeout = options.turnTimeoutMs ?? agent.execution.turnTimeoutMs;
  if (
    agent.contract.backend !== "codex" ||
    agent.contract.runtime !== runtime ||
    options.root !== agent.execution.runtimeRoot ||
    options.executable !== agent.execution.executable ||
    timeout !== agent.execution.turnTimeoutMs
  )
    throw new Error("Controlled adapter configuration differs from the recorded agent execution");
  return timeout;
}

/** Shared process/storage ownership, not a delivery workflow or provider transport. */
export class ControlledLaunches {
  constructor(private readonly options: ControlledLaunchOptions) {
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

  reserve(journal: OrchestrationJournal, authority: ControllerAuthority, identity: TurnIdentity) {
    journal.assertAuthority(authority);
    const initial = journal.agents.turn(authority.runId, identity);
    if (initial.status !== "prepared" || initial.launch)
      throw new Error("Reconcile an existing launch instead of dispatching it again");
    const agent = journal.agents.instance(authority.runId, identity);
    const workspace = journal.agents.workspace(authority.runId, identity);
    assertControlledExecution(agent, this.options, agent.contract.runtime);
    const packet = journal.reviews.packetForTurn(authority.runId, identity);
    const home = join(
      agent.execution.runtimeRoot,
      authority.runId,
      `${agent.agentId}-${agent.agentGeneration}`,
    );
    const manifest = CodexLaunchSchema.parse({
      generation: randomUUID(),
      confinement: {
        executable: this.options.executable,
        workspace: workspace.path,
        sourceMode: workspace.sourceMode === "immutable" ? "read-only" : "workspace-write",
        providerHome: providerHomeForAgent(agent),
        scratch: join(home, "scratch"),
        artifacts: join(home, "artifacts"),
      },
      model: agent.contract.effective.model,
      reasoningEffort: agent.contract.effective.reasoningEffort,
      authCachePath: agent.accountBinding?.source.authCachePath ?? null,
      ...(agent.accountBinding ? { accountBinding: agent.accountBinding } : {}),
      controlDirectory: join(home, "launches", identity.turnId),
      reviewPacket: packet === null ? null : reviewPacketBinding(packet),
    });
    journal.agents.bindLaunch(authority, identity, manifest);
    // No asynchronous gap before durable dispatch admission.
    const turn = journal.agents.markSubmitting(authority, identity);
    return { manifest, turn, packet };
  }

  async materialize(manifest: CodexLaunch, packet: string | null) {
    await this.ensureControlDirectory(manifest);
    if (
      digestJson(packet === null ? null : reviewPacketBinding(packet)) !==
      digestJson(manifest.reviewPacket)
    )
      throw new Error("Review packet content differs from the reserved launch");
    if (packet !== null)
      await writeFile(join(manifest.controlDirectory, "review-evidence.json"), packet, {
        flag: "wx",
        mode: 0o400,
      });
    for (const path of [
      manifest.confinement.providerHome,
      manifest.confinement.scratch,
      manifest.confinement.artifacts,
    ])
      await privateDirectory(path);
    // CODEX_HOME owns durable conversation state and is intentionally shared by
    // an explicit continuation. Confinement policy is launch-owned: scratch and
    // artifact paths change with the generation and must never be inferred from
    // the first generation's persistent config.toml.
    const providerConfig = join(manifest.confinement.providerHome, "config.toml");
    try {
      if ((await realpath(providerConfig)) !== providerConfig)
        throw new Error("The private provider configuration path changed");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        await writeCodexConfinement(manifest.confinement);
      else throw error;
    }
    return materializeCodexLauncher(manifest, this.options.launcherEntrypoint);
  }

  async stop(manifest: CodexLaunch, interrupt: boolean): Promise<CodexLaunchStop | null> {
    await this.ensureControlDirectory(manifest);
    let stop = await readCodexLaunchStop(manifest);
    if (stop) return stop;
    if (interrupt) await preventCodexLaunchStart(manifest);
    const deadline = Date.now() + 5000;
    let nextInterrupt = 0;
    while (Date.now() < deadline) {
      stop = await readCodexLaunchStop(manifest);
      if (stop) return stop;
      // The gate can precede the socket. Missing is unknown, not absent.
      if (interrupt && Date.now() >= nextInterrupt) {
        await controlCodexLaunch(manifest, "interrupt").catch(() => undefined);
        nextInterrupt = Date.now() + 250;
      }
      await delay(100);
    }
    return null;
  }

  private async ensureControlDirectory(manifest: CodexLaunch) {
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
