import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CodexLaunchSchema } from "../../src/domain/codex-launch.js";

/** Synthetic records following the inspected, pinned 0.153.4 private format. */
export async function transcriptFixture() {
  const root = await mkdtemp("/var/tmp/epicd-transcript-");
  const providerHome = join(root, "provider");
  await mkdir(providerHome, { mode: 0o700 });
  const authCachePath = join(providerHome, "auth.json");
  const launch = CodexLaunchSchema.parse({
    generation: randomUUID(),
    controlDirectory: join(root, "control"),
    authCachePath,
    accountBinding: {
      accountClass: "implementation",
      source: {
        bindingId: "a".repeat(64),
        principalDigest: "b".repeat(64),
        codexHome: providerHome,
        authCachePath,
        device: "1",
        inode: "2",
        label: "fixture",
      },
    },
    reviewPacket: null,
    model: "gpt-6-astra",
    reasoningEffort: "high",
    confinement: {
      executable: process.execPath,
      workspace: join(root, "source"),
      sourceMode: "read-only",
      providerHome,
      scratch: join(root, "scratch"),
      artifacts: join(root, "artifacts"),
    },
  });
  const session = randomUUID(),
    turn = randomUUID();
  const path = join(
    providerHome,
    "sessions",
    "2026",
    "09",
    "08",
    `rollout-2026-09-08T07-22-17-${session}.jsonl`,
  );
  await mkdir(dirname(path), { recursive: true });
  const statePath = join(providerHome, "state_5.sqlite");
  const db = new Database(statePath);
  try {
    db.exec(
      "CREATE TABLE threads(id TEXT, cwd TEXT, model TEXT, reasoning_effort TEXT, cli_version TEXT, rollout_path TEXT)",
    );
    db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?)").run(
      session,
      launch.confinement.workspace,
      launch.model,
      launch.reasoningEffort,
      "0.153.4",
      path,
    );
  } finally {
    db.close();
  }
  const prompt = JSON.stringify({ request: "Inspect failed browser command", turn });
  const line = (type: string, payload: object) =>
    JSON.stringify({ timestamp: "2026-09-08T07:22:17.000Z", type, payload }) + "\n";
  const metadata = { turn_id: turn };
  const header = line("session_meta", {
    id: session,
    cwd: launch.confinement.workspace,
    cli_version: "0.153.4",
    base_instructions: "NEVER_COPY_BASE_INSTRUCTIONS",
  });
  const started = line("event_msg", { type: "task_started", turn_id: turn });
  const input = (text = prompt, turnId = turn) =>
    line("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
  const call = (
    callId = "call-browser",
    text = 'await tools.exec_command({cmd:"npm run test:e2e"})',
  ) =>
    line("response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      input: text,
      internal_chat_message_metadata_passthrough: metadata,
    });
  const output = (
    text = 'exit code 1: peer authentication failed\n{"password":"never-retain-password"}',
    callId = "call-browser",
  ) =>
    line("response_item", {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: metadata,
    });
  const complete = line("event_msg", {
    type: "task_complete",
    turn_id: turn,
    last_agent_message: "NEVER_COPY_FINAL_MESSAGE",
  });
  const rateLimits = (input: object = {}) =>
    line("event_msg", {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: "premium",
        limit_name: null,
        primary: null,
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: "0" },
        individual_limit: null,
        spend_control_reached: null,
        rate_limit_reached_type: null,
        ...input,
      },
    });
  const prefix =
    header + started + input("<environment_context>NEVER_COPY_ENV</environment_context>") + input();
  await writeFile(path, prefix, { mode: 0o600 });
  return {
    root,
    launch,
    session,
    turn,
    providerTurn: turn,
    path,
    statePath,
    prompt,
    line,
    header,
    started,
    input,
    call,
    output,
    rateLimits,
    complete,
    prefix,
    append: (text: string | Buffer) => appendFile(path, text),
  };
}
