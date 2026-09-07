import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  PublicationPackSchema,
  PublicationRefIntentSchema,
  PublicationRepositorySchema,
  type PublicationPack,
  type PublicationRefIntent,
  type PublicationRefObservation,
  type PublicationRepository,
} from "../domain/publication.js";
import { KernelGit } from "./kernel-git.js";

const MAX_PACK = 64 * 1024 * 1024;
export const PUBLICATION_LOCK_REF = "refs/epicd/publication-lock";
type Guard = (signal: AbortSignal) => Promise<void>;
type Head = { ref: string; raw: string; target: string | null; revision: string | null };
export class PublicationGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicationGitError";
  }
}
const conflict = (message: string): never => {
  throw new PublicationGitError("publication_conflict", message);
};
const optionalSignal = (signal?: AbortSignal) => (signal ? { signal } : {});
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const gitFor = (repo: PublicationRepository) =>
  new KernelGit(repo.root.path, repo.commonDirectory.path);
export const publicationRefs = (input: PublicationRefIntent) => {
  const intent = PublicationRefIntentSchema.parse(input);
  return {
    branch: `refs/heads/epicd/${intent.runId}`,
    receipt: `refs/epicd/publications/${intent.publicationId}`,
  };
};
export const publicationKeepMessage = (pack: PublicationPack) =>
  `epicd-publication:${PublicationPackSchema.parse(pack).publicationId}`;

/**
 * Trusted plumbing, NOT a model capability or a durable publication controller.
 * The caller owns leases, exact verification, quiescence and write-once dispatch.
 * No method changes a checkout/index, rewrites a user's branch, retries an effect,
 * deletes an object/keep/delivery ref, or treats matching refs as evidence of stopped I/O.
 * Ownership-ref release requires an exact-object compare-and-swap and caller stop proof.
 */
