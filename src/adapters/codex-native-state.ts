import Database from "better-sqlite3";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CodexLaunch } from "../domain/codex-launch.js";

const NativeSessionSchema = z.object({
  id: z.uuid(),
  cwd: z.string(),
  model: z.string().nullable(),
  reasoning_effort: z.string().nullable(),
  cli_version: z.string(),
});

/** Pinned Codex 0.153.4 private-state adapter. Never infer session identity from terminal text. */
export async function readNativeCodexSession(launch: CodexLaunch, expected: string | null) {
  await privateHome(launch.confinement.providerHome);
  const path = join(launch.confinement.providerHome, "state_5.sqlite");
  try {
    await regularFile(path, 128 * 1024 * 1024);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await regularFile(path + suffix, 128 * 1024 * 1024);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    db.pragma("trusted_schema = OFF");
    const type = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'threads'").get() as
      { type: string } | undefined;
    if (type?.type !== "table") throw new Error("Unsupported private Codex thread store");
    const rows = db
      .prepare("SELECT id, cwd, model, reasoning_effort, cli_version FROM threads LIMIT 2")
      .all();
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("Private native agent has ambiguous provider sessions");
    const session = NativeSessionSchema.parse(rows[0]);
    if (
      (expected !== null && session.id !== expected) ||
      session.cwd !== launch.confinement.workspace ||
      (session.model !== null && session.model !== launch.model) ||
      (session.reasoning_effort !== null && session.reasoning_effort !== launch.reasoningEffort) ||
      session.cli_version !== "0.153.4"
    )
      throw new Error("Native provider session does not match the pinned launch contract");
    // Codex inserts identity before filling model/effort metadata. Null fields
    // can bind the session and accepted input, but cannot admit a final result.
    return session;
  } finally {
    db.close();
  }
}

/** Runtime-accepted input, not an agent's acknowledgement artifact or screen claim. */
export async function nativeCodexAcceptedPrompt(
  launch: CodexLaunch,
  sessionId: string,
  prompt: string,
): Promise<boolean> {
  z.uuid().parse(sessionId);
  await privateHome(launch.confinement.providerHome);
  const path = join(launch.confinement.providerHome, "history.jsonl");
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
      throw new Error("Invalid private Codex input history");
    // Tail only; earlier turns are irrelevant. Ignore a partial boundary line and
    // an incompletely appended final line, then retry on the next observation.
    const limit = 2 * 1024 * 1024;
    const start = Math.max(0, stat.size - limit);
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8", 0, bytesRead);
    const lines = text.split("\n");
    if (start > 0) lines.shift();
    lines.pop();
    for (const line of lines.reverse()) {
      const record = z
        .object({ session_id: z.string(), text: z.string() })
        .safeParse(JSON.parse(line));
      if (!record.success) throw new Error("Unsupported private Codex input history record");
      if (record.data.session_id === sessionId && record.data.text === prompt) return true;
    }
    return false;
  } finally {
    await file.close();
  }
}

async function privateHome(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (await realpath(path)) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Native provider home must be canonical and owner-only");
}
async function regularFile(path: string, max: number) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    stat.size > max ||
    (await realpath(path)) !== path
  )
    throw new Error("Invalid private Codex state file");
}
function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
