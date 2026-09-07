import { constants } from "node:fs";
import { lstat, open, opendir, readlink, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

export class InspectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InspectionError";
  }
}

export function inspectionPath(value: string, allowRoot = true): string {
  if (allowRoot && (value === "" || value === ".")) return "";
  if (
    !value ||
    value.length > 4096 ||
    isAbsolute(value) ||
    /[\0\\]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || [".git", ".codex"].includes(part.toLowerCase()),
      )
  )
    throw new InspectionError(
      "unsafe_inspection_path",
      "Use a literal path inside the registered source workspace, excluding Git and provider metadata",
    );
  return value;
}

export type InspectionEntry = { path: string; kind: "file" | "directory" | "symlink" | "special" };
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;

/** Linux directory-descriptor traversal: never check a parent then reopen it by its mutable pathname. */
export class InspectionFiles {
  private entries = 0;
  private bytes = 0;
  private constructor(
    private readonly root: FileHandle,
    private readonly path: string,
    private readonly signal: AbortSignal,
  ) {}

  static async open(path: string, signal: AbortSignal): Promise<InspectionFiles> {
    if (process.platform !== "linux")
      throw new InspectionError(
        "inspection_platform",
        "Descriptor-confined inspection requires Linux",
      );
    if (!isAbsolute(path))
      throw new InspectionError(
        "inspection_root",
        "Inspection requires a registered absolute workspace",
      );
    let directory = await open("/", DIRECTORY_FLAGS);
    try {
      for (const component of path.split("/").filter(Boolean)) {
        signal.throwIfAborted();
        if (component === "." || component === "..")
          throw new InspectionError("inspection_root", "Workspace must be canonical");
        const next = await open(`${fdPath(directory)}/${component}`, DIRECTORY_FLAGS);
        await directory.close();
        directory = next;
      }
      return new InspectionFiles(directory, path, signal);
    } catch (error) {
      await directory.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.root.close();
  }

  async assertRoot(): Promise<void> {
    this.signal.throwIfAborted();
    const before = await this.root.stat();
    const after = await lstat(this.path);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino)
      throw new InspectionError(
        "inspection_root_changed",
        "Workspace root changed during inspection; preserve it",
      );
  }

  private async parent<T>(
    path: string,
    body: (parent: FileHandle, name: string) => Promise<T>,
  ): Promise<T> {
    const parts = inspectionPath(path, false).split("/");
    let parent = this.root;
    try {
      for (const component of parts.slice(0, -1)) {
        this.signal.throwIfAborted();
        const next = await open(`${fdPath(parent)}/${component}`, DIRECTORY_FLAGS);
        if (parent !== this.root) await parent.close();
        parent = next;
      }
      this.signal.throwIfAborted();
      return await body(parent, parts.at(-1)!);
    } finally {
      if (parent !== this.root) await parent.close();
    }
  }

  async read(path: string, fileLimit = 4 * 1024 * 1024): Promise<Buffer> {
    return (await this.file(path, fileLimit)).bytes;
  }

  async link(path: string): Promise<Buffer> {
    return this.parent(path, async (parent, name) => {
      const target = `${fdPath(parent)}/${name}`;
      const before = await lstat(target);
      if (!before.isSymbolicLink() || before.nlink !== 1)
        throw new InspectionError("inspection_link", "Expected an unshared symbolic link");
      const bytes = await readlink(target, { encoding: "buffer" });
      const after = await lstat(target);
      if (
        !after.isSymbolicLink() ||
        after.nlink !== 1 ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new InspectionError(
          "inspection_file_changed",
          "Symbolic link changed during inspection",
        );
      return bytes; // The link value, never its target's contents.
    });
  }

  async file(
    path: string,
    fileLimit = 4 * 1024 * 1024,
  ): Promise<{ bytes: Buffer; mode: "100644" | "100755" }> {
    return this.parent(path, async (parent, name) => {
      const file = await open(`${fdPath(parent)}/${name}`, FILE_FLAGS);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > fileLimit)
          throw new InspectionError(
            "inspection_file_limit",
            "Inspection requires an unshared regular file within the byte limit",
          );
        this.bytes += before.size;
        if (this.bytes > 32 * 1024 * 1024)
          throw new InspectionError(
            "inspection_scan_limit",
            "Inspection exceeded 32 MiB; select a narrower path",
          );
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          this.signal.throwIfAborted();
          const read = await file.read(
            bytes,
            offset,
            Math.min(65536, bytes.length - offset),
            offset,
          );
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        const after = await file.stat();
        if (
          offset !== before.size ||
          after.nlink !== 1 ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new InspectionError(
            "inspection_file_changed",
            "File changed during inspection; obtain a fresh observation",
          );
        return { bytes, mode: before.mode & 0o111 ? "100755" : "100644" };
      } finally {
        await file.close();
      }
    });
  }

  async stat(path: string): Promise<InspectionEntry["kind"] | null> {
    try {
      return await this.parent(path, async (parent, name) => {
        const stat = await lstat(`${fdPath(parent)}/${name}`);
        return stat.isFile()
          ? "file"
          : stat.isDirectory()
            ? "directory"
            : stat.isSymbolicLink()
              ? "symlink"
              : "special";
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async list(path: string): Promise<InspectionEntry[]> {
    const base = inspectionPath(path);
    if (base) {
      const kind = await this.stat(base);
      if (kind === null)
        throw new InspectionError("inspection_not_found", "Source path does not exist");
      if (kind !== "directory") return [{ path: base, kind }];
    }
    const found: InspectionEntry[] = [];
    const visit = async (directory: FileHandle, prefix: string, depth: number): Promise<void> => {
      if (depth > 64)
        throw new InspectionError(
          "inspection_depth_limit",
          "Inspection exceeds 64 directories; select a narrower path",
        );
      const names: string[] = [];
      const iterator = await opendir(fdPath(directory));
      for await (const entry of iterator) {
        this.signal.throwIfAborted();
        if (++this.entries > 10000)
          throw new InspectionError(
            "inspection_entry_limit",
            "Inspection exceeds 10000 entries; select a narrower path",
          );
        if ([".git", ".codex"].includes(entry.name.toLowerCase())) continue;
        names.push(entry.name);
      }
      for (const name of names.sort()) {
        this.signal.throwIfAborted();
        const childPath = inspectionPath(prefix ? `${prefix}/${name}` : name, false);
        const stat = await lstat(`${fdPath(directory)}/${name}`);
        const kind = stat.isFile()
          ? "file"
          : stat.isDirectory()
            ? "directory"
            : stat.isSymbolicLink()
              ? "symlink"
              : "special";
        found.push({ path: childPath, kind });
        if (kind === "directory") {
          const child = await open(`${fdPath(directory)}/${name}`, DIRECTORY_FLAGS);
          try {
            await visit(child, childPath, depth + 1);
          } finally {
            await child.close();
          }
        }
      }
    };
    if (base)
      await this.parent(base, async (parent, name) => {
        const child = await open(`${fdPath(parent)}/${name}`, DIRECTORY_FLAGS);
        try {
          await visit(child, base, 0);
        } finally {
          await child.close();
        }
      });
    else await visit(this.root, "", 0);
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
