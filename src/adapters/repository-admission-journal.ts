import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ControllerAuthority } from "../domain/orchestration.js";
import {
  RepositoryAdmissionSchema,
  RepositoryIOStopSchema,
  repositoryIOBinding,
  type RepositoryAdmission,
  type RepositoryIOStop,
} from "../domain/repository-admission.js";
import type { StateFileIdentity } from "../domain/state-file-identity.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { redactSensitiveText } from "../util/redact.js";
import { RunStateSchema } from "../domain/types.js";
import { digestJson } from "../domain/repository-policy.js";

export const REPOSITORY_ADMISSION_TABLES = ["repository_admissions"] as const;
export function createRepositoryAdmissionSchema(db: Database.Database) {
  db.exec(`CREATE TABLE repository_admissions (
    run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    CHECK(json_extract(record_json, '$.runId') = run_id)
  ) STRICT;`);
}

/** Run-level ownership outlives the controller lease, pause and every worker conversation. */
export class RepositoryAdmissionJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly journal: OrchestrationJournal,
    private readonly transaction: <T>(authority: ControllerAuthority, body: () => T) => T,
  ) {}

  record(runId: string): RepositoryAdmission | null {
    const row = this.db
      .prepare("SELECT record_json FROM repository_admissions WHERE run_id = ?")
      .get(runId) as { record_json: string } | undefined;
    return row ? RepositoryAdmissionSchema.parse(JSON.parse(row.record_json)) : null;
  }

  reserve(authority: ControllerAuthority, input: RepositoryAdmission) {
    return this.transaction(authority, () => {
      const record = RepositoryAdmissionSchema.parse(input);
      if (
        record.runId !== authority.runId ||
        record.phase !== "reserved" ||
        !record.ioStopped ||
        record.ioId !== null ||
        record.controllerLeaseId !== authority.leaseId ||
        this.record(authority.runId)
      )
        throw new Error("Repository reservation requires a fresh intent for this controller's run");
      if (this.journal.control(authority.runId).status === "complete")
        throw new Error("A completed run cannot acquire repository ownership");
      const row = this.db
        .prepare("SELECT state_json FROM runs WHERE run_id = ?")
        .get(authority.runId) as { state_json: string };
      const state = RunStateSchema.parse(JSON.parse(row.state_json));
      if (
        state.repoPath !== record.repository.root.path ||
        (state.runtimeConfiguration &&
          digestJson(state.runtimeConfiguration.commonDirectory) !==
            digestJson(record.repository.commonDirectory))
      )
        throw new Error("Repository reservation differs from the selected run repository");
      this.db
        .prepare("INSERT INTO repository_admissions VALUES (?, ?)")
        .run(record.runId, JSON.stringify(record));
      this.note(authority, "reserved", record);
      return record;
    });
  }

  begin(
    authority: ControllerAuthority,
    phase: "acquiring" | "releasing",
    ioDirectory: StateFileIdentity,
  ) {
    return this.transaction(authority, () => {
      const record = this.required(authority.runId);
      if (!record.ioStopped || record.phase !== (phase === "acquiring" ? "reserved" : "owned"))
        throw new Error("Settle the original repository operation before another mutation");
      if (phase === "releasing" && this.journal.control(authority.runId).status !== "complete")
        throw new Error("Repository ownership is retained until exact run completion");
      if (phase === "acquiring" && this.journal.control(authority.runId).status === "complete")
        throw new Error("A completed run cannot acquire repository ownership");
      record.phase = phase;
      record.ioStopped = false;
      record.controllerLeaseId = authority.leaseId;
      record.ioId = randomUUID();
      record.ioDirectory = ioDirectory;
      record.ioReceipt = null;
      record.detail = null;
      return this.save(authority, "io_started", record);
    });
  }

  assertIO(authority: ControllerAuthority, ioId: string, phase: "acquiring" | "releasing") {
    this.journal.assertAuthority(authority);
    const record = this.required(authority.runId);
    if (
      record.ioId !== ioId ||
      record.phase !== phase ||
      record.ioStopped ||
      record.controllerLeaseId !== authority.leaseId
    )
      throw new Error("Repository I/O dispatch no longer owns its exact intent");
  }

  /** The adapter validates the private physical receipt; this transaction binds it to the original intent. */
  stopped(authority: ControllerAuthority, input: RepositoryIOStop) {
    return this.transaction(authority, () => {
      const record = this.required(authority.runId);
      const receipt = RepositoryIOStopSchema.parse(input);
      if (
        record.ioId !== receipt.ioId ||
        record.controllerLeaseId !== receipt.controllerLeaseId ||
        record.phase !== receipt.operation ||
        repositoryIOBinding(record) !== receipt.bindingDigest
      )
        throw new Error("Repository stop receipt differs from its exact admitted intent");
      record.ioStopped = true;
      record.ioReceipt = receipt;
      return this.save(authority, "io_stopped", record);
    });
  }

  settle(
    authority: ControllerAuthority,
    phase: "reserved" | "owned" | "released" | "conflict",
    detail: string | null,
  ) {
    return this.transaction(authority, () => {
      const record = this.required(authority.runId);
      if (!record.ioStopped) throw new Error("Repository I/O stop remains unproven");
      const allowed =
        record.phase === "acquiring"
          ? ["reserved", "owned", "conflict"]
          : record.phase === "releasing"
            ? ["owned", "released", "conflict"]
            : record.phase === "owned"
              ? ["conflict"]
              : [];
      if (!allowed.includes(phase)) throw new Error("Invalid repository ownership settlement");
      record.phase = phase;
      record.detail = detail === null ? null : redactSensitiveText(detail, 4000);
      return this.save(authority, phase, record);
    });
  }

  private required(runId: string) {
    const record = this.record(runId);
    if (!record) throw new Error("Repository admission intent is missing");
    return record;
  }
  private save(authority: ControllerAuthority, event: string, input: RepositoryAdmission) {
    const record = RepositoryAdmissionSchema.parse({
      ...input,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare("UPDATE repository_admissions SET record_json = ? WHERE run_id = ?")
      .run(JSON.stringify(record), authority.runId);
    this.note(authority, event, record);
    return record;
  }
  private note(authority: ControllerAuthority, event: string, record: RepositoryAdmission) {
    this.journal.appendObservation(authority, {
      source: "repository-kernel",
      sourceEventId: randomUUID(),
      kind: `repository_admission.${event}`,
      summary: `Repository reservation ${record.reservationId}: ${record.phase}; I/O stopped: ${record.ioStopped}. ${JSON.stringify({ ioId: record.ioId, controllerLeaseId: record.controllerLeaseId, directory: record.ioDirectory, receipt: record.ioReceipt })}`,
      identity: null,
      artifactIds: [],
      wakesOrchestrator: false,
    });
  }
}
