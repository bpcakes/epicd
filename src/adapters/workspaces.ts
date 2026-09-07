import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { AgentCoordinationError } from "./agent-journal.js";
import { KernelGit } from "./kernel-git.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { WorkspaceIdentity, WorkspaceRecord } from "../domain/agents.js";
import {
  ManifestEntrySchema,
  WorkspaceSnapshotSchema,
  type ManifestEntry,
  type WorkspaceOperation,
  type WorkspaceSnapshot,
} from "../domain/workspaces.js";
import { digestJson } from "../domain/repository-policy.js";
import type { CommitRecord } from "../domain/commits.js";

const FILE_LIMIT = 64 * 1024 * 1024;
const CHECKOUT_LIMIT = 512 * 1024 * 1024;
type TreeEntry = Pick<ManifestEntry, "path" | "mode" | "objectId">;
type CapturedFile = { entry: ManifestEntry; bytes: Buffer };
type ObjectFormat = "sha1" | "sha256";
const privateConfig = (format: ObjectFormat) =>
  `[core]\n\trepositoryformatversion = ${format === "sha256" ? 1 : 0}\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n\thooksPath = /dev/null\n\tfsmonitor = false\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n${format === "sha256" ? "[extensions]\n\tobjectFormat = sha256\n" : ""}`;

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Physical workspace operations. Durable reservations and active-turn ownership live in the journal. */
export class WorkspaceManager {
  constructor(
    private readonly journal: OrchestrationJournal,
    private readonly root: string,
  ) {
    if (!isAbsolute(root)) throw new Error("Managed workspace storage must be absolute");
  }

  /** Reads only the selected repository's committed baseline; never its index or dirty files. */
  async create(
    authority: ControllerAuthority,
    sourcePath: string,
    revision: string,
    purpose: WorkspaceRecord["purpose"],
    signal?: AbortSignal,
    creationOperationId?: string,
  ): Promise<WorkspaceRecord> {
    this.journal.assertAuthority(authority);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(this.root);
    const source = new KernelGit(await realpath(sourcePath));
    const format = await this.preflight(source, revision, signal);
    const control = this.journal.control(authority.runId);
    const workspace = this.journal.agents.reserveWorkspace(
      authority,
      {
        root: canonicalRoot,
        purpose,
        sourceMode: ["coordinator", "review", "verification", "delivery"].includes(purpose)
          ? "immutable"
          : "mutable",
        baselineRevision: revision,
        ...(creationOperationId ? { creationOperationId } : {}),
      },
      control.controlVersion,
    );
    await this.exclusive(authority, workspace, "materialize", () =>
      this.materialize(authority, workspace, source, format, signal),
    );
    return this.journal.agents.workspace(authority.runId, workspace);
  }

  /** An interrupted reservation remains preserved. Only a complete, matching copy may be adopted. */
  async inspectMaterialization(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    signal?: AbortSignal,
  ): Promise<"ready" | "incomplete"> {
    this.journal.assertAuthority(authority);
    const workspace = this.journal.agents.workspace(authority.runId, identity);
    if (workspace.status !== "reserved" && workspace.status !== "ready") return "incomplete";
    return this.exclusive(authority, workspace, "inspect_materialization", async () => {
      try {
        await this.owned(authority, identity, true);
        const git = new KernelGit(workspace.path);
        await this.assertPrivateGit(git, signal);
        if (
          (await git.text(["rev-parse", "HEAD"], optionalSignal(signal))).trim() !==
          workspace.baselineRevision
        )
          return "incomplete";
        const entries = await this.treeEntries(git, workspace.baselineRevision, signal);
        await assertExpectedNamespace(workspace.path, new Set(entries.map((entry) => entry.path)));
        const manifest = await this.readExpectedFiles(workspace.path, entries);
        const actual = await this.scan(git, workspace.baselineRevision, signal);
        if (digestJson(manifest) !== digestJson(actual.map((file) => file.entry)))
          return "incomplete";
        this.journal.assertAuthority(authority);
        if (workspace.status === "reserved")
          this.journal.agents.markWorkspaceReady(authority, workspace, digestJson(manifest));
        return "ready";
      } catch (error) {
        if (signal?.aborted) throw error;
        this.journal.assertAuthority(authority);
        return "incomplete";
      }
    });
  }

