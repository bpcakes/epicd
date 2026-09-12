import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { CodexLaunch } from "../domain/codex-launch.js";
import { redactDiagnosticText } from "../util/redact.js";
import { readNativeCodexSession } from "./codex-native-state.js";

const MAX_FILE = 128 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_RECORDS = 256;
const Uuid = z.uuid();
const RecordSchema = z.object({
  timestamp: z.iso.datetime(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
const RateLimitWindowSchema = z.object({
  used_percent: z.number().finite().nonnegative(),
  window_minutes: z.number().int().nonnegative().nullable(),
  resets_at: z.number().int().nonnegative().nullable(),
});
const KnownRateLimitReachedTypes = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);
const TranscriptRateLimitsSchema = z.object({
  limit_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  limit_name: z.string().max(256).nullable().optional(),
  primary: RateLimitWindowSchema.nullable().optional(),
  secondary: RateLimitWindowSchema.nullable().optional(),
  credits: z
    .object({
      has_credits: z.boolean(),
      unlimited: z.boolean(),
      balance: z
        .string()
        .max(128)
        .regex(/^\d+(?:\.\d+)?$/)
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  individual_limit: z
    .object({ limit: z.number().finite().nonnegative(), used: z.number().finite().nonnegative() })
    .nullable()
    .optional(),
  spend_control_reached: z.boolean().nullable().optional(),
  rate_limit_reached_type: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .nullable()
    .optional(),
});
type Record = z.infer<typeof RecordSchema>;
export type TranscriptDiagnostic = {
  sourceEventId: string;
  kind: string;
  summary: string;
  text: string;
  sourceTruncated: boolean;
};
export type TranscriptProgress = {
  available: boolean;
  matched: boolean;
  finished: boolean;
  more: boolean;
  partial: boolean;
};

/** Pinned Codex 0.153.4 transcript reader shared by SDK and native TUI transports.
 * No public SDK completeness guarantee is inferred from this private-format adapter.
 * Each complete record has a stable byte-offset identity; reconnects replay safely
 * through DiagnosticJournal's immutable source IDs rather than inventing old results.
 */
export class CodexTranscriptReader {
  private offset = 0;
  private fileIdentity: string | null = null;
  private path: string | null = null;
  private sessionId: string | null = null;
  private sessionModel: string | null = null;
  private sessionReasoningEffort: string | null = null;
  private header = false;
  private currentTurn: string | null = null;
  private targetTurn: string | null = null;
  private finished = false;
  private calls = new Map<string, string>();

  constructor(
    private readonly launch: CodexLaunch,
    private readonly prompt: string,
    private readonly emit: (
      record: TranscriptDiagnostic,
      replayCandidates?: readonly TranscriptDiagnostic[],
    ) => void,
  ) {}

  async poll(expectedSession: string | null, check: () => void): Promise<TranscriptProgress> {
    check();
    const session = await readNativeCodexSession(this.launch, expectedSession);
    check();
    if (!session) {
      if (this.sessionId) throw new Error("Observed Codex transcript session disappeared");
      return this.progress(false);
    }
    this.sessionModel = session.model;
    this.sessionReasoningEffort = session.reasoning_effort;
    const localPath = relative(this.launch.confinement.providerHome, session.rollout_path);
    const pattern = new RegExp(
      `^sessions/\\d{4}/\\d{2}/\\d{2}/rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${session.id}\\.jsonl$`,
    );
    if (
      !isAbsolute(session.rollout_path) ||
      resolve(session.rollout_path) !== session.rollout_path ||
      !pattern.test(localPath) ||
      (this.path !== null && (this.path !== session.rollout_path || this.sessionId !== session.id))
    )
      throw new Error("Codex transcript path does not match its private session");
    let file: FileHandle;
    try {
      file = await openTranscript(session.rollout_path, check);
    } catch (error) {
      if (missing(error) && this.fileIdentity === null) return this.progress(false);
      throw error;
    }
    try {
      check();
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.uid !== BigInt(process.getuid!()) ||
        before.size > BigInt(MAX_FILE)
      )
        throw new Error("Codex transcript must be an owned unshared regular file within 128 MiB");
      const identity = `${before.dev}:${before.ino}`;
      if (
        (this.fileIdentity !== null && this.fileIdentity !== identity) ||
        before.size < BigInt(this.offset)
      )
        throw new Error(
          "Codex transcript was replaced or truncated; retained observations remain historical",
        );
      this.path = session.rollout_path;
      this.sessionId = session.id;
      this.fileIdentity = identity;
      const size = Number(before.size);
      const bytes = Buffer.alloc(Math.min(MAX_LINE + 1, size - this.offset));
      let read = 0;
      while (read < bytes.length) {
        check();
        const part = await file.read(bytes, read, bytes.length - read, this.offset + read);
        if (!part.bytesRead) throw new Error("Codex transcript shrank during a read");
        read += part.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (
        after.nlink !== 1n ||
        after.size < before.size ||
        (after.size === before.size &&
          (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs))
      )
        throw new Error("Codex transcript changed in place during a read");
      let consumed = 0,
        count = 0;
      while (count < MAX_RECORDS) {
        const end = bytes.indexOf(10, consumed);
        if (end < 0) break;
        if (end - consumed > MAX_LINE) throw new Error("Codex transcript record exceeds four MiB");
        check();
        const raw = bytes.subarray(consumed, end);
        this.record(
          RecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))),
          raw,
          this.offset + consumed,
        );
        consumed = end + 1;
        count++;
      }
      this.offset += consumed;
      const remaining = bytes.length - consumed;
      if (remaining > MAX_LINE) throw new Error("Codex transcript record exceeds four MiB");
      const partial =
        remaining > 0 && bytes.indexOf(10, consumed) < 0 && this.offset + remaining === size;
      return this.progress(true, this.offset < size && !partial, partial);
    } finally {
      await file.close();
    }
  }

  private progress(available: boolean, more = false, partial = false): TranscriptProgress {
    return { available, matched: this.targetTurn !== null, finished: this.finished, more, partial };
  }

  private record(record: Record, raw: Buffer, offset: number) {
    const payload = record.payload;
    if (!this.header) {
      if (
        offset !== 0 ||
        record.type !== "session_meta" ||
        payload.id !== this.sessionId ||
        payload.cwd !== this.launch.confinement.workspace ||
        payload.cli_version !== "0.153.4"
      )
        throw new Error("Codex transcript header differs from the pinned session");
      this.header = true;
      return; // Never retain base instructions, authentication state, or reasoning.
    }
    if (record.type === "event_msg" && payload.type === "task_started") {
      this.currentTurn = Uuid.parse(payload.turn_id);
      return;
    }
    if (record.type === "response_item" && payload.type === "message") {
      if (payload.role !== "user") return;
      const content = z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .parse(payload.content);
      if (
        content.length !== 1 ||
        content[0]?.type !== "input_text" ||
        content[0].text !== this.prompt
      )
        return;
      const metadata = z
        .object({ turn_id: Uuid })
        .parse(payload.internal_chat_message_metadata_passthrough);
      if (!this.currentTurn || metadata.turn_id !== this.currentTurn || this.targetTurn !== null)
        throw new Error("Codex transcript prompt has ambiguous turn provenance");
      this.targetTurn = this.currentTurn;
      this.emitRecord(
        record,
        raw,
        offset,
        "turn_bound",
        "Exact submitted prompt found in provider transcript",
        {
          promptDigest: digest(Buffer.from(this.prompt)),
        },
      );
      return;
    }
    if (!this.targetTurn || this.currentTurn !== this.targetTurn) return;
    if (!this.finished && record.type === "event_msg" && payload.type === "token_count") {
      if (payload.rate_limits === null || payload.rate_limits === undefined) return;
      const parsedRateLimits = TranscriptRateLimitsSchema.safeParse(payload.rate_limits);
      if (!parsedRateLimits.success) {
        this.emitRecord(
          record,
          raw,
          offset,
          "rate_limits_unsupported",
          "Provider transcript rate-limit snapshot has an unsupported shape",
          {
            executableVersion: "0.153.4",
            issueCount: parsedRateLimits.error.issues.length,
            issues: parsedRateLimits.error.issues.slice(0, 8).map((issue) => ({
              code: issue.code,
              path: issue.path.map(String).join(".") || "$",
            })),
          },
          true,
        );
        return;
      }
      const rateLimits = parsedRateLimits.data;
      const snapshot = (model: string | null, reasoningEffort: string | null) => {
        const associated =
          model === this.launch.model &&
          reasoningEffort === this.launch.reasoningEffort &&
          this.launch.accountBinding !== undefined;
        return this.diagnosticRecord(
          record,
          raw,
          offset,
          "rate_limits",
          associated
            ? "Provider transcript rate-limit snapshot associated with this turn"
            : "Provider transcript rate-limit snapshot is advisory; account or model association is unavailable",
          {
            association: associated ? "turn_scoped" : "advisory",
            bindingId: this.launch.accountBinding?.source.bindingId ?? null,
            model: model,
            reasoningEffort: reasoningEffort,
            executableVersion: "0.153.4",
            limitId: rateLimits.limit_id,
            limitName: rateLimits.limit_name ?? null,
            primary: normalizeWindow(rateLimits.primary),
            secondary: normalizeWindow(rateLimits.secondary),
            credits:
              rateLimits.credits === null || rateLimits.credits === undefined
                ? null
                : {
                    hasCredits: rateLimits.credits.has_credits,
                    unlimited: rateLimits.credits.unlimited,
                    balance: rateLimits.credits.balance ?? null,
                  },
            individualLimit: rateLimits.individual_limit ?? null,
            spendControlReached: rateLimits.spend_control_reached ?? null,
            rateLimitReachedType: rateLimits.rate_limit_reached_type ?? null,
            rateLimitReachedTypeSupport:
              rateLimits.rate_limit_reached_type === null ||
              rateLimits.rate_limit_reached_type === undefined
                ? null
                : KnownRateLimitReachedTypes.has(rateLimits.rate_limit_reached_type)
                  ? "known"
                  : "unsupported",
          },
        );
      };
      // The private-state adapter accepts only null or the pinned launch value
      // for each field. A durable sink can recover the first context by matching
      // these four complete inputs against its immutable, unredacted digest.
      // Redacted display text is deliberately never used as replay state.
      this.emit(
        snapshot(this.sessionModel, this.sessionReasoningEffort),
        [null, this.launch.model].flatMap((model) =>
          [null, this.launch.reasoningEffort].map((effort) => snapshot(model, effort)),
        ),
      );
      return;
    }
    if (record.type === "response_item") {
      if (["custom_tool_call", "function_call"].includes(String(payload.type))) {
        const call = z
          .object({ call_id: z.string().min(1), name: z.string().min(1) })
          .parse(payload);
        const metadata = z
          .object({ turn_id: Uuid })
          .parse(payload.internal_chat_message_metadata_passthrough);
        if (metadata.turn_id !== this.targetTurn || this.finished)
          throw new Error("Codex tool call belongs to another or finished turn");
        if (this.calls.has(call.call_id) || this.calls.size >= 4096)
          throw new Error("Codex transcript has duplicate or excessive tool calls");
        const input = z
          .string()
          .parse(payload.type === "custom_tool_call" ? payload.input : payload.arguments);
        this.calls.set(call.call_id, call.name);
        this.emitRecord(
          record,
          raw,
          offset,
          "tool_call",
          `Provider transcript tool call: ${call.name}`,
          {
            callId: call.call_id,
            tool: call.name,
            input: redactDiagnosticText(input),
          },
        );
      } else if (
        ["custom_tool_call_output", "function_call_output"].includes(String(payload.type))
      ) {
        const callId = z.string().parse(payload.call_id),
          tool = this.calls.get(callId);
        const metadata = z
          .object({ turn_id: Uuid })
          .parse(payload.internal_chat_message_metadata_passthrough);
        if (!tool || metadata.turn_id !== this.targetTurn || this.finished)
          throw new Error("Codex tool output lacks an exact current-turn call");
        const parts =
          typeof payload.output === "string"
            ? null
            : z
                .array(z.object({ type: z.string(), text: z.string().optional() }))
                .parse(payload.output);
        const omitted =
          parts?.some((part) => part.type !== "input_text" || part.text === undefined) ?? false;
        const output = parts
          ? parts
              .map((part) =>
                part.type === "input_text" && part.text !== undefined
                  ? part.text
                  : `[${part.type} content omitted]`,
              )
              .join("\n")
          : z.string().parse(payload.output);
        this.emitRecord(
          record,
          raw,
          offset,
          "tool_result",
          `Provider transcript tool output: ${tool}`,
          {
            callId,
            tool,
            output: redactDiagnosticText(output),
            warning:
              "Tool output can include agent-assembled or reformatted data. Not an independent execution certificate.",
          },
          omitted,
        );
      }
      return;
    }
    if (record.type === "event_msg" && payload.type === "item_completed") {
      if (payload.thread_id !== this.sessionId || payload.turn_id !== this.targetTurn)
        throw new Error("Codex runtime item belongs to another session or turn");
      const item = z.object({ type: z.string() }).parse(payload.item);
      if (item.type === "CommandExecution") {
        const command = z
          .object({
            id: z.string(),
            command: z.array(z.string()),
            cwd: z.string(),
            status: z.string(),
            aggregated_output: z.string(),
            exit_code: z.number().int().nullable().optional(),
          })
          .parse(payload.item);
        this.emitRecord(record, raw, offset, "command", "Provider-retained command diagnostic", {
          ...command,
          command: command.command.map(redactDiagnosticText),
          aggregated_output: redactDiagnosticText(command.aggregated_output),
        });
      }
      return; // In particular, never retain Reasoning or its raw_content.
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      if (payload.turn_id !== this.targetTurn)
        throw new Error("Codex transcript ended another turn");
      this.finished = true;
      this.emitRecord(
        record,
        raw,
        offset,
        "turn_finished",
        "Provider transcript task-complete marker; not process-stop evidence",
        {},
      );
    }
  }

  private emitRecord(
    record: Record,
    raw: Buffer,
    offset: number,
    kind: string,
    summary: string,
    data: object,
    sourceTruncated = false,
  ) {
    this.emit(this.diagnosticRecord(record, raw, offset, kind, summary, data, sourceTruncated));
  }

  private diagnosticRecord(
    record: Record,
    raw: Buffer,
    offset: number,
    kind: string,
    summary: string,
    data: object,
    sourceTruncated = false,
  ): TranscriptDiagnostic {
    return {
      sourceEventId: `${this.sessionId}:${offset}`,
      kind: `runtime.transcript_${kind}`,
      summary,
      sourceTruncated,
      text: JSON.stringify({
        sessionId: this.sessionId,
        providerTurnId: this.targetTurn,
        reportedAt: record.timestamp,
        byteOffset: offset,
        sourceRecordDigest: digest(raw),
        evidenceWarning:
          "Provider-retained diagnostic, not execution, validation, approval or process-stop certification. Provider omissions may be unobservable.",
        ...data,
      }),
    };
  }
}

/** Walk descriptors from /: a symlink in any parent must not redirect the kernel reader. */
async function openTranscript(path: string, check: () => void): Promise<FileHandle> {
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let directory = await open("/", directoryFlags);
  const parts = path.split("/").filter(Boolean);
  try {
    for (const part of parts.slice(0, -1)) {
      check();
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, directoryFlags);
      await directory.close();
      directory = next;
    }
    check();
    return await open(
      `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } finally {
    await directory.close();
  }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function normalizeWindow(window: z.infer<typeof RateLimitWindowSchema> | null | undefined) {
  return window === null || window === undefined
    ? null
    : {
        usedPercent: window.used_percent,
        windowDurationMins: window.window_minutes,
        resetsAt: window.resets_at,
      };
}
function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
