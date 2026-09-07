import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { PublicationRecord, PublicationRepository } from "../domain/publication.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { PublicationGit, PublicationGitError } from "./publication-git.js";
import { WorkspaceError, type WorkspaceManager } from "./workspaces.js";
import { KernelGit } from "./kernel-git.js";
import { DeliveryError } from "./delivery-journal.js";

const lockContent = (record: PublicationRecord) =>
  `${JSON.stringify({ runId: record.runId, publicationId: record.publicationId, nonce: record.lockNonce })}\n`;
const detail = (error: unknown) =>
  error instanceof Error ? error.message : "Publication failed without an error detail";

/** Executes one journaled capability; every external write is preceded by its durable intent. */
export class PublicationAdapter {
  readonly git = new PublicationGit();
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
    publications.start(authority, publicationId);
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
      let workspace = this.journal.agents.workspaceForOperation(
        authority.runId,
        repository.creationOperationId,
      );
      if (!workspace)
        workspace = await this.workspaces.create(
          authority,
          run.repoPath,
          repository.baseRevision,
          "delivery",
          signal,
          repository.creationOperationId,
        );
      else if (
        workspace.workspaceId !== source.workspaceId &&
        (await this.workspaces.inspectMaterialization(authority, workspace, signal)) !== "ready"
      )
        throw new WorkspaceError(
          "publication_custody_incomplete",
          "Preserve and reconcile the reserved canonical delivery workspace",
        );
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
      // All invoked methods have settled their handles, including nested prepared Git guards.
      // A lease loss deliberately leaves every durable exclusion and ownership ref held.
      publications.stopIO(authority, publicationId, failure, intervention);
    }
  }

  /** Requires independently stopped old I/O; never calls publish/import/updateRefs again. */
  async reconcile(authority: ControllerAuthority, publicationId: string) {
    const publications = this.journal.publications;
    const initial = publications.record(authority.runId, publicationId);
    if (initial.outcome) return initial;
    if (!initial.dispatched) publications.cancelUndispatched(authority, publicationId);
    publications.beginInspection(authority, publicationId);
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
      publications.stopIO(authority, publicationId, failure, intervention);
    }
    if (failure) throw new Error(`Publication inspection remains unsettled: ${failure}`);
    return publications.finish(authority, publicationId, canonical, user);
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
