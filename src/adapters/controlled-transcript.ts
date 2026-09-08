import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CodexLaunch } from "../domain/codex-launch.js";
import type { ControllerAuthority, TurnIdentity } from "../domain/orchestration.js";
import { redactDiagnosticText } from "../util/redact.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { CodexTranscriptReader, type TranscriptProgress } from "./codex-transcript.js";

/** Diagnostic ingestion only. Never acknowledges a prompt, accepts a result, or releases a process. */
export class ControlledTranscript {
  private reader: CodexTranscriptReader;
  constructor(
    private readonly journal: OrchestrationJournal,
    private readonly authority: ControllerAuthority,
    private readonly identity: TurnIdentity,
    private readonly launch: CodexLaunch,
    private readonly prompt: string,
  ) {
    this.reader = this.createReader();
  }

  private createReader() {
    return new CodexTranscriptReader(this.launch, this.prompt, (record) => {
      const retained = this.journal.diagnostics.append(
        this.authority,
        {
          source: "codex-transcript",
          sourceEventId: `${this.identity.turnId}:${record.sourceEventId}`,
          kind: record.kind,
          summary: record.summary,
          identity: this.identity,
          wakesOrchestrator: true,
        },
        record.text,
        record.sourceTruncated,
      );
      if (retained.artifact.omission !== null)
        throw new Error(`Transcript diagnostic was omitted: ${retained.artifact.omission}`);
    });
  }

  async poll(sessionId: string | null, check: () => void): Promise<TranscriptProgress> {
    try {
      return await this.reader.poll(sessionId, check);
    } catch (error) {
      // A sink failure may follow earlier committed records in the same batch.
      // Rebuild parser state on retry; immutable journal IDs deduplicate replay.
      this.reader = this.createReader();
      throw error;
    }
  }

  watch(sessionId: () => string | null, check: () => void, fail: (error: unknown) => void) {
    const stopping = new AbortController();
    const done = (async () => {
      try {
        while (!stopping.signal.aborted) {
          check();
          const session = sessionId();
          const progress = session ? await this.poll(session, check) : null;
          if (!progress?.more) await delay(500, undefined, { signal: stopping.signal });
        }
      } catch (error) {
        if (!stopping.signal.aborted) fail(error);
      }
    })();
    return async () => {
      stopping.abort();
      await done; // Never race a final drain against a still-running poll.
    };
  }

  async finish(sessionId: string | null, check: () => void): Promise<TranscriptProgress> {
    let progress: TranscriptProgress;
    do {
      check();
      progress = await this.poll(sessionId, check);
    } while (progress.more);
    if (!progress.available || !progress.matched || !progress.finished || progress.partial)
      this.gap(
        !progress.available
          ? "Provider transcript is unavailable"
          : !progress.matched
            ? "Exact submitted turn was not found in the provider transcript"
            : progress.partial
              ? "Provider transcript ends with an incomplete record"
              : "Provider transcript has no task-complete marker for this turn",
      );
    return progress;
  }

  gap(detail: string): void {
    const summary = redactDiagnosticText(detail).slice(0, 4000);
    this.journal.appendObservation(this.authority, {
      source: "codex-transcript",
      sourceEventId: `${this.identity.turnId}:gap:${createHash("sha256").update(summary).digest("hex")}`,
      kind: "runtime.observation_gap",
      summary: `${summary}. Retained diagnostics are incomplete; do not reconstruct missing execution or treat transcript markers as approval or stop evidence.`,
      artifactIds: [],
      identity: this.identity,
      wakesOrchestrator: true,
    });
  }
}
