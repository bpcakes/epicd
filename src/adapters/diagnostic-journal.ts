import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ObservationInputSchema,
  TurnIdentitySchema,
  type ControllerAuthority,
  type Observation,
  type ObservationInput,
  type TurnIdentity,
} from "../domain/orchestration.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactDiagnosticText } from "../util/redact.js";

export const DIAGNOSTIC_TABLES = ["diagnostic_artifacts"] as const;
const RETAINED_LIMIT = 64 * 1024;
const INPUT_LIMIT = 4 * 1024 * 1024;
const ArtifactSchema = z.strictObject({
  artifactId: z.uuid(),
  runId: z.string(),
  source: z.string(),
  sourceEventId: z.string(),
  kind: z.string(),
  identity: TurnIdentitySchema.nullable(),
  createdAt: z.iso.datetime(),
  inputBytes: z.number().int().nonnegative(),
  retainedBytes: z.number().int().nonnegative().max(RETAINED_LIMIT),
  contentDigest: z.string().length(64),
  sourceTruncated: z.boolean(),
  locallyTruncated: z.boolean(),
  omission: z.enum(["budget_exhausted", "input_too_large"]).nullable(),
});
export type DiagnosticArtifact = z.infer<typeof ArtifactSchema>;
export class DiagnosticRequestError extends Error {}
type ArtifactRow = {
  artifact_json: string;
  input_digest: string;
  content: string;
  retained_bytes: number;
};
type DiagnosticPort = {
  transaction<T>(authority: ControllerAuthority, body: () => T): T;
  budget(runId: string): number;
  turn(runId: string, identity: TurnIdentity): unknown;
  observe(authority: ControllerAuthority, input: ObservationInput): Observation;
  exhaust(authority: ControllerAuthority): void;
};

