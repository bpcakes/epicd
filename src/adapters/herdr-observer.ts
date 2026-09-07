import { z } from "zod";
import { runCommand, runJson } from "../util/command.js";
import { redactSensitiveText } from "../util/redact.js";

export const NativeHerdrIdentitySchema = z.object({
  name: z.string().min(1),
  paneId: z.string().min(1),
  tabId: z.string().min(1),
  terminalId: z.string().min(1),
  providerSessionId: z.string().min(1).nullable(),
});
export type NativeHerdrIdentity = z.infer<typeof NativeHerdrIdentitySchema>;

const AgentEnvelopeSchema = z.object({
  result: z.object({
    agent: z.object({
      name: z.string().nullable(),
      pane_id: z.string().min(1),
      tab_id: z.string().min(1),
      terminal_id: z.string().min(1),
      agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]),
      interactive_ready: z.boolean().optional(),
      launch_pending: z.boolean().optional(),
      state_change_seq: z.number().int().nonnegative().optional(),
      agent_session: z
        .object({ kind: z.enum(["id", "path"]), value: z.string() })
        .nullable()
        .optional(),
    }),
  }),
});

export type HerdrObservation = {
  identity: NativeHerdrIdentity;
  state: "idle" | "working" | "blocked" | "done" | "unknown";
  ready: boolean;
  sourceSequence: number | null;
};

/** Native lifecycle is observation, never proof that a command passed or descendants stopped. */
export class HerdrObserver {
  constructor(
    private readonly options: {
      cwd: string;
      herdrPath: string;
      sessionName?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  private args(args: string[]) {
    return this.options.sessionName ? ["--session", this.options.sessionName, ...args] : args;
  }

  async observe(
    target: string,
    expected?: NativeHerdrIdentity,
    signal?: AbortSignal,
  ): Promise<HerdrObservation> {
    const envelope = await runJson(
      this.options.herdrPath,
      this.args(["agent", "get", target]),
      {
        cwd: this.options.cwd,
        ...(this.options.env ? { env: this.options.env } : {}),
        timeoutMs: 10_000,
        ...(signal ? { signal } : {}),
      },
      AgentEnvelopeSchema,
    );
    const agent = envelope.result.agent;
    if (!agent.name) throw new Error("Herdr agent no longer has its owned name");
    const identity = {
      name: agent.name,
      paneId: agent.pane_id,
      tabId: agent.tab_id,
      terminalId: agent.terminal_id,
      providerSessionId: agent.agent_session?.kind === "id" ? agent.agent_session.value : null,
    };
    if (
      expected &&
      (identity.name !== expected.name ||
        identity.paneId !== expected.paneId ||
        identity.tabId !== expected.tabId ||
        identity.terminalId !== expected.terminalId ||
        (expected.providerSessionId !== null &&
          identity.providerSessionId !== expected.providerSessionId))
    )
      throw new Error(
        "Herdr agent identity changed; preserve its workspace and revoke the old turn",
      );
    if (target !== identity.name && target !== identity.paneId)
      throw new Error("Herdr returned an unrelated agent");
    return {
      identity,
      state: agent.agent_status,
      ready:
        (agent.agent_status === "idle" || agent.agent_status === "done") &&
        agent.interactive_ready === true &&
        agent.launch_pending !== true,
      sourceSequence: agent.state_change_seq ?? null,
    };
  }

  async readDiagnostic(
    identity: NativeHerdrIdentity,
  ): Promise<{ text: string; truncated: boolean }> {
    await this.observe(identity.name, identity);
    const result = await runCommand(
      this.options.herdrPath,
      this.args(["agent", "read", identity.name, "--source", "recent-unwrapped", "--lines", "120"]),
      {
        cwd: this.options.cwd,
        timeoutMs: 10_000,
        ...(this.options.env ? { env: this.options.env } : {}),
      },
    );
    // Installed Herdr returns plain text, not a JSON read envelope. Check the
    // exact occupant before and after; text cannot attest to its own provenance.
    await this.observe(identity.name, identity);
    return {
      text: redactSensitiveText(result.stdout, 16 * 1024),
      // This is at most 120 screen/scrollback lines. The text CLI cannot prove
      // that earlier output was retained, even when no local clipping occurred.
      truncated: true,
    };
  }

  async requestInterrupt(identity: NativeHerdrIdentity): Promise<void> {
    await this.observe(identity.name, identity);
    await runCommand(
      this.options.herdrPath,
      this.args(["agent", "send-keys", identity.name, "ctrl+c"]),
      {
        cwd: this.options.cwd,
        timeoutMs: 10_000,
        ...(this.options.env ? { env: this.options.env } : {}),
      },
    );
    // A delivered key is not a StopAcknowledgement. The outer process owner must prove stop.
  }
}