  async capture(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSnapshot> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(snapshotId))
      throw new WorkspaceError("invalid_snapshot_id", "Snapshot ID must be kernel-generated");
    return this.exclusive(authority, identity, "capture", () =>
      this.captureStopped(authority, identity, snapshotId, signal),
    );
  }

  private async captureStopped(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSnapshot> {
    const workspace = await this.owned(authority, identity);
    this.assertStopped(workspace);
    const git = new KernelGit(workspace.path);
    await this.assertPrivateGit(git, signal);
    const head = (await git.text(["rev-parse", "HEAD"], optionalSignal(signal))).trim();
    if (head !== workspace.baselineRevision)
      throw new WorkspaceError("head_changed", "The managed baseline changed outside the kernel");
    const files = await this.scan(git, head, signal);
    await this.assertProtectedTracker(git, head, files, signal);
    const manifest = files.map((file) => file.entry);
    for (const file of files) {
      this.assertStopped(await this.owned(authority, identity));
      const object = (
        await git.text(["hash-object", "-w", "--no-filters", "--stdin"], {
          input: file.bytes,
          ...optionalSignal(signal),
        })
      ).trim();
      if (object !== file.entry.objectId)
        throw new WorkspaceError("object_mismatch", "Git did not store the captured bytes exactly");
    }
    const fullTree = await this.writeTree(git, manifest, signal);
    const applicationTree = await this.writeTree(
      git,
      manifest.filter((entry) => !trackerPath(entry.path)),
      signal,
    );
    this.assertStopped(await this.owned(authority, identity));
    const after = (await this.scan(git, head, signal)).map((file) => file.entry);
    if (digestJson(after) !== digestJson(manifest))
      throw new WorkspaceError(
        "workspace_changed",
        "Workspace changed during candidate capture; preserve it and investigate",
      );
    // Synthetic review snapshot, never an application delivery commit or exact-commit verification.
    const commit = `tree ${fullTree}\nparent ${head}\nauthor Epicd Snapshot <snapshot@epicd.local> 0 +0000\ncommitter Epicd Snapshot <snapshot@epicd.local> 0 +0000\n\nEpicd candidate snapshot ${snapshotId}\n`;
    const snapshotRevision = (
      await git.text(["hash-object", "-w", "-t", "commit", "--stdin"], {
        input: commit,
        ...optionalSignal(signal),
      })
    ).trim();
    this.assertStopped(await this.owned(authority, identity));
    const ref = `refs/epicd/candidates/${snapshotId}`;
    const existing = (
      await git.text(["rev-parse", "--verify", "--quiet", ref], {
        allowedExitCodes: [0, 1],
        ...optionalSignal(signal),
      })
    ).trim();
    if (existing && existing !== snapshotRevision)
      throw new WorkspaceError(
        "snapshot_conflict",
        "Snapshot identity already refers to different bytes",
      );
    if (!existing)
      await git.text(["update-ref", ref, snapshotRevision, ""], optionalSignal(signal));
    return WorkspaceSnapshotSchema.parse({
      schemaVersion: 1,
      runId: authority.runId,
      workspaceId: workspace.workspaceId,
      workspaceGeneration: workspace.workspaceGeneration,
      parentRevision: head,
      fullTree,
      applicationTree,
      snapshotRevision,
      fingerprint: digestJson(manifest),
      manifest,
    });
  }

  async createReviewCopy(
    authority: ControllerAuthority,
    snapshotInput: WorkspaceSnapshot,
    signal?: AbortSignal,
    creationOperationId?: string,
    purpose: "review" | "verification" = "review",
  ): Promise<WorkspaceRecord> {
    const snapshot = WorkspaceSnapshotSchema.parse(snapshotInput);
    if (snapshot.runId !== authority.runId)
      throw new WorkspaceError("wrong_run", "Candidate belongs to another run");
    return this.exclusive(authority, snapshot, "copy_source", async () => {
      const source = await this.owned(authority, snapshot);
      const copy = await this.create(
        authority,
        source.path,
        snapshot.snapshotRevision,
        purpose,
        signal,
        creationOperationId,
      );
      const git = new KernelGit(copy.path);
      const tree = (await git.text(["rev-parse", "HEAD^{tree}"], optionalSignal(signal))).trim();
      if (tree !== snapshot.fullTree || copy.baselineFingerprint !== snapshot.fingerprint)
        throw new WorkspaceError(
          "candidate_copy_mismatch",
          "Review copy does not match the captured candidate",
        );
      return copy;
    });
  }

  /** New writable files at the retained private tip; never reset or amend an older assignment. */
  async createImplementationCopy(
    authority: ControllerAuthority,
    commit: CommitRecord,
    creationOperationId: string,
    signal?: AbortSignal,
    sourceIdentity: WorkspaceIdentity = commit,
  ) {
    return this.exclusive(authority, sourceIdentity, "copy_source", async () => {
      const source = await this.owned(authority, sourceIdentity);
      const git = new KernelGit(source.path);
      await this.assertPrivateGit(git, signal);
      if (
        !commit.revision ||
        (await git.text(["cat-file", "commit", commit.revision], optionalSignal(signal))) !==
          commit.objectContent
      )
        throw new WorkspaceError(
          "commit_object_conflict",
          "Implementation base differs from its retained commit intent",
        );
      return this.create(
        authority,
        source.path,
        commit.revision,
        "implementation",
        signal,
        creationOperationId,
      );
    });
  }

  /** Publication owns an existing exclusion; never create a nested operation or trust a model path. */
  async inspectPublicationWorkspace(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    signal?: AbortSignal,
  ) {
    const workspace = await this.owned(authority, identity);
    this.assertStopped(workspace);
    const operation = this.journal.agents.activeWorkspaceOperation(authority.runId, identity);
    const publication = this.journal.publications.pending(authority.runId);
    if (
      !publication ||
      !operation ||
      !publication.workspaceOperations.includes(operation.operationId) ||
      operation.controllerLeaseId !== authority.leaseId
    )
      throw new WorkspaceError(
        "publication_workspace_unowned",
        "Publication workspace inspection needs its owned exclusion",
      );
    const git = new KernelGit(workspace.path);
    await this.assertPrivateGit(git, signal);
    if (
      (await git.text(["rev-parse", "HEAD"], optionalSignal(signal))).trim() !==
      workspace.baselineRevision
    )
      throw new WorkspaceError("publication_workspace_changed", "Publication source HEAD changed");
    const files = await this.scan(git, workspace.baselineRevision, signal);
    const expected =
      workspace.purpose === "delivery"
        ? workspace.baselineFingerprint
        : this.journal.commits.record(authority.runId, publication.commitId).fingerprint;
    if (digestJson(files.map((file) => file.entry)) !== expected)
      throw new WorkspaceError("publication_workspace_changed", "Publication source bytes changed");
    if (workspace.purpose !== "delivery") {
      const commit = this.journal.commits.record(authority.runId, publication.commitId);
      if (
        (await git.text(["cat-file", "commit", commit.revision!], optionalSignal(signal))) !==
        commit.objectContent
      )
        throw new WorkspaceError(
          "publication_object_changed",
          "Publication object differs from its verified commit intent",
        );
    }
    return workspace;
  }

  /** Construct only the approved object and a private retention ref; never advance a checkout or public branch. */
  async writeCandidateCommit(
    authority: ControllerAuthority,
    input: CommitRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = this.journal.commits.assertWritable(authority, input.commitId);
    let succeeded = false;
    try {
      const workspace = await this.owned(authority, record);
      this.assertStopped(workspace);
      const git = new KernelGit(workspace.path);
      await this.assertPrivateGit(git, signal);
      const snapshot = this.journal.delivery.candidate(authority.runId, record).snapshot!;
      if (
        (await git.text(["rev-parse", "HEAD"], optionalSignal(signal))).trim() !==
        record.parentRevision
      )
        throw new WorkspaceError(
          "commit_parent_changed",
          "Commit source no longer has the approved parent",
        );
      const files = await this.scan(git, record.parentRevision, signal);
      if (digestJson(files.map((file) => file.entry)) !== record.fingerprint)
        throw new WorkspaceError(
          "commit_source_changed",
          "Commit source differs from the independent approval",
        );
      await this.assertProtectedTracker(git, record.parentRevision, files, signal);
      // A separate, kernel-built index ignores arbitrary existing staging.
      const tree = await this.writeTree(git, snapshot.manifest, signal);
      if (tree !== record.fullTree)
        throw new WorkspaceError(
          "commit_tree_changed",
          "Temporary index differs from the approved tree",
        );
      const revision = (
        await git.text(["hash-object", "-t", "commit", "--stdin"], {
          input: record.objectContent,
          ...optionalSignal(signal),
        })
      ).trim();
      this.journal.commits.prepareWrite(authority, record.commitId, revision);
      this.journal.commits.assertWritable(authority, record.commitId);
      const written = (
        await git.text(["hash-object", "-w", "-t", "commit", "--stdin"], {
          input: record.objectContent,
          ...optionalSignal(signal),
        })
      ).trim();
      if (written !== revision)
        throw new WorkspaceError(
          "commit_object_changed",
          "Stored commit differs from its persisted write intent",
        );
      this.journal.commits.assertWritable(authority, record.commitId);
      await git.text(
        ["update-ref", `refs/epicd/commits/${record.commitId}`, revision, ""],
        optionalSignal(signal),
      );
      succeeded = true;
    } finally {
      this.journal.agents.finishWorkspaceOperation(
        authority,
        record.workspaceOperationId,
        succeeded ? "succeeded" : "failed",
        "Trusted commit adapter awaited every Git process and filesystem operation",
      );
    }
  }

  /** Read-only reconciliation after independently confirmed I/O stop, including the object/ref crash window. */
  async inspectCandidateCommit(
    authority: ControllerAuthority,
    input: CommitRecord,
    signal?: AbortSignal,
  ): Promise<{ created: boolean; sourceIntact: boolean; detail: string | null }> {
    const record = this.journal.commits.record(authority.runId, input.commitId);
    if (
      !this.journal.agents.workspaceOperation(authority.runId, record.workspaceOperationId)
        .stopEvidence
    )
      throw new WorkspaceError(
        "commit_io_unsettled",
        "An old commit exclusion cannot be cleared from Git state alone",
      );
    return this.exclusive(authority, record, "inspect_materialization", async () => {
      const workspace = await this.owned(authority, record);
      this.assertStopped(workspace);
      const git = new KernelGit(workspace.path);
      await this.assertPrivateGit(git, signal);
      if (!record.revision)
        return {
          created: false,
          sourceIntact: false,
          detail: "No commit-object write was admitted",
        };
      const retained = (
        await git.text(
          ["rev-parse", "--verify", "--quiet", `refs/epicd/commits/${record.commitId}`],
          { allowedExitCodes: [0, 1], ...optionalSignal(signal) },
        )
      ).trim();
      if (retained && retained !== record.revision)
        throw new WorkspaceError(
          "commit_ref_conflict",
          "Private commit ref changed outside its intent",
        );
      const object = (
        await git.text(["cat-file", "--batch-check"], {
          input: `${record.revision}\n`,
          ...optionalSignal(signal),
        })
      ).trim();
      if (object === `${record.revision} missing` && !retained)
        return {
          created: false,
          sourceIntact: false,
          detail: "Commit object and retention ref are absent after confirmed stop",
        };
      if (
        object !== `${record.revision} commit ${Buffer.byteLength(record.objectContent)}` ||
        (await git.text(["cat-file", "commit", record.revision], optionalSignal(signal))) !==
          record.objectContent
      )
        throw new WorkspaceError(
          "commit_object_conflict",
          "Private commit object differs from its reserved content",
        );
      if (!retained)
        return {
          created: false,
          sourceIntact: false,
          detail:
            "Commit object exists but its retention ref was not installed; preserve the private object and recapture before retry",
        };
      const sourceIntact =
        (await git.text(["rev-parse", "HEAD"], optionalSignal(signal))).trim() ===
          record.parentRevision &&
        digestJson(
          (await this.scan(git, record.parentRevision, signal)).map((file) => file.entry),
        ) === record.fingerprint;
      return {
        created: true,
        sourceIntact,
        detail: sourceIntact
          ? null
          : "Private commit exists, but its source changed after approval; recapture and review",
      };
    });
  }

  async read(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    path: string,
    offset: number,
    limit: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const workspace = await this.owned(authority, identity);
    const file = safeRelative(path);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      throw new WorkspaceError("invalid_range", "Invalid bounded inspection range");
    await safeParents(workspace.path, file);
    const data = await regularBytes(join(workspace.path, file));
    this.journal.assertAuthority(authority);
    const bytes = data.subarray(offset, offset + limit);
    return { text: bytes.toString("utf8"), truncated: offset + limit < data.length };
  }

  /** Read-only observations may coexist with a writer; they confer no source/evidence approval. */
  async inspectionSource(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
  ): Promise<WorkspaceRecord> {
    return this.owned(authority, identity);
  }

  async inspectionTree(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<TreeEntry[]> {
    return this.inspectionGit(authority, identity, signal, (git, workspace) =>
      this.treeEntries(git, workspace.baselineRevision, signal),
    );
  }

  async inspectionBaseline(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    path: string,
    signal: AbortSignal,
  ): Promise<{ entry: TreeEntry; bytes: Buffer } | null> {
    const file = safeRelative(path);
    return this.inspectionGit(authority, identity, signal, async (git, workspace) => {
      const entry = (await this.treeEntries(git, workspace.baselineRevision, signal)).find(
        (entry) => entry.path === file,
      );
      if (!entry) return null;
      const size = Number((await git.text(["cat-file", "-s", entry.objectId], { signal })).trim());
      if (!Number.isSafeInteger(size) || size > 4 * 1024 * 1024)
        throw new WorkspaceError(
          "inspection_file_limit",
          "Baseline file exceeds the 4 MiB inspection limit",
        );
      const bytes = await git.bytes(["cat-file", "blob", entry.objectId], { signal });
      if (bytes.length !== size)
        throw new WorkspaceError(
          "inspection_blob_changed",
          "Baseline object changed during inspection",
        );
      return { entry, bytes };
    });
  }

  async inspectionHistory(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    path: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<string[]> {
    const file = path ? safeRelative(path) : null;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 10000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1001
    )
      throw new WorkspaceError(
        "inspection_history_limit",
        "History requires a bounded commit range",
      );
    return this.inspectionGit(authority, identity, signal, async (git, workspace) => {
      const text = await git.text(
        [
          "--literal-pathspecs",
          "log",
          "--no-decorate",
          "--no-show-signature",
          "--format=%H %s",
          `--max-count=${limit}`,
          `--skip=${offset}`,
          workspace.baselineRevision,
          "--",
          ...(file ? [file] : []),
        ],
        { signal },
      );
      return text ? text.replace(/\n$/, "").split("\n") : [];
    });
  }

  private async inspectionGit<T>(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
    body: (git: KernelGit, workspace: WorkspaceRecord) => Promise<T>,
  ): Promise<T> {
    const workspace = await this.owned(authority, identity);
    const git = new KernelGit(workspace.path);
    await this.assertPrivateGit(git, signal);
    const result = await body(git, workspace);
    await this.assertPrivateGit(git, signal);
    await this.owned(authority, identity);
    signal.throwIfAborted();
    return result;
  }

  /** Runs under a journal-owned validation exclusion, not an agent's assertion of file equality. */
  async verifyValidationWorkspace(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    snapshotInput: WorkspaceSnapshot,
    operationId: string,
    writablePaths: readonly string[],
    prepareScratch: boolean,
    signal?: AbortSignal,
  ): Promise<WorkspaceRecord> {
    const workspace = await this.owned(authority, identity);
    const snapshot = WorkspaceSnapshotSchema.parse(snapshotInput);
    const operation = this.journal.agents.activeWorkspaceOperation(authority.runId, workspace);
    if (
      !operation ||
      operation.operationId !== operationId ||
      !["validation", "review_inspection"].includes(operation.kind) ||
      operation.controllerLeaseId !== authority.leaseId ||
      workspace.sourceMode !== "immutable" ||
      workspace.activeTurnId ||
      workspace.baselineRevision !== snapshot.snapshotRevision ||
      workspace.baselineFingerprint !== snapshot.fingerprint ||
      snapshot.runId !== authority.runId ||
      digestJson(snapshot.manifest) !== snapshot.fingerprint
    )
      throw new WorkspaceError(
        "validation_ownership",
        "Validation needs its exclusive candidate-bound workspace",
      );
    const scratch = new Set(writablePaths.map(safeRelative));
    for (const path of scratch) {
      if (
        path
          .split("/")
          .some((part) => [".git", ".beads", ".epicd", ".codex", "AGENTS.md"].includes(part)) ||
        snapshot.manifest.some(
          (entry) =>
            entry.path === path ||
            entry.path.startsWith(`${path}/`) ||
            path.startsWith(`${entry.path}/`),
        )
      )
        throw new WorkspaceError(
          "scratch_source_overlap",
          "Scratch cannot overlap candidate or protected source",
        );
      await safeParents(workspace.path, `${path}/placeholder`, prepareScratch);
      if ((await realpath(join(workspace.path, path))) !== join(workspace.path, path))
        throw new WorkspaceError("scratch_alias", "Scratch must be a canonical directory");
    }
    const git = new KernelGit(workspace.path);
    await this.assertPrivateGit(git, signal);
    if (
      (await git.text(["rev-parse", "HEAD"], optionalSignal(signal))).trim() !==
      snapshot.snapshotRevision
    )
      throw new WorkspaceError("candidate_revision_changed", "Review workspace HEAD changed");
    await assertExpectedNamespace(
      workspace.path,
      new Set(snapshot.manifest.map((entry) => entry.path)),
      scratch,
    );
    const actual = await this.readExpectedFiles(workspace.path, snapshot.manifest);
    if (digestJson(actual) !== snapshot.fingerprint)
      throw new WorkspaceError(
        "candidate_source_changed",
        "Review workspace no longer contains the exact candidate bytes",
      );
    this.journal.assertAuthority(authority);
    return workspace;
  }

  private async materialize(
    authority: ControllerAuthority,
    workspace: WorkspaceRecord,
    source: KernelGit,
    format: ObjectFormat,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(workspace.path), { recursive: true, mode: 0o700 });
    if ((await realpath(dirname(workspace.path))) !== dirname(workspace.path))
      throw new WorkspaceError(
        "workspace_path_changed",
        "Managed workspace parent is not canonical",
      );
    this.journal.assertAuthority(authority);
    if (await exists(workspace.path))
      throw new WorkspaceError(
        "workspace_exists",
        "Reserved workspace path already exists; preserve it for reconciliation",
      );
    // Local clone copies only Git objects/refs. No checkout, shared alternates, hard links, or template hooks.
    await source.text(
      [
        "clone",
        "--local",
        "--no-hardlinks",
        "--no-checkout",
        "--no-recurse-submodules",
        "--reject-shallow",
        "--template=",
        "--",
        source.path,
        workspace.path,
      ],
      optionalSignal(signal),
    );
    this.journal.assertAuthority(authority);
    await chmod(workspace.path, 0o700);
    const git = new KernelGit(workspace.path);
    // Replace only the newly created private config; never copy source hooks, credentials, or remotes.
    await writeFile(join(workspace.path, ".git", "config"), privateConfig(format), { mode: 0o600 });
    await this.assertPrivateGit(git, signal);
    const entries = await this.treeEntries(git, workspace.baselineRevision, signal);
    let total = 0;
    const manifest: ManifestEntry[] = [];
    for (const entry of entries) {
      this.journal.assertAuthority(authority);
      signal?.throwIfAborted();
      const bytes = await git.bytes(["cat-file", "blob", entry.objectId], optionalSignal(signal));
      total += bytes.length;
      if (total > CHECKOUT_LIMIT)
        throw new WorkspaceError(
          "checkout_too_large",
          "Initial checkout exceeds the supported 512 MiB bound",
        );
      if (blobId(bytes, format) !== entry.objectId)
        throw new WorkspaceError("object_mismatch", "Copied Git object does not match its name");
      await safeParents(workspace.path, entry.path, true);
      const path = join(workspace.path, entry.path);
      if (entry.mode === "120000") {
        if (bytes.includes(0))
          throw new WorkspaceError("invalid_symlink", "Symlink target contains NUL");
        await symlink(bytes, path);
      } else {
        await writeFile(path, bytes, { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
      }
      manifest.push(manifestEntry(entry, bytes));
    }
    await git.text(["read-tree", workspace.baselineRevision], optionalSignal(signal));
    // A detached HEAD avoids moving any branch, including a cloned source branch.
    await writeFile(join(workspace.path, ".git", "HEAD"), `${workspace.baselineRevision}\n`, {
      mode: 0o600,
    });
    for (const name of [".beads", ".epicd", ".codex"]) {
      const path = join(workspace.path, name);
      if (!(await exists(path))) await mkdir(path, { mode: 0o700 });
    }
    await this.rejectFilters(
      git,
      entries.map((entry) => entry.path),
      signal,
    );
    await assertExpectedNamespace(workspace.path, new Set(entries.map((entry) => entry.path)));
    const actual = await this.readExpectedFiles(workspace.path, entries);
    if (digestJson(actual) !== digestJson(manifest))
      throw new WorkspaceError("workspace_changed", "Materialized files changed before readiness");
    this.journal.assertAuthority(authority);
    this.journal.agents.markWorkspaceReady(authority, workspace, digestJson(manifest));
  }

  private async preflight(
    git: KernelGit,
    revision: string,
    signal?: AbortSignal,
  ): Promise<ObjectFormat> {
    const resolved = (
      await git.text(
        ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
        optionalSignal(signal),
      )
    ).trim();
    if (resolved !== revision)
      throw new WorkspaceError(
        "revision_not_exact",
        "Materialization requires an exact commit object ID",
      );
    const common = await realpath(
      (
        await git.text(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          optionalSignal(signal),
        )
      ).trim(),
    );
    for (const name of [
      "objects/info/alternates",
      "objects/info/http-alternates",
      "info/grafts",
      "shallow",
    ]) {
      if (await exists(join(common, name)))
        throw new WorkspaceError(
          "unsupported_repository",
          `Unsupported repository metadata: ${name}`,
        );
    }
    const config = await git.text(
      [
        "config",
        "--local",
        "--get-regexp",
        "^(extensions\\.partialclone|remote\\..*\\.promisor|include\\.|includeif\\.)",
      ],
      { allowedExitCodes: [0, 1], ...optionalSignal(signal) },
    );
    if (config.trim())
      throw new WorkspaceError(
        "unsupported_repository",
        "Partial clone or included configuration requires an explicit supported copy contract",
      );
    const format = (
      await git.text(["rev-parse", "--show-object-format"], optionalSignal(signal))
    ).trim();
    if (format !== "sha1" && format !== "sha256")
      throw new WorkspaceError("unsupported_object_format", "Unsupported Git object format");
    await this.treeEntries(git, revision, signal);
    return format;
  }

  private async assertPrivateGit(git: KernelGit, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if ((await realpath(join(git.path, ".git"))) !== join(git.path, ".git"))
      throw new WorkspaceError("shared_git_directory", "Managed Git directory is not private");
    // Inspect metadata before asking Git to read it. In particular, do not honor an injected include.
    await rejectAliases(join(git.path, ".git"), signal);
    const config = (await regularBytes(join(git.path, ".git", "config"))).toString("utf8");
    if (config !== privateConfig("sha1") && config !== privateConfig("sha256"))
      throw new WorkspaceError(
        "git_config_changed",
        "Private Git configuration changed outside the kernel",
      );
    for (const name of [
      "objects/info/alternates",
      "objects/info/http-alternates",
      "info/grafts",
      "shallow",
    ]) {
      if (await exists(join(git.path, ".git", name)))
        throw new WorkspaceError(
          "shared_object_store",
          "Managed object storage must be independent",
        );
    }
  }

  private async treeEntries(
    git: KernelGit,
    revision: string,
    signal?: AbortSignal,
  ): Promise<TreeEntry[]> {
    const data = await git.bytes(
      ["ls-tree", "-r", "-z", "--full-tree", revision],
      optionalSignal(signal),
    );
    const entries = decode(data)
      .split("\0")
      .filter(Boolean)
      .map((line): TreeEntry => {
        const match = /^([0-7]{6}) ([a-z]+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        if (!match || match[2] !== "blob" || !["100644", "100755", "120000"].includes(match[1]!))
          throw new WorkspaceError(
            "unsupported_tree_entry",
            "Submodules and non-blob tree entries are not supported",
          );
        return {
          mode: match[1] as TreeEntry["mode"],
          objectId: match[3]!,
          path: safeRelative(match[4]!),
        };
      });
    const paths = new Set<string>();
    for (const entry of entries) {
      if (paths.has(entry.path))
        throw new WorkspaceError("duplicate_path", "Duplicate Git tree path");
      paths.add(entry.path);
    }
    for (const path of paths) {
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
        if (paths.has(parent))
          throw new WorkspaceError(
            "path_collision",
            "A file overlaps another file's parent directory",
          );
    }
    return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  }

  private async scan(
    git: KernelGit,
    baseline: string,
    signal?: AbortSignal,
  ): Promise<CapturedFile[]> {
    const tracked = await this.treeEntries(git, baseline, signal);
    const untracked = decode(
      await git.bytes(
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        optionalSignal(signal),
      ),
    )
      .split("\0")
      .filter(Boolean);
    const paths = [...new Set([...tracked.map((entry) => entry.path), ...untracked])]
      .map(safeRelative)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    await this.rejectFilters(git, paths, signal);
    const format = (
      await git.text(["rev-parse", "--show-object-format"], optionalSignal(signal))
    ).trim() as ObjectFormat;
    const files: CapturedFile[] = [];
    let total = 0;
    for (const path of paths) {
      signal?.throwIfAborted();
      await safeParents(git.path, path);
      const absolute = join(git.path, path);
      const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new WorkspaceError("unsupported_file", `Unsupported candidate path: ${path}`);
      const bytes = stat.isSymbolicLink()
        ? await readlink(absolute, { encoding: "buffer" })
        : await regularBytes(absolute);
      total += bytes.length;
      if (total > CHECKOUT_LIMIT)
        throw new WorkspaceError(
          "checkout_too_large",
          "Candidate exceeds the supported 512 MiB bound",
        );
      const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
      files.push({
        entry: manifestEntry({ path, mode, objectId: blobId(bytes, format) }, bytes),
        bytes,
      });
    }
    return files;
  }

  private async readExpectedFiles(root: string, entries: TreeEntry[]): Promise<ManifestEntry[]> {
    const files: ManifestEntry[] = [];
    for (const entry of entries) {
      await safeParents(root, entry.path);
      const path = join(root, entry.path);
      const stat = await lstat(path);
      const mode = stat.isSymbolicLink()
        ? "120000"
        : stat.isFile()
          ? stat.mode & 0o111
            ? "100755"
            : "100644"
          : null;
      if (mode !== entry.mode)
        throw new WorkspaceError("mode_mismatch", `Materialized file mode differs: ${entry.path}`);
      files.push(
        manifestEntry(
          entry,
          stat.isSymbolicLink()
            ? await readlink(path, { encoding: "buffer" })
            : await regularBytes(path),
        ),
      );
    }
    return files;
  }

  private async rejectFilters(
    git: KernelGit,
    paths: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!paths.length) return;
    const attributes = decode(
      await git.bytes(["check-attr", "-z", "--stdin", "filter", "working-tree-encoding", "ident"], {
        input: `${paths.join("\0")}\0`,
        ...optionalSignal(signal),
      }),
    ).split("\0");
    for (let index = 0; index + 2 < attributes.length; index += 3) {
      const value = attributes[index + 2];
      if (value !== "unspecified" && value !== "unset")
        throw new WorkspaceError(
          "unsupported_filter",
          `Materialization attribute requires explicit support: ${attributes[index + 1]}`,
        );
    }
  }

  private async assertProtectedTracker(
    git: KernelGit,
    baseline: string,
    files: CapturedFile[],
    signal?: AbortSignal,
  ): Promise<void> {
    const before = (await this.treeEntries(git, baseline, signal)).filter((entry) =>
      trackerPath(entry.path),
    );
    const after = files
      .filter((file) => trackerPath(file.entry.path))
      .map(({ entry }) => ({ path: entry.path, mode: entry.mode, objectId: entry.objectId }));
    if (digestJson(before) !== digestJson(after))
      throw new WorkspaceError("tracker_changed", "Only the kernel may change tracker files");
  }

  private async writeTree(
    git: KernelGit,
    manifest: ManifestEntry[],
    signal?: AbortSignal,
  ): Promise<string> {
    const indexPath = join(git.path, ".git", `epicd-index-${randomUUID()}`);
    try {
      await git.text(["read-tree", "--empty"], { indexPath, ...optionalSignal(signal) });
      if (manifest.length)
        await git.text(["update-index", "-z", "--index-info"], {
          indexPath,
          input: manifest
            .map((entry) => `${entry.mode} ${entry.objectId}\t${entry.path}\0`)
            .join(""),
          ...optionalSignal(signal),
        });
      return (await git.text(["write-tree"], { indexPath, ...optionalSignal(signal) })).trim();
    } finally {
      await rm(indexPath, { force: true });
      await rm(`${indexPath}.lock`, { force: true });
    }
  }

  private async owned(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    allowReserved = false,
  ): Promise<WorkspaceRecord> {
    this.journal.assertAuthority(authority);
    const workspace = this.journal.agents.workspace(authority.runId, identity);
    const expected = join(await realpath(this.root), authority.runId, workspace.workspaceId);
    if (workspace.path !== expected || (await realpath(workspace.path)) !== expected)
      throw new WorkspaceError(
        "workspace_path_changed",
        "Managed workspace path changed; preserve it",
      );
    if (!(workspace.status === "ready" || (allowReserved && workspace.status === "reserved")))
      throw new WorkspaceError(
        "workspace_unavailable",
        "Workspace is not ready for this operation",
      );
    this.journal.assertAuthority(authority);
    return workspace;
  }
  private assertStopped(workspace: WorkspaceRecord): void {
    if (workspace.activeTurnId !== null)
      throw new AgentCoordinationError(
        "workspace_busy",
        "A process may still be writing this workspace",
      );
  }

  private async exclusive<T>(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    kind: WorkspaceOperation["kind"],
    body: () => Promise<T>,
  ): Promise<T> {
    const operation = this.journal.agents.beginWorkspaceOperation(
      authority,
      identity,
      kind,
      this.journal.control(authority.runId).controlVersion,
    );
    let status: "succeeded" | "failed" = "failed";
    try {
      const result = await body();
      status = "succeeded";
      return result;
    } finally {
      // A lease loss deliberately leaves the durable exclusion held. A new controller must prove stop.
      this.journal.agents.finishWorkspaceOperation(
        authority,
        operation.operationId,
        status,
        "Trusted workspace adapter has awaited all filesystem operations and Git process closure",
      );
    }
  }
}

async function assertExpectedNamespace(
  root: string,
  expected: Set<string>,
  scratch: ReadonlySet<string> = new Set(),
): Promise<void> {
  let count = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const name of await readdir(directory)) {
      if (!prefix && name === ".git") continue;
      if (++count > 100000)
        throw new WorkspaceError(
          "checkout_too_large",
          "Workspace namespace exceeds 100,000 entries",
        );
      const path = prefix ? `${prefix}/${name}` : name;
      if (scratch.has(path)) continue;
      const absolute = join(root, safeRelative(path));
      const stat = await lstat(absolute);
      if (stat.isDirectory()) await visit(absolute, path);
      else if (!expected.has(path))
        throw new WorkspaceError(
          "unexpected_file",
          "Unexpected file in materialized workspace; preserve it",
        );
    }
  }
  await visit(root, "");
}

