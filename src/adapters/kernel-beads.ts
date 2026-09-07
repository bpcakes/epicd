import { startNamespaceProcess } from "./pid-namespace.js";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { digestJson } from "../domain/repository-policy.js";
import { IssueSchema } from "../domain/types.js";
import {
  TrackerBindingSchema,
  TrackerGraphSchema,
  TrackerIdSchema,
  TrackerIssueSchema,
  trackerActor,
  type TrackerBinding,
  type TrackerGraph,
  type TrackerIssue,
} from "../domain/tracker.js";
import { redactSensitiveText } from "../util/redact.js";

export const TRACKER_CONFIGURATION_FILES = [
  "config.yaml",
  "policy.yaml",
  "metadata.json",
  "routes.json",
];
const CONFIG = TRACKER_CONFIGURATION_FILES;
const LIMIT = 4 * 1024 * 1024;
type Guard = () => void;
export class TrackerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerTransportError";
  }
}

/** Fixed br operations in a PID/network namespace with only this .beads directory writable. */
export class KernelBeads {
  constructor(
    readonly executable: string,
    readonly bwrapPath = "/usr/bin/bwrap",
  ) {}

  async bind(repository: string): Promise<TrackerBinding> {
    const root = await node(repository, "directory");
    const directory = await node(join(repository, ".beads"), "directory");
    await safeTree(directory.path);
    const database = await node(join(directory.path, "beads.db"), "file");
    const executable = await node(this.executable, "file");
    const config = await Promise.all(
      CONFIG.map(async (name) => [name, await optionalFile(join(directory.path, name))]),
    );
    return TrackerBindingSchema.parse({
      schemaVersion: 1,
      repository: root,
      directory,
      database,
      executable,
      configurationDigest: digestJson(config),
    });
  }
  async assertBinding(binding: TrackerBinding) {
    if (digestJson(await this.bind(binding.repository.path)) !== digestJson(binding))
      throw new TrackerTransportError(
        "Tracker repository, database, executable or configuration changed",
      );
  }
  async graph(
    binding: TrackerBinding,
    epicId: string,
    guard: Guard,
    signal: AbortSignal,
  ): Promise<TrackerGraph> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    TrackerIdSchema.parse(epicId);
    const startedAt = new Date().toISOString();
    const issues = new Map<string, TrackerIssue>();
    let queue = [epicId];
    while (queue.length) {
      signal.throwIfAborted();
      const batch = queue.splice(0, 32).filter((id) => !issues.has(id));
      if (!batch.length) continue;
      const value = await this.command(binding, ["show", ...batch], guard, signal);
      const raw = z.array(IssueSchema).parse(value);
      if (
        raw.length !== batch.length ||
        new Set(raw.map((issue) => issue.id)).size !== batch.length ||
        raw.some((issue) => !batch.includes(issue.id))
      )
        throw new TrackerTransportError("Tracker show did not return exactly the requested IDs");
      for (const input of raw) {
        const relations = (values: unknown[] | undefined) =>
          (values ?? []).map((edge) => {
            const parsed = z
              .object({ id: TrackerIdSchema, dependency_type: z.string(), status: z.string() })
              .parse(edge);
            return { id: parsed.id, type: parsed.dependency_type, status: parsed.status };
          });
        const content = {
          id: input.id,
          title: input.title,
          description: input.description,
          acceptanceCriteria: input.acceptance_criteria,
          status: input.status,
          type: input.issue_type,
          priority: input.priority,
          assignee: input.assignee ?? null,
          instructions:
            input.agent_context || input.inherited_context
              ? JSON.stringify({
                  own: input.agent_context ?? null,
                  inherited: input.inherited_context ?? null,
                })
              : null,
          dependencies: relations(input.dependencies),
          dependents: relations(input.dependents),
        };
        const { status: _status, assignee: _assignee, ...work } = content;
        const issue = TrackerIssueSchema.parse({
          ...content,
          workDigest: digestJson(work),
          contentDigest: digestJson({
            ...work,
            dependencies: work.dependencies
              .map(({ status: _status, ...edge }) => edge)
              .sort((a, b) => a.id.localeCompare(b.id) || a.type.localeCompare(b.type)),
            dependents: work.dependents
              .map(({ status: _status, ...edge }) => edge)
              .sort((a, b) => a.id.localeCompare(b.id) || a.type.localeCompare(b.type)),
          }),
          closedAt: input.closed_at ?? null,
          closeReason: input.close_reason ?? null,
          closedBySession: input.closed_by_session ?? null,
          updatedAt: input.updated_at ?? null,
        });
        issues.set(issue.id, issue);
        for (const edge of issue.dependents)
          if (edge.type === "parent-child" && !issues.has(edge.id)) queue.push(edge.id);
      }
      queue = [...new Set(queue)];
      if (issues.size + queue.length > 1000)
        throw new TrackerTransportError(
          "Epic graph exceeds the 1000-issue bound; no partial graph was accepted",
        );
    }
    const ready = z
      .array(IssueSchema)
      .parse(
        await this.command(binding, ["ready", "--epic", epicId, "--limit", "0"], guard, signal),
      );
    const graph = TrackerGraphSchema.parse({
      schemaVersion: 1,
      epicId,
      issues: [...issues.values()],
      readyIds: ready.map((issue) => issue.id),
      startedAt,
      capturedAt: new Date().toISOString(),
    });
    if (Buffer.byteLength(JSON.stringify(graph)) > LIMIT)
      throw new TrackerTransportError("Epic graph exceeds the 4-MiB bound");
    return graph;
  }
  /** The caller journals the one-use mutation dispatch before this guarded spawn. Never retries. */
  async claim(
    binding: TrackerBinding,
    taskId: string,
    runId: string,
    guard: Guard,
    signal: AbortSignal,
  ) {
    TrackerIdSchema.parse(taskId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId))
      throw new Error("Invalid tracker run identity");
    return this.command(
      binding,
      [
        "update",
        taskId,
        "--claim",
        "--actor",
        trackerActor(runId),
        "--agent-name",
        "epicd",
        "--harness",
        "epicd",
      ],
      guard,
      signal,
    );
  }
  /** Only an isolated export adapter calls this against its disposable database copy. */
  async exportSnapshot(binding: TrackerBinding, guard: Guard, signal: AbortSignal) {
    return z
      .object({
        exported_issues: z.number().int().positive(),
        policy: z.literal("strict"),
        success_rate: z.literal(1),
        errors: z.array(z.unknown()).length(0),
        content_hash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .parse(
        await this.command(
          binding,
          ["sync", "--flush-only", "--error-policy", "strict", "--export-parallelism", "1"],
          guard,
          signal,
          true,
        ),
      );
  }
  /** Exact journal-generated close metadata; never force, bypass policy, or close a batch. */
  async close(
    binding: TrackerBinding,
    taskId: string,
    runId: string,
    operationId: string,
    reason: string,
    guard: Guard,
    signal: AbortSignal,
  ) {
    TrackerIdSchema.parse(taskId);
    z.string().uuid().parse(operationId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId))
      throw new Error("Invalid tracker run identity");
    z.string().min(1).max(1024).parse(reason);
    return this.command(
      binding,
      [
        "close",
        taskId,
        "--reason",
        reason,
        "--transition-comment",
        reason,
        "--session",
        operationId,
        "--actor",
        trackerActor(runId),
        "--agent-name",
        "epicd",
        "--harness",
        "epicd",
      ],
      guard,
      signal,
    );
  }
  private async command(
    binding: TrackerBinding,
    args: string[],
    guard: Guard,
    signal: AbortSignal,
    exportJsonl = false,
  ): Promise<unknown> {
    if (process.platform !== "linux")
      throw new TrackerTransportError("Controlled Beads requires Linux process confinement");
    await this.assertBinding(binding);
    signal.throwIfAborted();
    guard();
    const mounts = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/usr",
      "/usr",
    ];
    for (const path of ["/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache"]) {
      if (await exists(path)) mounts.push("--ro-bind", path, path);
    }
    mounts.push(
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/tmp/epicd-home",
      "--dir",
      "/workspace",
      "--bind",
      binding.directory.path,
      "/workspace/.beads",
      "--ro-bind",
      binding.executable.path,
      "/epicd-br",
    );
    for (const name of CONFIG)
      if (await exists(join(binding.directory.path, name)))
        mounts.push("--ro-bind", join(binding.directory.path, name), `/workspace/.beads/${name}`);
    mounts.push(
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp/epicd-home",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "RUST_LOG",
      "error",
      "--setenv",
      "BEADS_DIR",
      "/workspace/.beads",
      ...(exportJsonl ? ["--setenv", "BEADS_JSONL", "/workspace/.beads/issues.jsonl"] : []),
      "--chdir",
      "/workspace",
      "--",
      "/epicd-br",
      ...args,
      "--db",
      "/workspace/.beads/beads.db",
      "--no-auto-import",
      "--no-auto-flush",
      "--json",
    );
    await this.assertBinding(binding);
    signal.throwIfAborted();
    guard();
    const output = await new Promise<string>((resolve, reject) => {
      const namespace = startNamespaceProcess(this.bwrapPath, mounts, {
        cwd: binding.repository.path,
        env: { PATH: "/usr/bin:/bin" },
        stdio: "pipe",
      });
      const { child } = namespace;
      const chunks: Buffer[] = [],
        errors: Buffer[] = [];
      let size = 0,
        errorSize = 0,
        failure: Error | null = null;
      const stop = (error: Error) => {
        failure ??= error;
        namespace.interrupt();
      };
      const abort = () =>
        stop(new TrackerTransportError("Tracker command cancelled; inspect its recorded effect"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(
        () => stop(new TrackerTransportError("Tracker command exceeded 120 seconds")),
        120000,
      );
      const health = setInterval(() => {
        try {
          guard();
        } catch (error) {
          stop(error instanceof Error ? error : new Error("Tracker authority lost"));
        }
      }, 250);
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= LIMIT) chunks.push(chunk);
        else stop(new TrackerTransportError("Tracker output exceeds 4 MiB"));
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errorSize += chunk.length;
        if (errorSize <= 65536) errors.push(chunk);
        else stop(new TrackerTransportError("Tracker diagnostics exceed 64 KiB"));
      });
      child.on("error", (error) => {
        failure ??= error;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearInterval(health);
        signal.removeEventListener("abort", abort);
        const namespaceError = namespace.failure();
        if (namespaceError) reject(namespaceError);
        else if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new TrackerTransportError(
              `Tracker command stopped with exit ${code}: ${redactSensitiveText(Buffer.concat(errors).toString("utf8"), 3000)}`,
            ),
          );
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    await this.assertBinding(binding);
    return JSON.parse(output);
  }
}
async function node(path: string, kind: "file" | "directory") {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new TrackerTransportError("Tracker paths must be canonical and absolute");
  const stat = await lstat(path, { bigint: true });
  if (kind === "file" ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
    throw new TrackerTransportError("Tracker metadata cannot be aliased or shared");
  return { path, device: stat.dev.toString(), inode: stat.ino.toString() };
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
async function optionalFile(path: string) {
  if (!(await exists(path))) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
      throw new TrackerTransportError("Tracker configuration must be an unshared bounded file");
    return (await handle.readFile()).toString("base64");
  } finally {
    await handle.close();
  }
}
async function safeTree(path: string, depth = 0, count = { value: 0 }): Promise<void> {
  if (depth > 24) throw new TrackerTransportError("Tracker storage nesting exceeds the bound");
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (++count.value > 10000)
      throw new TrackerTransportError("Tracker storage exceeds the entry bound");
    const child = join(path, entry.name),
      stat = await lstat(child);
    if (stat.isDirectory()) await safeTree(child, depth + 1, count);
    else if (!stat.isFile() || stat.nlink !== 1)
      throw new TrackerTransportError(
        "Tracker storage contains a symlink, shared file or special node",
      );
  }
}
