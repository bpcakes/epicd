import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StateFileIdentity } from "../domain/state-file-identity.js";

/** Trusted-controller file protocol only. Domain callers must validate receipt bindings. */
export async function preparePrivateIO(root: string): Promise<StateFileIdentity> {
  await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
    if (!hasCode(error, "EEXIST")) throw error;
  });
  await privateDirectory(root);
  const parent = await open(dirname(root), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  const path = await mkdtemp(join(root, "operation-"));
  const stat = await lstat(path, { bigint: true });
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return { path, device: stat.dev.toString(), inode: stat.ino.toString() };
}

export async function openPrivateIO(identity: StateFileIdentity, expectedRoot: string) {
  if (dirname(identity.path) !== expectedRoot)
    throw new Error("Private I/O directory is outside its registered root");
  await privateDirectory(expectedRoot);
  await privateDirectory(identity.path);
  const directory = await open(
    identity.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stat = await directory.stat({ bigint: true });
  if (
    stat.dev.toString() !== identity.device ||
    stat.ino.toString() !== identity.inode ||
    (stat.mode & 0o077n) !== 0n ||
    stat.uid !== BigInt(process.getuid!())
  ) {
    await directory.close();
    throw new Error("Private I/O directory identity changed; stop remains unproven");
  }
  return directory;
}

/** Exclusive even against a delayed old launcher. A loser never writes a stop receipt. */
export async function claimPrivateIO(directory: FileHandle, record: Record<string, unknown>) {
  let file: FileHandle;
  try {
    file = await open(`/proc/self/fd/${directory.fd}/started.json`, "wx", 0o600);
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } finally {
    await file.close();
  }
  await directory.sync();
  return true;
}

export async function publishPrivateStop(directory: FileHandle, receipt: unknown) {
  const prefix = `/proc/self/fd/${directory.fd}`;
  const temporary = await open(`${prefix}/stopped.tmp`, "wx", 0o600);
  try {
    await temporary.writeFile(JSON.stringify(receipt));
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  // Atomic no-replace publication, retaining the staging link as evidence.
  await link(`${prefix}/stopped.tmp`, `${prefix}/stopped.json`);
  await directory.sync();
}

export async function readPrivateStop(directory: FileHandle): Promise<unknown | null> {
  let file: FileHandle;
  try {
    file = await open(
      `/proc/self/fd/${directory.fd}/stopped.json`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16_384 ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 2
    )
      throw new Error("Stop receipt is not a private bounded retained file");
    const bytes = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16_384) throw new Error("Stop receipt exceeded its bound");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (await realpath(path)) !== path ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Private I/O directories must be canonical and owner-only");
}
function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