export class PublicationGit {
  /** Read-only planning: persist the returned ownership blob identity before either write. */
  async planLock(repository: PublicationRepository, content: string, signal?: AbortSignal) {
    if (Buffer.byteLength(content) > 4096) conflict("Publication ownership record is too large");
    await this.assertBinding(repository, signal);
    return (
      await gitFor(repository).text(["hash-object", "--stdin"], {
        input: content,
        ...optionalSignal(signal),
      })
    ).trim();
  }
  async acquireLock(
    repository: PublicationRepository,
    revision: string,
    content: string,
    guard: Guard,
    signal: AbortSignal,
  ) {
    if ((await this.planLock(repository, content, signal)) !== revision)
      conflict("Publication lock object differs from its intent");
    await this.directRef(repository, PUBLICATION_LOCK_REF, signal);
    if ((await refValue(gitFor(repository), PUBLICATION_LOCK_REF, signal)) !== null)
      throw new PublicationGitError(
        "publication_lock_busy",
        "Another publication owns the repository lock ref",
      );
    await guard(signal);
    signal.throwIfAborted();
    const git = gitFor(repository);
    if (
      (await git.text(["hash-object", "-w", "--stdin"], { input: content, signal })).trim() !==
      revision
    )
      conflict("Publication ownership object changed");
    await git.text(["update-ref", "--stdin"], {
      input: `start\noption no-deref\ncreate ${PUBLICATION_LOCK_REF} ${revision}\nprepare\n`,
      signal,
      beforeRefCommit: async (lockedSignal) => {
        await this.assertBinding(repository, lockedSignal);
        await this.directRef(repository, PUBLICATION_LOCK_REF, lockedSignal);
        await guard(lockedSignal);
        lockedSignal.throwIfAborted();
      },
    });
  }
  async inspectLock(repository: PublicationRepository, signal?: AbortSignal) {
    await this.assertBinding(repository, signal);
    await this.directRef(repository, PUBLICATION_LOCK_REF, signal);
    return refValue(gitFor(repository), PUBLICATION_LOCK_REF, signal);
  }
  /** CAS release cannot delete a newer owner's ref, even if ownership changes after inspection. */
  async releaseLock(
    repository: PublicationRepository,
    revision: string,
    guard: Guard,
    signal: AbortSignal,
  ): Promise<"removed" | "absent" | "other_owner"> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) conflict("Invalid lock object identity");
    const current = await this.inspectLock(repository, signal);
    if (current === null) return "absent";
    if (current !== revision) return "other_owner";
    await guard(signal);
    signal.throwIfAborted();
    await gitFor(repository).text(["update-ref", "--stdin"], {
      input: `start\noption no-deref\ndelete ${PUBLICATION_LOCK_REF} ${revision}\nprepare\n`,
      signal,
      beforeRefCommit: async (lockedSignal) => {
        await this.assertBinding(repository, lockedSignal);
        await this.directRef(repository, PUBLICATION_LOCK_REF, lockedSignal);
        await guard(lockedSignal);
        lockedSignal.throwIfAborted();
      },
    });
    return "removed";
  }
  async bind(path: string, signal?: AbortSignal): Promise<PublicationRepository> {
    if (!isAbsolute(path) || (await realpath(path)) !== path)
      conflict("Selected repository must have a canonical absolute path");
    const root = await directoryIdentity(path);
    const entry = join(path, ".git");
    const entryStat = await lstat(entry);
    const git = new KernelGit(path);
    const top = (await git.text(["rev-parse", "--show-toplevel"], optionalSignal(signal))).trim();
    if (top !== path) conflict("Selected path is not the repository worktree root");
    const gitPath = (
      await git.text(["rev-parse", "--absolute-git-dir"], optionalSignal(signal))
    ).trim();
    const commonPath = resolve(
      path,
      (await git.text(["rev-parse", "--git-common-dir"], optionalSignal(signal))).trim(),
    );
    const gitDirectory = await directoryIdentity(gitPath);
    const commonDirectory = await directoryIdentity(commonPath);
    let gitEntryDigest: string | null = null;
    if (entryStat.isDirectory()) {
      if (gitPath !== entry || commonPath !== entry)
        conflict("Unexpected repository metadata layout");
    } else if (entryStat.isFile()) {
      const bytes = await regular(entry);
      const value = decode(bytes);
      if (
        !value.startsWith("gitdir: ") ||
        value.trimEnd().includes("\n") ||
        resolve(path, value.slice(8).trimEnd()) !== gitPath ||
        gitPath === commonPath ||
        relative(commonPath, gitPath).split("/").length !== 2 ||
        !relative(commonPath, gitPath).startsWith("worktrees/")
      )
        conflict("Only a standard linked-worktree .git file is supported");
      gitEntryDigest = hash(bytes);
    } else conflict("Repository metadata alias is not supported");
    const fixed = new KernelGit(path, commonPath);
    if (
      (await fixed.text(["rev-parse", "--is-bare-repository"], optionalSignal(signal))).trim() !==
      "false"
    )
      conflict("Publication requires a non-bare selected repository");
    const objectFormat = (
      await fixed.text(["rev-parse", "--show-object-format"], optionalSignal(signal))
    ).trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256")
      conflict("Unsupported Git object format");
    const backend = (
      await fixed.text(["config", "--local", "--get", "extensions.refStorage"], {
        allowedExitCodes: [0, 1],
        ...optionalSignal(signal),
      })
    ).trim();
    if (backend && backend !== "files")
      conflict("Publication currently requires Git's files ref backend");
    const configDigest = hash(await regular(join(commonPath, "config")));
    const binding = PublicationRepositorySchema.parse({
      schemaVersion: 1,
      root,
      gitDirectory,
      commonDirectory,
      gitEntryDigest,
      configDigest,
      objectFormat,
    });
    await this.storage(binding);
    return binding;
  }

  async assertBinding(input: PublicationRepository, signal?: AbortSignal): Promise<void> {
    const repo = PublicationRepositorySchema.parse(input);
    if (JSON.stringify(await this.bind(repo.root.path, signal)) !== JSON.stringify(repo))
      conflict("Repository identity or configuration changed; preserve the old publication intent");
  }

  /** Export identical objects, with no thin/external deltas. Does not write either repository. */
  async pack(
    source: PublicationRepository,
    publicationId: string,
    revision: string,
    baseRevision: string,
    signal?: AbortSignal,
  ): Promise<{ record: PublicationPack; bytes: Buffer }> {
    // Validate object IDs before they can enter a revision or stdin expression.
    PublicationPackSchema.parse({
      schemaVersion: 1,
      publicationId,
      revision,
      baseRevision,
      packHash: revision,
      objectFormat: source.objectFormat,
      size: 32,
    });
    await this.assertBinding(source, signal);
    const git = gitFor(source);
    await assertCommit(git, revision, signal);
    await assertCommit(git, baseRevision, signal);
    await git.text(["merge-base", "--is-ancestor", baseRevision, revision], optionalSignal(signal));
    const bytes = await git.bytes(
      [
        "pack-objects",
        "--stdout",
        "--revs",
        "--no-reuse-delta",
        "--no-reuse-object",
        "--window=0",
        "--threads=1",
      ],
      { input: `${revision}\n^${baseRevision}\n`, ...optionalSignal(signal) },
    );
    const digestLength = source.objectFormat === "sha1" ? 20 : 32;
    const record = PublicationPackSchema.parse({
      schemaVersion: 1,
      publicationId,
      objectFormat: source.objectFormat,
      revision,
      baseRevision,
      size: bytes.length,
      packHash: bytes.subarray(-digestLength).toString("hex"),
    });
    assertPack(record, bytes);
    await this.assertBinding(source, signal);
    return { record, bytes };
  }

  /**
   * Caller persists pack metadata and ownership before dispatch. The .keep remains
   * until explicit, journaled cleanup; never infer import failure from a lost result.
   */
  async importPack(
    destination: PublicationRepository,
    record: PublicationPack,
    bytes: Buffer,
    assertWritable: Guard,
    signal: AbortSignal,
  ): Promise<void> {
    record = PublicationPackSchema.parse(record);
    assertPack(record, bytes);
    if (record.objectFormat !== destination.objectFormat) conflict("Object formats differ");
    await this.assertBinding(destination, signal);
    const git = gitFor(destination);
    await assertCommit(git, record.baseRevision, signal);
    const prefix = `objects/pack/pack-${record.packHash}`;
    for (const extension of ["pack", "idx", "rev", "keep"])
      await safeEntry(destination.commonDirectory.path, `${prefix}.${extension}`);
    if (await exists(join(destination.commonDirectory.path, `${prefix}.keep`)))
      conflict(
        "Pack already has a retention owner; reconcile the recorded import, do not repeat it",
      );
    await assertWritable(signal);
    signal.throwIfAborted();
    await git.text(
      [
        "index-pack",
        "--stdin",
        "--strict",
        "--no-rev-index",
        "--threads=1",
        `--max-input-size=${MAX_PACK}`,
        `--keep=${publicationKeepMessage(record)}`,
      ],
      { input: bytes, signal },
    );
    await this.assertBinding(destination, signal);
    if (
      decode(await regular(join(destination.commonDirectory.path, `${prefix}.keep`))) !==
      `${publicationKeepMessage(record)}\n`
    )
      conflict("Pack retention ownership is not the recorded operation");
    await assertCommit(git, record.revision, signal);
  }

  /** CAS only a run-owned branch plus a unique operation receipt. Objects must already exist. */
  async inspectImportedPack(
    destination: PublicationRepository,
    input: PublicationPack,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = PublicationPackSchema.parse(input);
    await this.assertBinding(destination, signal);
    if (record.objectFormat !== destination.objectFormat) conflict("Object formats differ");
    const prefix = `objects/pack/pack-${record.packHash}`;
    for (const extension of ["pack", "idx", "keep"])
      await safeEntry(destination.commonDirectory.path, `${prefix}.${extension}`);
    if (
      decode(await regular(join(destination.commonDirectory.path, `${prefix}.keep`))) !==
      `${publicationKeepMessage(record)}\n`
    )
      conflict("Retained pack belongs to a different operation");
    const git = gitFor(destination);
    await git.text(
      ["verify-pack", join(destination.commonDirectory.path, `${prefix}.idx`)],
      optionalSignal(signal),
    );
    await assertCommit(git, record.revision, signal);
  }

  /** CAS only a run-owned branch plus a unique operation receipt. Objects must already exist. */
  async updateRefs(
    input: PublicationRefIntent,
    assertWritable: Guard,
    signal: AbortSignal,
  ): Promise<void> {
    const intent = PublicationRefIntentSchema.parse(input);
    const refs = publicationRefs(intent);
    await this.assertBinding(intent.repository, signal);
    const git = gitFor(intent.repository);
    await assertCommit(git, intent.revision, signal);
    if (intent.expectedRef) {
      await assertCommit(git, intent.expectedRef, signal);
      await git.text(["merge-base", "--is-ancestor", intent.expectedRef, intent.revision], {
        signal,
      });
    }
    await this.refSafety(intent, signal);
    if (
      (await refValue(git, refs.branch, signal)) !== intent.expectedRef ||
      (await refValue(git, refs.receipt, signal)) !== null
    )
      conflict("Run branch or publication receipt does not match the write-once intent");
    const heads = await this.heads(intent.repository, refs.branch, signal);
    const zero = "0".repeat(intent.revision.length);
    const inputText = [
      "start",
      "option no-deref",
      intent.expectedRef
        ? `update ${refs.branch} ${intent.revision} ${intent.expectedRef}`
        : `create ${refs.branch} ${intent.revision}`,
      "option no-deref",
      `create ${refs.receipt} ${intent.revision}`,
      // Verify the HEAD itself without dereferencing: verifying its branch instead
      // also synthesizes a HEAD reflog write in Git 2.43's files backend.
      ...heads
        .filter(({ ref }) => ref === "HEAD")
        .flatMap(({ ref, revision }) => ["option no-deref", `verify ${ref} ${revision ?? zero}`]),
      "prepare",
      "",
    ].join("\n");
    await assertWritable(signal);
    signal.throwIfAborted();
    const publish = async (lockedSignal: AbortSignal) =>
      git.text(["update-ref", "--stdin"], {
        input: inputText,
        signal: lockedSignal,
        beforeRefCommit: async (guardSignal) => {
          await this.assertBinding(intent.repository, guardSignal);
          await this.refSafety(intent, guardSignal);
          for (const head of heads) {
            const lock = join(intent.repository.commonDirectory.path, `${head.ref}.lock`);
            if (!(await exists(lock))) conflict("Expected worktree HEAD lock is missing");
            await regular(lock);
          }
          if (
            JSON.stringify(await this.heads(intent.repository, refs.branch, guardSignal)) !==
            JSON.stringify(heads)
          )
            conflict("Worktree HEADs or topology changed during publication");
          await assertWritable(guardSignal);
          guardSignal.throwIfAborted();
        },
      });
    // Git 2.43 reads worktrees/<id>/HEAD but rejects it in update-ref. A prepared
    // no-deref HEAD verification in each actual gitdir supplies a read-only lock.
    // Keep every nested process alive until publication finishes; await all closes.
    const linked = heads.filter(({ ref }) => ref !== "HEAD");
    const withHeadLocks = async (index: number, parentSignal: AbortSignal): Promise<void> => {
      const head = linked[index];
      if (!head) {
        await publish(parentSignal);
        return;
      }
      const directory = join(intent.repository.commonDirectory.path, head.ref.slice(0, -5));
      await new KernelGit(intent.repository.root.path, directory).text(["update-ref", "--stdin"], {
        input: `start\noption no-deref\nverify HEAD ${head.revision ?? zero}\nprepare\n`,
        signal: parentSignal,
        beforeRefCommit: (lockedSignal) => withHeadLocks(index + 1, lockedSignal),
      });
    };
    await withHeadLocks(0, signal);
    // Git locks known HEADs, not the future set of all linked worktrees. Do not hide a race.
    await this.assertBinding(intent.repository, signal);
    if (
      JSON.stringify(await this.heads(intent.repository, refs.branch, signal)) !==
      JSON.stringify(heads)
    )
      conflict("Worktree topology changed while refs were committed; inspect the retained outcome");
  }

  /** Read-only observation. Unknown old I/O MUST remain excluded even for not_applied. */
  async observeRefs(
    input: PublicationRefIntent,
    signal?: AbortSignal,
  ): Promise<PublicationRefObservation> {
    const intent = PublicationRefIntentSchema.parse(input);
    await this.assertBinding(intent.repository, signal);
    await this.refSafety(intent, signal);
    const refs = publicationRefs(intent);
    const git = gitFor(intent.repository);
    const branchRevision = await refValue(git, refs.branch, signal);
    const receiptRevision = await refValue(git, refs.receipt, signal);
    const outcome =
      branchRevision === intent.revision && receiptRevision === intent.revision
        ? "applied"
        : branchRevision === intent.expectedRef && receiptRevision === null
          ? "not_applied"
          : "conflict";
    await this.assertBinding(intent.repository, signal);
    return {
      outcome,
      branchRevision,
      receiptRevision,
      detail:
        outcome === "applied"
          ? "Both named refs match the intent; this alone is not stopped-I/O or current-verification evidence"
          : outcome === "not_applied"
            ? "Neither expected ref changed; this does not prove old I/O stopped"
            : "Partial or conflicting ref state; preserve it, never replay or roll back by inference",
    };
  }

  private async storage(repo: PublicationRepository): Promise<void> {
    for (const path of [
      "objects",
      "objects/pack",
      "objects/info",
      "refs",
      "logs",
      "packed-refs",
      "worktrees",
    ])
      await safeEntry(repo.commonDirectory.path, path);
    for (const path of [
      "objects/info/alternates",
      "objects/info/http-alternates",
      "info/grafts",
      "shallow",
    ])
      if (await exists(join(repo.commonDirectory.path, path)))
        conflict(`Unsupported publication object storage: ${path}`);
  }

  private async refSafety(intent: PublicationRefIntent, signal?: AbortSignal): Promise<void> {
    for (const ref of Object.values(publicationRefs(intent)))
      await this.directRef(intent.repository, ref, signal);
  }
  private async directRef(
    repository: PublicationRepository,
    ref: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const git = gitFor(repository);
    await git.text(["check-ref-format", ref], optionalSignal(signal));
    await safeEntry(repository.commonDirectory.path, ref);
    await safeEntry(repository.commonDirectory.path, `logs/${ref}`);
    const symref = (
      await git.text(["symbolic-ref", "--quiet", "--no-recurse", ref], {
        allowedExitCodes: [0, 1],
        ...optionalSignal(signal),
      })
    ).trim();
    if (symref) conflict("Publication cannot replace or follow a symbolic branch or receipt");
  }

  private async heads(
    repo: PublicationRepository,
    branch: string,
    signal?: AbortSignal,
  ): Promise<Head[]> {
    const common = repo.commonDirectory.path;
    const entries = await readdir(join(common, "worktrees")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    if (entries.length > 64)
      conflict("Repository exceeds the 64-linked-worktree publication bound");
    const refs = [
      "HEAD",
      ...entries.sort().map((name) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "..")
          conflict("Unsupported worktree metadata name");
        return `worktrees/${name}/HEAD`;
      }),
    ];
    const git = gitFor(repo);
    const heads: Head[] = [];
    for (const ref of refs) {
      await safeEntry(common, ref);
      if (ref !== "HEAD") {
        const directory = join(common, ref.slice(0, -5));
        await directoryIdentity(directory);
        const commonLink = decode(await regular(join(directory, "commondir")));
        if (
          commonLink.trimEnd().includes("\n") ||
          resolve(directory, commonLink.trimEnd()) !== common
        )
          conflict("Linked-worktree common metadata binding changed");
      }
      const raw = decode(await regular(join(common, ref)));
      if (raw === `ref: ${branch}\n`)
        conflict("Run branch is checked out; publication never changes an active checkout");
      if (!/^(?:ref: refs\/[^\s]+|[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(raw))
        conflict("Worktree HEAD is malformed or unsupported");
      const target = raw.startsWith("ref: ") ? raw.slice(5, -1) : null;
      if (target) {
        await git.text(["check-ref-format", target], optionalSignal(signal));
        await safeEntry(common, target);
        const resolved = (
          await git.text(["symbolic-ref", "--quiet", ref], optionalSignal(signal))
        ).trim();
        if (resolved !== target) conflict("Indirect worktree HEAD aliases are not supported");
      }
      heads.push({ ref, raw, target, revision: await refValue(git, ref, signal) });
    }
    return heads;
  }
}

