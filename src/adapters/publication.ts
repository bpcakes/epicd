import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { PublicationRecord, PublicationRepository } from "../domain/publication.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { PublicationGit, PublicationGitError } from "./publication-git.js";
import { WorkspaceError, type WorkspaceManager } from "./workspaces.js";
import { KernelGit } from "./kernel-git.js";
import { DeliveryError } from "./delivery-journal.js";
import { reconcilePublicationIO, runPublicationIO } from "./publication-io.js";

const lockContent = (record: PublicationRecord) =>
  `${JSON.stringify({ runId: record.runId, publicationId: record.publicationId, nonce: record.lockNonce })}\n`;
const detail = (error: unknown) =>
  error instanceof Error ? error.message : "Publication failed without an error detail";

/** Executes one journaled capability; every external write is preceded by its durable intent. */
export class PublicationAdapter {
  readonly git = new PublicationGit();
  private readonly active = new Set<string>();
  constructor(
    readonly journal: OrchestrationJournal,
    readonly workspaces: WorkspaceManager,
  ) {}

  async publish(
    authority: ControllerAuthority,
    publicationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const publications = this.journal.publications;
    const initial = publications.record(authority.runId, publicationId);
    if (
      this.active.has(publicationId) ||
      initial.dispatched ||
      initial.ioAttempts[0]!.execution ||
      initial.ioAttempts[0]!.settledAt
    )
      throw new DeliveryError(
        "publication_dispatched",
        "Publication dispatch is write-once; reconcile, never replay it",
      );
    this.active.add(publicationId);
    try {
      const repository = publications.repository(authority.runId)!;
      let workspace = this.journal.agents.workspaceForOperation(
        authority.runId,
        repository.creationOperationId,
      );
      if (workspace) {
        const creation = await this.workspaces.reconcileCreation(authority, workspace);
        if (!creation || creation.outcome !== "created")
          throw new WorkspaceError(
            "publication_custody_incomplete",
            "Canonical creation did not retain completion; preserve its files",
          );
      } else {
        workspace = await this.workspaces.create(
          authority,
          publications.run(authority.runId).repoPath,
          repository.baseRevision,
          "delivery",
          signal,
          repository.creationOperationId,
        );
      }
      const prepared = publications.attachCanonicalWorkspace(authority, publicationId, workspace);
      await runPublicationIO(
        this.journal,
        authority,
        publicationId,
        prepared.ioAttempts[0]!,
        signal,
      );
    } catch (error) {
      this.journal.assertAuthority(authority);
      publications.noteIOFailure(authority, publicationId, detail(error));
      await reconcilePublicationIO(
        this.journal,
        authority,
        publicationId,
        initial.ioAttempts[0]!.attemptId,
      );
    } finally {
      this.active.delete(publicationId);
    }
  }

  /** Recover original execution before a new bounded inspection; never rerun the writer. */
  async reconcile(authority: ControllerAuthority, publicationId: string, signal?: AbortSignal) {
    if (this.active.has(publicationId))
      throw new DeliveryError(
        "publication_io_live",
        "Independently prove the active publication operation stopped before reconciliation",
      );
    this.active.add(publicationId);
    try {
      const publications = this.journal.publications;
      let record = publications.record(authority.runId, publicationId);
      if (record.outcome) return record;
      const previous = record.ioAttempts.at(-1)!;
      if (!previous.settledAt) {
        record = await reconcilePublicationIO(
          this.journal,
          authority,
          publicationId,
          previous.attemptId,
        );
        if (record.outcome) return record;
        if (previous.phase === "inspect")
          throw new Error(
            "Original inspection stopped without complete retained observations; request a new inspection",
          );
      }
      const repository = publications.repository(authority.runId)!;
      const workspace = this.journal.agents.workspaceForOperation(
        authority.runId,
        repository.creationOperationId,
      );
      // Copy preparation has its own supervisor. A publication receipt cannot settle that child intent.
      if (workspace) await this.workspaces.reconcileCreation(authority, workspace);
      record = publications.beginInspection(authority, publicationId);
      const settled = await runPublicationIO(
        this.journal,
        authority,
        publicationId,
        record.ioAttempts.at(-1)!,
        signal,
      );
      if (!settled.outcome)
        throw new Error(
          `Publication inspection remains unsettled: ${settled.failure ?? "no retained observation"}`,
        );
      return settled;
    } finally {
      this.active.delete(publicationId);
    }
  }

