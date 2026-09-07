import { randomUUID } from "node:crypto";
import type { StateStore } from "../adapters/store.js";
import { PublicationGit, RUN_OWNERSHIP_REF } from "../adapters/publication-git.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import {
  RepositoryAdmissionSchema,
  type RepositoryAdmission as AdmissionRecord,
} from "../domain/repository-admission.js";
import { digestJson } from "../domain/repository-policy.js";
import type { PublicationRepository } from "../domain/publication.js";

/** Admission is a kernel prerequisite, not delivery strategy or an agent capability. */
export class RepositoryAdmission {
  constructor(
    private readonly store: StateStore,
    private readonly authority: ControllerAuthority,
    private readonly repository: PublicationRepository,
    private readonly git = new PublicationGit("run"),
  ) {}
  private get journal() {
    return this.store.orchestration;
  }
  private get records() {
    return this.journal.repositoryAdmission;
  }

  async enter(signal?: AbortSignal) {
    this.journal.assertAuthority(this.authority);
    let record = this.records.record(this.authority.runId);
    if (this.journal.control(this.authority.runId).status === "complete") {
      if (record && record.phase !== "released") await this.release(signal);
      return;
    }
    if (!record) {
      const at = new Date().toISOString(),
        reservationId = randomUUID();
      const stateFile = this.store.storageIdentity();
      const objectContent = JSON.stringify({
        schemaVersion: 1,
        kind: "epicd-run-owner",
        runId: this.authority.runId,
        reservationId,
        stateFile,
        commonDirectory: this.repository.commonDirectory,
      });
      const revision = await this.git.planLock(this.repository, objectContent, signal);
      this.journal.assertAuthority(this.authority);
      record = this.records.reserve(
        this.authority,
        RepositoryAdmissionSchema.parse({
          schemaVersion: 1,
          runId: this.authority.runId,
          reservationId,
          repository: this.repository,
          stateFile,
          objectContent,
          revision,
          phase: "reserved",
          ioStopped: true,
          controllerLeaseId: this.authority.leaseId,
          ioId: null,
          detail: null,
          createdAt: at,
          updatedAt: at,
        }),
      );
    }
    this.assertIdentity(record);
    if (!record.ioStopped)
      throw new Error(
        "Repository admission I/O has no independent stop proof; preserve the reservation and do not repeat it",
      );
    if (record.phase === "acquiring" || record.phase === "releasing")
      record = await this.inspectStopped(record, signal);
    if (record.phase === "owned") return this.assertOwned(signal);
    if (record.phase !== "reserved")
      throw new Error(
        `Repository admission is ${record.phase}; preserve the recorded ownership conflict`,
      );

    const current = await this.git.inspectLock(this.repository, signal);
    if (current !== null)
      throw new Error(
        `Another run owns this repository, possibly through another state file or linked checkout; inspect ${RUN_OWNERSHIP_REF} for its recorded run and state location, then resume the owning run. Do not delete its reservation to bypass ownership.`,
      );
    const intent = this.records.begin(this.authority, "acquiring");
    try {
      await this.git.acquireLock(
        this.repository,
        intent.revision,
        intent.objectContent,
        async () => {
          this.assertIdentity(intent);
          this.records.assertIO(this.authority, intent.ioId!, "acquiring");
        },
        signal ?? new AbortController().signal,
      );
    } finally {
      // KernelGit awaits process closure and its prepared-ref guard. A lost lease cannot attest it.
      this.records.stopped(this.authority, intent.ioId!);
    }
    const settled = await this.inspectStopped(this.records.record(this.authority.runId)!, signal);
    if (settled.phase !== "owned")
      throw new Error("Repository acquisition did not establish ownership");
  }

  async assertOwned(signal?: AbortSignal) {
    const record = this.records.record(this.authority.runId);
    if (!record || record.phase !== "owned" || !record.ioStopped)
      throw new Error("Controller lacks settled repository ownership");
    this.assertIdentity(record);
    this.journal.assertAuthority(this.authority);
    const current = await this.git.inspectLock(this.repository, signal);
    if (current !== record.revision) {
      this.records.settle(
        this.authority,
        "conflict",
        "The run ownership ref was removed or replaced outside this run",
      );
      throw new Error("Repository ownership changed; stop admission and preserve all work");
    }
    await this.git.assertLockContent(
      this.repository,
      record.revision,
      record.objectContent,
      signal,
    );
    this.assertIdentity(record);
    this.journal.assertAuthority(this.authority);
  }

  async release(signal?: AbortSignal) {
    this.journal.assertAuthority(this.authority);
    if (this.journal.control(this.authority.runId).status !== "complete")
      throw new Error("Paused, failed or interrupted runs retain repository ownership");
    let record = this.records.record(this.authority.runId);
    if (!record || record.phase === "released") return;
    this.assertIdentity(record);
    if (!record.ioStopped) throw new Error("Repository release cannot infer old I/O stop");
    if (record.phase === "releasing") record = await this.inspectStopped(record, signal);
    if (record.phase === "released") return;
    if (record.phase !== "owned")
      throw new Error("Unsettled repository reservation cannot be released");
    await this.assertOwned(signal);
    const intent = this.records.begin(this.authority, "releasing");
    try {
      await this.git.releaseLock(
        this.repository,
        intent.revision,
        async () => {
          this.assertIdentity(intent);
          this.records.assertIO(this.authority, intent.ioId!, "releasing");
          if (this.journal.control(this.authority.runId).status !== "complete")
            throw new Error("Run completion changed before ownership release");
        },
        signal ?? new AbortController().signal,
      );
    } finally {
      this.records.stopped(this.authority, intent.ioId!);
    }
    record = await this.inspectStopped(this.records.record(this.authority.runId)!, signal);
    if (record.phase !== "released")
      throw new Error("Repository release remains incomplete; preserve its intent");
  }

  private async inspectStopped(record: AdmissionRecord, signal?: AbortSignal) {
    this.assertIdentity(record);
    if (!record.ioStopped)
      throw new Error("Do not inspect an unknown original I/O stop as settled");
    const current = await this.git.inspectLock(this.repository, signal);
    if (current === record.revision) {
      await this.git.assertLockContent(
        this.repository,
        record.revision,
        record.objectContent,
        signal,
      );
      return this.records.settle(this.authority, "owned", null);
    }
    if (current === null)
      return this.records.settle(
        this.authority,
        record.phase === "releasing" ? "released" : "reserved",
        null,
      );
    return this.records.settle(
      this.authority,
      "conflict",
      "A different repository reservation is retained; do not remove or adopt it",
    );
  }

  private assertIdentity(record: AdmissionRecord) {
    if (
      record.runId !== this.authority.runId ||
      digestJson(record.stateFile) !== digestJson(this.store.storageIdentity()) ||
      digestJson(record.repository) !== digestJson(this.repository)
    )
      throw new Error(
        "Repository reservation belongs to another state file or repository identity",
      );
  }
}