function safeRelative(path: string): string {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw new WorkspaceError("unsafe_path", "Path escapes the candidate file namespace");
  return path;
}
async function safeParents(root: string, path: string, create = false): Promise<void> {
  const parts = safeRelative(path).split("/").slice(0, -1);
  let parent = root;
  for (const part of parts) {
    parent = join(parent, part);
    if (create)
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const stat = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new WorkspaceError(
        "unsafe_parent",
        "Candidate path has a non-directory or symbolic-link parent",
      );
  }
}
async function regularBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > FILE_LIMIT)
      throw new WorkspaceError(
        "unsupported_file",
        "Candidate files must be unshared regular files no larger than 64 MiB",
      );
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.nlink !== 1
    )
      throw new WorkspaceError("file_changed", "Candidate file changed during capture");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function rejectAliases(root: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const stat = await lstat(root);
  signal?.throwIfAborted();
  if (stat.isSymbolicLink())
    throw new WorkspaceError("shared_git_directory", "Managed metadata contains a symbolic link");
  if (stat.isDirectory()) {
    for (const entry of await readdir(root)) await rejectAliases(join(root, entry), signal);
  } else if (!stat.isFile() || stat.nlink !== 1)
    throw new WorkspaceError(
      "shared_git_directory",
      "Managed metadata contains a shared or non-regular file",
    );
}
function blobId(bytes: Buffer, format: ObjectFormat): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
function manifestEntry(entry: TreeEntry, bytes: Buffer): ManifestEntry {
  return ManifestEntrySchema.parse({
    ...entry,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
function trackerPath(path: string): boolean {
  return path === ".beads" || path.startsWith(".beads/");
}
function decode(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function optionalSignal(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