  /** Trusted worker body: all source reads, object imports and ref writes share this lifetime. */
  async executePublication(
    authority: ControllerAuthority,
    publicationId: string,
    attemptId: string,
  ): Promise<void> {
    const publications = this.journal.publications;
    this.journal.publications.assertIOOwned(authority, publicationId, attemptId);
    publications.start(authority, publicationId);
    const signal = new AbortController().signal;
    let failure: string | null = null;
    let intervention = false;
    const guard = async (currentSignal: AbortSignal) => {
      currentSignal.throwIfAborted();
      publications.assertWritable(authority, publicationId);
      await this.assertLock(publications.record(authority.runId, publicationId), currentSignal);
    };
    try {
      const run = publications.run(authority.runId);
      const binding = await this.git.bind(run.repoPath, signal);
      publications.bindUser(authority, publicationId, binding);
      await this.acquireLock(authority, publicationId, signal);
      const source = await this.workspaces.inspectPublicationWorkspace(
        authority,
        publications.record(authority.runId, publicationId),
        signal,
      );
      const repository = publications.repository(authority.runId)!;
      if (!repository.workspace)
        throw new WorkspaceError(
          "publication_custody_incomplete",
          "Canonical custody was not reserved before worker launch",
        );
      const workspace = this.journal.agents.workspace(authority.runId, repository.workspace);
      const canonical = await this.git.bind(workspace.path, signal);
      publications.bindCanonical(authority, publicationId, workspace, canonical);
      await this.workspaces.inspectPublicationWorkspace(authority, workspace, signal);
      const record = publications.record(authority.runId, publicationId);
      if (repository.privateRevision !== record.revision && source.path !== canonical.root.path)
        await this.import(
          authority,
          publicationId,
          "canonical",
          await this.git.bind(source.path, signal),
          canonical,
          repository.privateRevision ?? repository.baseRevision,
          guard,
          signal,
        );
      await this.assertObject(canonical, record, signal);
      await this.git.updateRefs(record.canonicalRef!, guard, signal);
      await this.import(
        authority,
        publicationId,
        "user",
        canonical,
        binding,
        record.expectedPreviousRevision,
        guard,
        signal,
      );
      await this.workspaces.inspectPublicationWorkspace(authority, record, signal);
      await this.workspaces.inspectPublicationWorkspace(authority, workspace, signal);
      await this.git.updateRefs(record.publicRef!, guard, signal);
    } catch (error) {
      failure = detail(error);
      intervention = error instanceof PublicationGitError || error instanceof WorkspaceError;
    } finally {
      publications.recordIOResult(authority, publicationId, attemptId, {
        failure,
        intervention,
        canonical: null,
        user: null,
      });
    }
  }

  /** Requires independently stopped old I/O; never calls publish/import/updateRefs again. */
  async executeInspection(
    authority: ControllerAuthority,
    publicationId: string,
    attemptId: string,
  ) {
    const publications = this.journal.publications;
    const initial = publications.record(authority.runId, publicationId);
    publications.assertInspectionOwned(authority, initial);
    const signal = new AbortController().signal;
    let canonical: Awaited<ReturnType<PublicationGit["observeRefs"]>> | null = null;
    let user: Awaited<ReturnType<PublicationGit["observeRefs"]>> | null = null;
    let failure: string | null = null;
    let intervention = false;
    try {
      const record = publications.record(authority.runId, publicationId);
      if (record.canonicalRef) {
        canonical = await this.git.observeRefs(record.canonicalRef, signal);
        if (canonical.outcome === "applied")
          await this.assertObject(record.canonicalRef.repository, record, signal);
      }
      if (record.publicRef) {
        user = await this.git.observeRefs(record.publicRef, signal);
        if (user.outcome === "applied")
          await this.assertObject(record.publicRef.repository, record, signal);
      }
      if (record.lock && !record.lock.released)
        await this.releaseLock(authority, publicationId, signal);
      // Without a recorded ownership object, no publication write guard could have passed.
    } catch (error) {
      failure = detail(error);
      intervention =
        error instanceof PublicationGitError ||
        error instanceof WorkspaceError ||
        error instanceof DeliveryError;
    } finally {
      publications.recordIOResult(authority, publicationId, attemptId, {
        failure,
        intervention,
        canonical,
        user,
      });
    }
  }

