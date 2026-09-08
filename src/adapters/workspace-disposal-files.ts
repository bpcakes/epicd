import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { StateFileIdentity } from "../domain/state-file-identity.js";
import type { WorkspaceDisposal } from "../domain/workspace-disposal.js";
import { openPrivateIO } from "./private-io-files.js";

export const disposalRoot = (source: string) => join(dirname(source), ".disposed");
export const retainedWorkspacePath = (record: WorkspaceDisposal) =>
  join(record.archiveDirectory.path, "workspace");
const flags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Pin every parent rather than checking a pathname and reopening through an alias. */
async function directory(path: string): Promise<FileHandle> {
  if (!path.startsWith("/") || resolve(path) !== path)
    throw new Error("Workspace storage must be canonical");
  let handle = await open("/", flags);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = await open(`/proc/self/fd/${handle.fd}/${part}`, flags);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function assertWorkspaceDirectory(identity: StateFileIdentity, path = identity.path) {
  const held = await directory(path);
  try {
    const stat = await held.stat({ bigint: true });
    if (stat.dev.toString() !== identity.device || stat.ino.toString() !== identity.inode)
      throw new Error("Workspace directory identity changed; preserve it");
  } finally {
    await held.close();
  }
}
async function entry(parent: FileHandle, name: string) {
  return lstat(`/proc/self/fd/${parent.fd}/${name}`, { bigint: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
}
const matches = (stat: Awaited<ReturnType<typeof entry>>, identity: StateFileIdentity) =>
  !!stat?.isDirectory() &&
  stat.dev.toString() === identity.device &&
  stat.ino.toString() === identity.inode;

/** No content traversal: moving the directory retains all files, ignored output and symlinks verbatim. */
export async function moveDisposedWorkspace(record: WorkspaceDisposal, assertCurrent: () => void) {
  const sourceParent = await directory(dirname(record.source.path));
  const archive = await openPrivateIO(
    record.archiveDirectory,
    disposalRoot(record.source.path),
  ).catch(async (error: unknown) => {
    await sourceParent.close();
    throw error;
  });
  try {
    if (!matches(await entry(sourceParent, basename(record.source.path)), record.source))
      throw new Error("Workspace directory was replaced before disposal; preserve it");
    if (await entry(archive, "workspace"))
      throw new Error("Disposal destination is occupied; preserve it");
    assertCurrent();
    // GNU mv's RENAME_NOREPLACE operation never overwrites a concurrent destination.
    // --no-copy prohibits cross-filesystem copy/delete fallback. Parent descriptors
    // are inherited by the child so renamed/symlinked pathname parents cannot redirect it.
    const child = spawn(
      "/usr/bin/mv",
      [
        "--no-copy",
        "--no-clobber",
        "--no-target-directory",
        "--",
        `/proc/self/fd/4/${basename(record.source.path)}`,
        "/proc/self/fd/5/workspace",
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ignore", sourceParent.fd, archive.fd],
      },
    );
    child.stdout!.resume();
    let detail = "",
      failure: Error | undefined;
    child.stderr!.on("data", (chunk: Buffer) => {
      detail = (detail + chunk.toString("utf8")).slice(-4000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    const code = await new Promise<number | null>((done) => child.once("close", done));
    if (failure || code !== 0)
      throw failure ?? new Error(`Recoverable workspace move failed: ${detail}`);
    await sourceParent.sync();
    await archive.sync();
    // Physical outcome is inspected after the whole worker is independently stopped.
  } finally {
    await sourceParent.close();
    await archive.close();
  }
}

/** Observe only after stop. An occupied original name belongs to whoever created it, never to cleanup. */
export async function inspectWorkspaceDisposal(record: WorkspaceDisposal) {
  const sourceParent = await directory(dirname(record.source.path));
  const archive = await openPrivateIO(
    record.archiveDirectory,
    disposalRoot(record.source.path),
  ).catch(async (error: unknown) => {
    await sourceParent.close();
    throw error;
  });
  try {
    const source = await entry(sourceParent, basename(record.source.path)),
      retained = await entry(archive, "workspace");
    if (matches(retained, record.source)) {
      // A stopped worker may have lost acknowledgement after rename but before
      // syncing its parents. Flush the observed entries before journaling retention.
      await sourceParent.sync();
      await archive.sync();
      return {
        outcome: "retained" as const,
        sourcePathOccupied: source !== null,
        detail:
          "Original workspace retained intact in private disposal storage. Its old identity cannot run again. Any occupant at the original pathname is preserved, not adopted. No pane was closed.",
      };
    }
    if (matches(source, record.source) && retained === null)
      return {
        outcome: "not_moved" as const,
        sourcePathOccupied: true,
        detail:
          "The stopped operation did not move the original workspace. Its files and retired authority are preserved; a new explicit disposal attempt may be requested.",
      };
    return {
      outcome: "conflict" as const,
      sourcePathOccupied: source !== null,
      detail:
        "Disposal paths do not establish where the original workspace is retained. Preserve both paths and inspect ownership; no rollback, deletion or replay was performed.",
    };
  } finally {
    await sourceParent.close();
    await archive.close();
  }
}