export function createDiagnosticsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS diagnostic_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      source TEXT NOT NULL, source_event_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
      content TEXT NOT NULL,
      retained_bytes INTEGER NOT NULL CHECK(retained_bytes >= 0 AND retained_bytes <= ${RETAINED_LIMIT}),
      UNIQUE(run_id, source, source_event_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS diagnostic_artifacts_by_run ON diagnostic_artifacts(run_id);
  `);
}

/** Immutable diagnostic bytes and their observation reference share the lease-guarded SQLite transaction. */
export class DiagnosticJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly port: DiagnosticPort,
  ) {}

  append(
    authority: ControllerAuthority,
    input: Omit<ObservationInput, "artifactIds">,
    text: string,
    sourceTruncated = false,
  ): { observation: Observation; artifact: DiagnosticArtifact } {
    const parsed = ObservationInputSchema.parse({
      ...input,
      summary: redactDiagnosticText(input.summary).slice(0, 7000),
      artifactIds: [],
    });
    if (parsed.identity && parsed.identity.runId !== authority.runId)
      throw new Error("Diagnostic belongs to a different run");
    // Keep only a digest of raw input: redaction must not make conflicting source-event reuse look identical.
    const inputDigest = diagnosticInputDigest(input, text, sourceTruncated);
    return this.port.transaction(authority, () => {
      if (parsed.identity) this.port.turn(authority.runId, parsed.identity);
      const previous = this.db
        .prepare(
          "SELECT * FROM diagnostic_artifacts WHERE run_id = ? AND source = ? AND source_event_id = ?",
        )
        .get(authority.runId, parsed.source, parsed.sourceEventId) as ArtifactRow | undefined;
      let artifact: DiagnosticArtifact;
      if (previous) {
        if (previous.input_digest !== inputDigest)
          throw new Error("Diagnostic source ID was reused with different content");
        artifact = this.decode(previous);
      } else {
        const inputBytes = Buffer.byteLength(text);
        const redacted = inputBytes <= INPUT_LIMIT ? redactDiagnosticText(text) : "";
        let content = retainedText(redacted);
        let omission: DiagnosticArtifact["omission"] =
          inputBytes > INPUT_LIMIT ? "input_too_large" : null;
        if (
          this.usage(authority.runId).retainedBytes + Buffer.byteLength(content) >
          this.port.budget(authority.runId)
        ) {
          content = "";
          omission = "budget_exhausted";
        }
        artifact = ArtifactSchema.parse({
          artifactId: randomUUID(),
          runId: authority.runId,
          source: parsed.source,
          sourceEventId: parsed.sourceEventId,
          kind: parsed.kind,
          identity: parsed.identity,
          createdAt: new Date().toISOString(),
          inputBytes,
          retainedBytes: Buffer.byteLength(content),
          contentDigest: digest(content),
          sourceTruncated,
          locallyTruncated: omission !== null || redacted !== content,
          omission,
        });
        this.db
          .prepare(
            "INSERT INTO diagnostic_artifacts(artifact_id, run_id, source, source_event_id, input_digest, artifact_json, content, retained_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            artifact.artifactId,
            authority.runId,
            parsed.source,
            parsed.sourceEventId,
            inputDigest,
            JSON.stringify(artifact),
            content,
            artifact.retainedBytes,
          );
      }
      const observation = this.port.observe(authority, {
        ...parsed,
        summary: `${parsed.summary}\nDiagnostic artifact ${artifact.artifactId}; ${artifact.omission ?? (artifact.sourceTruncated || artifact.locallyTruncated ? "partial observation" : "retained observation")}. Not validation or approval.`,
        artifactIds: [artifact.artifactId],
      });
      if (!previous && artifact.omission === "budget_exhausted") this.port.exhaust(authority);
      return { observation, artifact };
    });
  }

  read(runId: string, artifactId: string, offset: number, limit: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      throw new DiagnosticRequestError("Invalid diagnostic character range");
    const { artifact, text } = this.retained(runId, artifactId);
    const page = {
      ...artifact,
      evidenceWarning:
        "Diagnostic observation only; never validation, independent approval or proof of process stop. Gaps and omissions cannot be recovered by paging.",
      offsetUnit: "redacted_utf16_characters",
      offset,
      total: text.length,
      text: text.slice(offset, offset + limit),
      nextOffset: null as number | null,
    };
    // Escaping may make a character page much larger than its UTF-8 content.
    while (Buffer.byteLength(JSON.stringify(page)) > 63000 && page.text.length)
      page.text = page.text.slice(0, Math.floor(page.text.length / 2));
    page.nextOffset = offset + page.text.length < page.total ? offset + page.text.length : null;
    return page;
  }

  /** Match original input, never the redacted or clipped display artifact.
   * Callers must still append the selected input to check authority and replay it.
   */
  matchesInput(
    runId: string,
    input: Omit<ObservationInput, "artifactIds">,
    text: string,
    sourceTruncated = false,
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT input_digest FROM diagnostic_artifacts WHERE run_id = ? AND source = ? AND source_event_id = ?",
      )
      .get(runId, input.source, input.sourceEventId) as { input_digest: string } | undefined;
    return row?.input_digest === diagnosticInputDigest(input, text, sourceTruncated);
  }

  /** Complete retained content, still redacted and potentially originally truncated. */
  retained(runId: string, artifactId: string) {
    const row = this.db
      .prepare("SELECT * FROM diagnostic_artifacts WHERE run_id = ? AND artifact_id = ?")
      .get(runId, artifactId) as ArtifactRow | undefined;
    if (!row) throw new DiagnosticRequestError("Diagnostic artifact is not retained in this run");
    const artifact = this.decode(row);
    if (artifact.runId !== runId || artifact.artifactId !== artifactId)
      throw new Error("Diagnostic artifact identity is inconsistent with its journal key");
    return { artifact, text: row.content };
  }

  usage(runId: string): { count: number; retainedBytes: number } {
    return this.db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(retained_bytes), 0) AS retainedBytes FROM diagnostic_artifacts WHERE run_id = ?",
      )
      .get(runId) as { count: number; retainedBytes: number };
  }

  summary(runId: string) {
    const latest = (
      this.db
        .prepare(
          "SELECT artifact_json FROM diagnostic_artifacts WHERE run_id = ? ORDER BY rowid DESC LIMIT 10",
        )
        .all(runId) as { artifact_json: string }[]
    ).map((row) => ArtifactSchema.parse(JSON.parse(row.artifact_json)));
    return { ...this.usage(runId), budgetBytes: this.port.budget(runId), latest };
  }

  private decode(row: ArtifactRow): DiagnosticArtifact {
    const artifact = ArtifactSchema.parse(JSON.parse(row.artifact_json));
    if (
      artifact.retainedBytes !== row.retained_bytes ||
      Buffer.byteLength(row.content) !== row.retained_bytes ||
      digest(row.content) !== artifact.contentDigest
    )
      throw new Error("Retained diagnostic failed its content integrity check");
    return artifact;
  }
}

function diagnosticInputDigest(
  input: Omit<ObservationInput, "artifactIds">,
  text: string,
  sourceTruncated: boolean,
): string {
  return digestJson({ input, text, sourceTruncated });
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function retainedText(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= RETAINED_LIMIT) return text;
  const marker = "\n[diagnostic content omitted]\n";
  const half = Math.floor((RETAINED_LIMIT - Buffer.byteLength(marker)) / 2);
  const head = new TextDecoder().decode(bytes.subarray(0, half), { stream: true });
  let start = bytes.length - half;
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return head + marker + bytes.subarray(start).toString("utf8");
}