  private async import(
    authority: ControllerAuthority,
    publicationId: string,
    destination: "canonical" | "user",
    source: PublicationRepository,
    target: PublicationRepository,
    base: string,
    guard: (signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ) {
    const publications = this.journal.publications;
    const record = publications.assertWritable(authority, publicationId);
    const pack = await this.git.pack(source, publicationId, record.revision, base, signal);
    let prior = publications
      .records(authority.runId)
      .filter(
        (item) => item.publicationId !== publicationId && item.ioStopped && item.outcome !== null,
      )
      .flatMap((item) => item.packs)
      .find(
        (item) =>
          item.destination === destination &&
          item.record.packHash === pack.record.packHash &&
          item.record.revision === pack.record.revision &&
          item.record.baseRevision === pack.record.baseRevision,
      );
    if (
      prior &&
      !(await exists(
        join(target.commonDirectory.path, `objects/pack/pack-${prior.record.packHash}.keep`),
      ))
    )
      prior = undefined;
    // A known stopped earlier attempt may already have imported the exact same pack.
    // Its retention identity stays with that operation; never overwrite its .keep.
    publications.recordPack(authority, publicationId, destination, prior?.record ?? pack.record);
    if (prior) await this.git.inspectImportedPack(target, prior.record, signal);
    else await this.git.importPack(target, pack.record, pack.bytes, guard, signal);
    await this.assertObject(target, record, signal);
    publications.markPackRetained(authority, publicationId, destination);
  }
  private async assertObject(
    repository: PublicationRepository,
    record: PublicationRecord,
    signal: AbortSignal,
  ) {
    const commit = this.journal.publications.objectRecord(record.runId, record);
    const git = new KernelGit(repository.root.path, repository.commonDirectory.path);
    if (
      (await git.text(["cat-file", "commit", record.revision], { signal })) !== commit.objectContent
    )
      throw new PublicationGitError(
        "publication_object_changed",
        "Published object differs from the independently verified commit intent",
      );
  }
  private async acquireLock(
    authority: ControllerAuthority,
    publicationId: string,
    signal: AbortSignal,
  ) {
    const publications = this.journal.publications;
    const record = publications.assertWritable(authority, publicationId);
    const repository = record.publicRef!.repository;
    const content = lockContent(record);
    const revision = await this.git.planLock(repository, content, signal);
    publications.recordLock(authority, publicationId, revision);
    await this.git.acquireLock(
      repository,
      revision,
      content,
      async (currentSignal) => {
        currentSignal.throwIfAborted();
        publications.assertWritable(authority, publicationId);
      },
      signal,
    );
    publications.markLockAcquired(authority, publicationId);
  }
  private async assertLock(record: PublicationRecord, signal: AbortSignal) {
    if (!record.lock || record.lock.released)
      throw new DeliveryError(
        "publication_lock_unowned",
        "Repository publication lock is not owned",
      );
    if ((await this.git.inspectLock(record.publicRef!.repository, signal)) !== record.lock.revision)
      throw new DeliveryError(
        "publication_lock_changed",
        "Repository publication lock owner changed",
      );
  }
  private async releaseLock(
    authority: ControllerAuthority,
    publicationId: string,
    signal: AbortSignal,
  ) {
    const publications = this.journal.publications;
    const record = publications.record(authority.runId, publicationId);
    const lock = record.lock!;
    publications.requestLockRelease(authority, publicationId);
    const disposition = await this.git.releaseLock(
      record.publicRef!.repository,
      lock.revision,
      async (currentSignal) => {
        currentSignal.throwIfAborted();
        this.journal.assertAuthority(authority);
        publications.assertInspectionOwned(
          authority,
          publications.record(authority.runId, publicationId),
        );
      },
      signal,
    );
    const unexpected =
      lock.acquired &&
      (disposition === "other_owner" || (disposition === "absent" && !lock.releaseRequested));
    publications.markLockReleased(authority, publicationId, disposition, unexpected);
  }
}
async function exists(path: string) {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}
