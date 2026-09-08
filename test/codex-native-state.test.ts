import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  readNativeCodexSession,
  nativeCodexAcceptedPrompt,
} from "../src/adapters/codex-native-state.js";
import { CodexLaunchSchema } from "../src/domain/codex-launch.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "epicd-native-state-"));
  roots.push(root);
  const providerHome = join(root, "provider");
  await mkdir(providerHome, { mode: 0o700 });
  const launch = CodexLaunchSchema.parse({
    generation: randomUUID(),
    controlDirectory: join(root, "control"),
    authCachePath: null,
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
  const path = join(providerHome, "state_5.sqlite");
  const session = {
    id: randomUUID(),
    cwd: launch.confinement.workspace,
    model: launch.model,
    reasoning_effort: launch.reasoningEffort,
    cli_version: "0.153.4",
    rollout_path: join(providerHome, "sessions", "unused.jsonl"),
  };
  function database(rows: object[] = [session], view = false) {
    const db = new Database(path);
    try {
      db.exec(
        "CREATE TABLE records(id TEXT, cwd TEXT, model TEXT, reasoning_effort TEXT, cli_version TEXT, rollout_path TEXT)",
      );
      for (const row of rows)
        db.prepare(
          "INSERT INTO records VALUES (@id,@cwd,@model,@reasoning_effort,@cli_version,@rollout_path)",
        ).run(row);
      db.exec(
        view
          ? "CREATE VIEW threads AS SELECT * FROM records"
          : "ALTER TABLE records RENAME TO threads",
      );
    } finally {
      db.close();
    }
  }
  const history = join(providerHome, "history.jsonl");
  return { root, launch, session, path, database, history };
}

describe("pinned native provider identity and input acceptance", () => {
  it("distinguishes an absent or empty runtime store from a verified exact session", async () => {
    const setup = await fixture();
    expect(await readNativeCodexSession(setup.launch, null)).toBeNull();
    setup.database([]);
    expect(await readNativeCodexSession(setup.launch, null)).toBeNull();
    const db = new Database(setup.path);
    try {
      db.prepare(
        "INSERT INTO threads VALUES (@id,@cwd,@model,@reasoning_effort,@cli_version,@rollout_path)",
      ).run(setup.session);
    } finally {
      db.close();
    }
    expect(await readNativeCodexSession(setup.launch, setup.session.id)).toEqual(setup.session);
    await expect(readNativeCodexSession(setup.launch, randomUUID())).rejects.toThrow(
      "pinned launch contract",
    );
  });

  it.each(["cwd", "model", "reasoning_effort", "cli_version"] as const)(
    "rejects provider %s drift",
    async (key) => {
      const setup = await fixture();
      setup.database([{ ...setup.session, [key]: "different" }]);
      await expect(readNativeCodexSession(setup.launch, null)).rejects.toThrow(
        "pinned launch contract",
      );
    },
  );

  it("reports provisional runtime identity without inventing missing model metadata", async () => {
    const setup = await fixture();
    setup.database([{ ...setup.session, model: null, reasoning_effort: null }]);
    expect(await readNativeCodexSession(setup.launch, setup.session.id)).toEqual({
      ...setup.session,
      model: null,
      reasoning_effort: null,
    });
  });

  it("rejects ambiguous sessions and unsupported schema instead of guessing from the screen", async () => {
    const ambiguous = await fixture();
    ambiguous.database([ambiguous.session, { ...ambiguous.session, id: randomUUID() }]);
    await expect(readNativeCodexSession(ambiguous.launch, null)).rejects.toThrow("ambiguous");
    const view = await fixture();
    view.database([view.session], true);
    await expect(readNativeCodexSession(view.launch, null)).rejects.toThrow(
      "Unsupported private Codex thread store",
    );
  });

  it("rejects shared provider storage, linked databases, and linked SQLite sidecars", async () => {
    const shared = await fixture();
    await chmod(shared.launch.confinement.providerHome, 0o755);
    await expect(readNativeCodexSession(shared.launch, null)).rejects.toThrow("owner-only");
    const linked = await fixture();
    linked.database();
    await link(linked.path, join(linked.root, "alias"));
    await expect(readNativeCodexSession(linked.launch, null)).rejects.toThrow(
      "Invalid private Codex state file",
    );
    const sidecar = await fixture();
    sidecar.database();
    await symlink(sidecar.path, sidecar.path + "-wal");
    await expect(readNativeCodexSession(sidecar.launch, null)).rejects.toThrow(
      "Invalid private Codex state file",
    );
  });

  it("requires the exact session and full accepted input; ignores incomplete final appends", async () => {
    const setup = await fixture();
    const prompt = 'Unique turn: "receipt"\nDo the bounded work';
    const record = JSON.stringify({ session_id: setup.session.id, text: prompt });
    expect(await nativeCodexAcceptedPrompt(setup.launch, setup.session.id, prompt)).toBe(false);
    await writeFile(setup.history, record);
    expect(await nativeCodexAcceptedPrompt(setup.launch, setup.session.id, prompt)).toBe(false);
    await writeFile(setup.history, record + "\n");
    expect(await nativeCodexAcceptedPrompt(setup.launch, setup.session.id, prompt)).toBe(true);
    expect(await nativeCodexAcceptedPrompt(setup.launch, randomUUID(), prompt)).toBe(false);
    expect(await nativeCodexAcceptedPrompt(setup.launch, setup.session.id, prompt + "!")).toBe(
      false,
    );
  });

  it("bounds history reads while retaining a full recent prompt, and rejects aliases or malformed records", async () => {
    const setup = await fixture();
    const record = JSON.stringify({ session_id: setup.session.id, text: "current" }) + "\n";
    await writeFile(setup.history, "x".repeat(2 * 1024 * 1024 + 100) + "\n" + record);
    expect(await nativeCodexAcceptedPrompt(setup.launch, setup.session.id, "current")).toBe(true);
    await writeFile(setup.history, "{}\n");
    await expect(
      nativeCodexAcceptedPrompt(setup.launch, setup.session.id, "current"),
    ).rejects.toThrow("Unsupported");
    await link(setup.history, join(setup.root, "history-alias"));
    await expect(
      nativeCodexAcceptedPrompt(setup.launch, setup.session.id, "current"),
    ).rejects.toThrow("Invalid private");
  });
});
