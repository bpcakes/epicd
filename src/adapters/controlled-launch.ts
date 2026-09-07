import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority, TurnIdentity } from "../domain/orchestration.js";
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

export type ControlledLaunchOptions = {
  root: string;
  executable: string;
  authCachePath: string | null;
  launcherEntrypoint?: string;
  turnTimeoutMs?: number;
};

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
    journal.agents.bindLaunch(authority, identity, manifest);
    // No asynchronous gap before durable dispatch admission.
    const turn = journal.agents.markSubmitting(authority, identity);
    return { manifest, turn };
  }

  async materialize(manifest: CodexLaunch) {
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
