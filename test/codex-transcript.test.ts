import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { link, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexTranscriptReader,
  type TranscriptDiagnostic,
} from "../src/adapters/codex-transcript.js";
import { runCommand } from "../src/util/command.js";
import { transcriptFixture } from "./fixtures/codex-transcript.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const s = await transcriptFixture();
  roots.push(s.root);
  const records: TranscriptDiagnostic[] = [];
  const reader = new CodexTranscriptReader(s.launch, s.prompt, (record) => records.push(record));
  return { ...s, records, reader, poll: () => reader.poll(s.session, () => {}) };
}

describe("pinned Codex transcript diagnostics", () => {
  it("retains the original tool failure with exact turn and byte provenance, never private reasoning or instructions", async () => {
    const s = await fixture();
    const reasoning =
      s.line("response_item", { type: "reasoning", raw_content: "NEVER_COPY_REASONING" }) +
      s.line("event_msg", {
        type: "item_completed",
        thread_id: s.session,
        turn_id: s.turn,
        item: { type: "Reasoning", raw_content: "NEVER_COPY_RAW_REASONING" },
      });
    await s.append(reasoning + s.call() + s.output() + s.complete);
    expect(await s.poll()).toEqual({
      available: true,
      matched: true,
      finished: true,
      more: false,
      partial: false,
    });
    expect(s.records.map((r) => r.kind)).toEqual([
      "runtime.transcript_turn_bound",
      "runtime.transcript_tool_call",
      "runtime.transcript_tool_result",
      "runtime.transcript_turn_finished",
    ]);
    const failure = s.records[2]!;
    const offset = Buffer.byteLength(s.prefix + reasoning + s.call());
    expect(failure.sourceEventId).toBe(`${s.session}:${offset}`);
    expect(JSON.parse(failure.text)).toMatchObject({
      sessionId: s.session,
      providerTurnId: s.turn,
      byteOffset: offset,
      sourceRecordDigest: createHash("sha256").update(s.output().slice(0, -1)).digest("hex"),
      output: 'exit code 1: peer authentication failed\n{"password":"[REDACTED]"}',
    });
    expect(failure.text).toContain("Not an independent execution certificate");
    expect(JSON.stringify(s.records)).not.toMatch(/NEVER_COPY|never-retain-password/);
    await s.poll();
    expect(s.records).toHaveLength(4);
  });

  it("captures native commands and function calls without inventing successful validation", async () => {
    const s = await fixture();
    await s.append(
      s.line("response_item", {
        type: "function_call",
        name: "exec_command",
        call_id: "f",
        arguments: '{"cmd":"false"}',
        internal_chat_message_metadata_passthrough: { turn_id: s.turn },
      }) +
        s.line("response_item", {
          type: "function_call_output",
          call_id: "f",
          output: "Process exited with code 1",
          internal_chat_message_metadata_passthrough: { turn_id: s.turn },
        }) +
        s.line("event_msg", {
          type: "item_completed",
          thread_id: s.session,
          turn_id: s.turn,
          item: {
            type: "CommandExecution",
            id: "exec-browser",
            command: ["sh", "-c", "npm run test:e2e"],
            cwd: `file://${s.launch.confinement.workspace}`,
            status: "completed",
            exit_code: 1,
            aggregated_output: "listen EPERM 127.0.0.1:4173",
          },
        }) +
        s.complete,
    );
    await s.poll();
    expect(s.records.map((r) => r.kind)).toEqual([
      "runtime.transcript_turn_bound",
      "runtime.transcript_tool_call",
      "runtime.transcript_tool_result",
      "runtime.transcript_command",
      "runtime.transcript_turn_finished",
    ]);
    expect(JSON.parse(s.records[3]!.text)).toMatchObject({
      exit_code: 1,
      aggregated_output: "listen EPERM 127.0.0.1:4173",
    });
    for (const record of s.records)
      expect(JSON.parse(record.text).evidenceWarning).toContain(
        "not execution, validation, approval or process-stop certification",
      );
  });

  it("retains only allowlisted rate-limit fields with exact session, turn, model, and binding provenance", async () => {
    const s = await fixture();
    await s.append(
      s.rateLimits({
        primary: { used_percent: 100, window_minutes: 300, resets_at: 1_789_000_000 },
        rate_limit_reached_type: "workspace_member_usage_limit_reached",
        untrusted_extra: "NEVER_RETAIN_EXTRA",
        credits: {
          has_credits: false,
          unlimited: false,
          balance: "0",
          access_token: "NEVER_RETAIN_TOKEN",
        },
      }) + s.complete,
    );
    await s.poll();
    expect(s.records.map((record) => record.kind)).toEqual([
      "runtime.transcript_turn_bound",
      "runtime.transcript_rate_limits",
      "runtime.transcript_turn_finished",
    ]);
    const snapshot = JSON.parse(s.records[1]!.text);
    expect(snapshot).toMatchObject({
      sessionId: s.session,
      providerTurnId: s.turn,
      association: "turn_scoped",
      bindingId: "a".repeat(64),
      model: s.launch.model,
      reasoningEffort: s.launch.reasoningEffort,
      executableVersion: "0.153.4",
      limitId: "premium",
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_789_000_000 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      rateLimitReachedType: "workspace_member_usage_limit_reached",
      rateLimitReachedTypeSupport: "known",
    });
    expect(s.records[1]!.text).not.toMatch(/NEVER_RETAIN|access_token|untrusted_extra/);
    expect(snapshot.evidenceWarning).toContain("not execution");
  });

  it("ignores rate-limit snapshots from another turn in the same session", async () => {
    const s = await fixture();
    const foreign = randomUUID();
    await s.append(
      s.complete +
        s.line("event_msg", { type: "task_started", turn_id: foreign }) +
        s.input("other prompt", foreign) +
        s.rateLimits({ limit_id: "foreign-bucket", untrusted_extra: "NEVER_RETAIN_FOREIGN" }),
    );
    await s.poll();
    expect(s.records.map((record) => record.kind)).toEqual([
      "runtime.transcript_turn_bound",
      "runtime.transcript_turn_finished",
    ]);
    expect(JSON.stringify(s.records)).not.toContain("foreign-bucket");
    expect(JSON.stringify(s.records)).not.toContain("NEVER_RETAIN_FOREIGN");
  });

  it("does not associate an unscoped rate-limit snapshot after task completion", async () => {
    const s = await fixture();
    await s.append(s.complete + s.rateLimits({ limit_id: "after-completion" }));
    await s.poll();
    expect(s.records.map((record) => record.kind)).toEqual([
      "runtime.transcript_turn_bound",
      "runtime.transcript_turn_finished",
    ]);
    expect(JSON.stringify(s.records)).not.toContain("after-completion");
  });

  it("keeps a snapshot advisory when the private session has no model association", async () => {
    const s = await fixture();
    const db = new Database(s.statePath);
    try {
      db.prepare("UPDATE threads SET model = NULL WHERE id = ?").run(s.session);
    } finally {
      db.close();
    }
    await s.append(s.rateLimits() + s.complete);
    await s.poll();
    expect(JSON.parse(s.records[1]!.text)).toMatchObject({
      sessionId: s.session,
      providerTurnId: s.turn,
      association: "advisory",
      model: null,
      limitId: "premium",
    });
  });

  it("retains malformed current-turn quota snapshots as an explicit gap without aborting the turn", async () => {
    const s = await fixture();
    await s.append(
      s.rateLimits({ limit_id: "", access_token: "NEVER_RETAIN_UNSUPPORTED" }) + s.complete,
    );
    await expect(s.poll()).resolves.toMatchObject({ finished: true });
    expect(s.records.map((record) => record.kind)).toEqual([
      "runtime.transcript_turn_bound",
      "runtime.transcript_rate_limits_unsupported",
      "runtime.transcript_turn_finished",
    ]);
    const gap = JSON.parse(s.records[1]!.text);
    expect(gap).toMatchObject({
      executableVersion: "0.153.4",
      issueCount: 2,
      issues: [
        { code: "too_small", path: "limit_id" },
        { code: "invalid_format", path: "limit_id" },
      ],
    });
    expect(s.records[1]).toMatchObject({ sourceTruncated: true });
    expect(s.records[1]!.text).not.toContain("NEVER_RETAIN_UNSUPPORTED");
  });

  it("preserves an unknown reached-type as unsupported advisory data", async () => {
    const s = await fixture();
    await s.append(s.rateLimits({ rate_limit_reached_type: "future_limit_kind" }) + s.complete);
    await s.poll();
    expect(JSON.parse(s.records[1]!.text)).toMatchObject({
      rateLimitReachedType: "future_limit_kind",
      rateLimitReachedTypeSupport: "unsupported",
    });
  });

  it("ignores other prompts and subsequent turns, and marks missing exact input", async () => {
    const s = await fixture();
    const foreign = randomUUID();
    await s.append(
      s.call() +
        s.output() +
        s.complete +
        s.line("event_msg", { type: "task_started", turn_id: foreign }) +
        s.input("other-turn", foreign) +
        s.call("other", "NEVER_COPY_OTHER_TURN"),
    );
    await s.poll();
    expect(JSON.stringify(s.records)).not.toContain("NEVER_COPY_OTHER_TURN");
    const records: TranscriptDiagnostic[] = [];
    const reader = new CodexTranscriptReader(s.launch, s.prompt + "changed", (r) =>
      records.push(r),
    );
    expect(await reader.poll(s.session, () => {})).toMatchObject({
      matched: false,
      finished: false,
    });
    expect(records).toEqual([]);
  });

  it.each([
    "foreign-session",
    "foreign-turn",
    "duplicate-prompt",
    "duplicate-call",
    "orphan-output",
    "call-after-finish",
  ])("rejects %s provenance", async (mode) => {
    const s = await fixture();
    const suffix =
      mode === "foreign-session"
        ? s.line("event_msg", {
            type: "item_completed",
            thread_id: randomUUID(),
            turn_id: s.turn,
            item: { type: "CommandExecution" },
          })
        : mode === "foreign-turn"
          ? s.line("response_item", {
              type: "custom_tool_call",
              call_id: "f",
              name: "exec",
              input: "false",
              internal_chat_message_metadata_passthrough: { turn_id: randomUUID() },
            })
          : mode === "duplicate-prompt"
            ? s.input()
            : mode === "duplicate-call"
              ? s.call() + s.call()
              : mode === "orphan-output"
                ? s.output()
                : s.complete + s.call();
    await s.append(suffix);
    await expect(s.poll()).rejects.toThrow();
  });

  it("handles yielded outputs, non-text omissions, and incomplete UTF-8 appends", async () => {
    const s = await fixture();
    await s.append(s.call());
    const bytes = Buffer.from(s.output("partial Žluťoučký 🐈"));
    const split = bytes.indexOf(Buffer.from("🐈")) + 2;
    await s.append(bytes.subarray(0, split));
    expect(await s.poll()).toMatchObject({ partial: true, more: false, finished: false });
    expect(s.records).toHaveLength(2);
    await s.append(bytes.subarray(split));
    await s.append(
      s.line("response_item", {
        type: "custom_tool_call_output",
        call_id: "call-browser",
        output: [
          { type: "input_image", image_url: "NEVER_COPY_IMAGE" },
          { type: "input_text", text: "final chunk" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: s.turn },
      }) + s.complete,
    );
    expect(await s.poll()).toMatchObject({ partial: false, finished: true });
    expect(JSON.parse(s.records[2]!.text).output).toBe("partial Žluťoučký 🐈");
    expect(s.records[3]).toMatchObject({ sourceTruncated: true });
    expect(s.records[3]!.text).toContain("input_image content omitted");
    expect(JSON.stringify(s.records)).not.toContain("NEVER_COPY_IMAGE");
  });

  it("drains bounded batches and checks cancellation within a batch", async () => {
    const s = await fixture();
    await s.append(
      Array.from(
        { length: 300 },
        (_, i) => s.call(`call-${i}`) + s.output(`result-${i}`, `call-${i}`),
      ).join("") + s.complete,
    );
    expect(await s.poll()).toMatchObject({ more: true, finished: false });
    let checked = 0;
    await expect(
      s.reader.poll(s.session, () => {
        if (++checked === 30) throw new Error("authority expired");
      }),
    ).rejects.toThrow("authority expired");
    const replay: TranscriptDiagnostic[] = [];
    const reader = new CodexTranscriptReader(s.launch, s.prompt, (r) => replay.push(r));
    let progress;
    do {
      progress = await reader.poll(s.session, () => {});
    } while (progress.more);
    expect(progress.finished).toBe(true);
    expect(replay).toHaveLength(602);
    expect(new Set(replay.map((r) => r.sourceEventId)).size).toBe(602);
  });

  it.each(["oversized-file", "oversized-line", "invalid-utf8", "invalid-json", "wrong-header"])(
    "rejects %s",
    async (mode) => {
      const s = await fixture();
      if (mode === "oversized-file") await truncate(s.path, 128 * 1024 * 1024 + 1);
      else if (mode === "oversized-line") await s.append("x".repeat(4 * 1024 * 1024 + 1));
      else if (mode === "invalid-utf8") await s.append(Buffer.from([0xff, 10]));
      else if (mode === "invalid-json") await s.append("{broken}\n");
      else await writeFile(s.path, s.header.replace("0.153.4", "0.153.5"));
      await expect(async () => {
        let result;
        do {
          result = await s.poll();
        } while (result.more);
      }).rejects.toThrow();
    },
  );

  it.each([
    "symlink",
    "hardlink",
    "parent-symlink",
    "fifo",
    "foreign-path",
    "replacement",
    "truncation",
  ])("rejects %s without following aliases or hanging", async (mode) => {
    const s = await fixture();
    if (mode === "replacement" || mode === "truncation") await s.poll();
    if (mode === "symlink") {
      await rename(s.path, s.path + ".saved");
      await symlink(s.path + ".saved", s.path);
    } else if (mode === "hardlink") await link(s.path, s.path + ".alias");
    else if (mode === "parent-symlink") {
      const parent = dirname(s.path);
      await rename(parent, parent + ".saved");
      await symlink(parent + ".saved", parent);
    } else if (mode === "fifo") {
      await rename(s.path, s.path + ".saved");
      await runCommand("mkfifo", [s.path], { cwd: s.root });
    } else if (mode === "foreign-path") {
      const db = new Database(s.statePath);
      try {
        db.prepare("UPDATE threads SET rollout_path = ?").run(join(s.root, "auth.json"));
      } finally {
        db.close();
      }
    } else if (mode === "replacement") {
      await rename(s.path, s.path + ".saved");
      await writeFile(s.path, s.prefix);
    } else await truncate(s.path, 0);
    await expect(s.poll()).rejects.toThrow();
  });

  it("reports absent transcripts, but rejects a disappearing observed file or session", async () => {
    const s = await fixture();
    await rename(s.path, s.path + ".saved");
    expect(await s.poll()).toMatchObject({ available: false, matched: false });
    await rename(s.path + ".saved", s.path);
    expect(await s.poll()).toMatchObject({ available: true, matched: true });
    await rename(s.path, s.path + ".saved");
    await expect(s.poll()).rejects.toThrow();
    await rename(s.statePath, s.statePath + ".saved");
    await expect(s.poll()).rejects.toThrow("session disappeared");
  });
});