async function directoryIdentity(path: string) {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    conflict("Repository directory is aliased");
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) conflict("Repository path is not a directory");
  return { path, device: stat.dev.toString(), inode: stat.ino.toString() };
}
async function exists(path: string) {
  return await lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}
async function safeEntry(root: string, path: string): Promise<void> {
  const parts = path.split("/");
  let parent = root;
  for (let i = 0; i < parts.length; i++) {
    parent = join(parent, parts[i]!);
    const stat = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1
        ? !stat.isDirectory()
        : !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
    )
      conflict("Publication metadata has an alias, shared file or special path");
  }
}
async function regular(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024)
      conflict("Publication metadata must be an unshared bounded regular file");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1
    )
      conflict("Publication metadata changed during observation");
    return bytes;
  } finally {
    await handle.close();
  }
}
function decode(bytes: Buffer) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function refValue(git: KernelGit, ref: string, signal?: AbortSignal): Promise<string | null> {
  const value = (
    await git.text(["rev-parse", "--verify", "--quiet", ref], {
      allowedExitCodes: [0, 1],
      ...optionalSignal(signal),
    })
  ).trim();
  if (value && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) conflict("Invalid ref object ID");
  return value || null;
}
async function assertCommit(git: KernelGit, revision: string, signal?: AbortSignal) {
  if ((await git.text(["cat-file", "-t", revision], optionalSignal(signal))).trim() !== "commit")
    conflict("Publication target/base must be exact commit objects, never tags or trees");
}
function assertPack(record: PublicationPack, bytes: Buffer) {
  const length = record.objectFormat === "sha1" ? 20 : 32;
  if (
    bytes.length !== record.size ||
    bytes.length < 12 + length ||
    bytes.length > MAX_PACK ||
    bytes.subarray(0, 4).toString("ascii") !== "PACK" ||
    bytes.subarray(-length).toString("hex") !== record.packHash ||
    createHash(record.objectFormat).update(bytes.subarray(0, -length)).digest("hex") !==
      record.packHash
  )
    conflict("Pack bytes differ from their frozen import identity");
}
