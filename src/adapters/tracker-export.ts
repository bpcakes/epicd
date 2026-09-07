import Database from "better-sqlite3";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, isAbsolute } from "node:path";
import { z } from "zod";
import { KernelBeads, TRACKER_CONFIGURATION_FILES } from "./kernel-beads.js";
import {
  TrackerExportMetadataSchema,
  trackerExportScope,
  type TrackerBinding,
  type TrackerGraph,
} from "../domain/tracker.js";
import { IssueSchema } from "../domain/types.js";
import { digestJson } from "../domain/repository-policy.js";

const LIMIT = 4 * 1024 * 1024;
const DATABASE_LIMIT = 64 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Retains a complete export privately. Never flushes, imports or clears dirty flags in the source. */
export class TrackerExporter {
  constructor(readonly transport: KernelBeads) {}

  async export(
    binding: TrackerBinding,
    directory: string,
    epicId: string,
    guard: () => void,
    suppliedSignal: AbortSignal,
  ) {
    const signal = AbortSignal.any([suppliedSignal, AbortSignal.timeout(120000)]);
    const check = () => {
      signal.throwIfAborted();
      guard();
    };
    if (!isAbsolute(directory) || !z.uuid().safeParse(directory.split("/").at(-1)).success)
      throw new Error("Tracker export requires its kernel-generated private directory");
    await this.transport.assertBinding(binding);
    check();
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    if ((await realpath(dirname(directory))) !== dirname(directory))
      throw new Error("Tracker export parent contains a filesystem alias");
    // No existing target is reused, truncated or adopted, even after an interrupted export.
    await mkdir(directory, { mode: 0o700 });
    const beads = join(directory, ".beads");
    await mkdir(beads, { mode: 0o700 });
    for (const name of TRACKER_CONFIGURATION_FILES) {
      const bytes = await readRegular(join(binding.directory.path, name), true);
      if (bytes) await createFile(join(beads, name), bytes);
    }
    await this.transport.assertBinding(binding);
    check();
    const source = new Database(binding.database.path, {
      readonly: true,
      fileMustExist: true,
      timeout: 1000,
    });
    try {
      source.pragma("query_only = ON");
      source.pragma("trusted_schema = OFF");
      const pageSize = Number(source.pragma("page_size", { simple: true }));
      const pages = Number(source.pragma("page_count", { simple: true }));
      if (
        !Number.isSafeInteger(pageSize) ||
        pageSize < 512 ||
        pageSize > 65536 ||
        pages * pageSize > DATABASE_LIMIT
      )
        throw new Error("Tracker snapshot exceeds its 64-MiB database bound");
      await createFile(join(beads, "beads.db"), Buffer.alloc(0));
      await source.backup(join(beads, "beads.db"), {
        progress: ({ totalPages }) => {
          check();
          if (totalPages * pageSize > DATABASE_LIMIT)
            throw new Error("Tracker snapshot grew beyond its database bound");
          return 100;
        },
      });
    } finally {
      source.close();
    }
    await this.transport.assertBinding(binding);
    check();
    const snapshot = await this.transport.bind(directory);
    const graph = await this.transport.graph(snapshot, epicId, check, signal);
    const report = await this.transport.exportSnapshot(snapshot, check, signal);
    const bytes = (await readRegular(join(beads, "issues.jsonl")))!;
    check();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const rows = text
      .trimEnd()
      .split("\n")
      .map((line) =>
        z
          .object({ id: z.string().min(1) })
          .passthrough()
          .parse(JSON.parse(line)),
      );
    const ids = new Set(rows.map((row) => row.id));
    if (
      ids.size !== rows.length ||
      rows.length !== report.exported_issues ||
      graph.issues.some((issue) => !ids.has(issue.id))
    )
      throw new Error(
        "Tracker export omitted scope records or disagreed with its complete export report",
      );
    if (hash(bytes) !== report.content_hash)
      throw new Error("Tracker export bytes differ from the exporter's recorded content hash");
    assertExportScope(rows, graph);
    const after = await this.transport.graph(snapshot, epicId, check, signal);
    if (trackerExportScope(after) !== trackerExportScope(graph))
      throw new Error("The private tracker database changed during export");
    await this.transport.assertBinding(binding);
    check();
    return {
      graph,
      text,
      metadata: TrackerExportMetadataSchema.parse({
        sha256: hash(bytes),
        byteLength: bytes.length,
        issueCount: rows.length,
        scopeDigest: trackerExportScope(graph),
      }),
    };
  }
}

/** Export wire fields differ from `show`; check scope data and both directions of every relation. */
function assertExportScope(rows: { id: string; [key: string]: unknown }[], graph: TrackerGraph) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const dependencies = new Map(
    rows.map((row) => [
      row.id,
      z
        .array(
          z.object({
            issue_id: z.string(),
            depends_on_id: z.string(),
            type: z.string(),
          }),
        )
        .parse(row.dependencies ?? []),
    ]),
  );
  const edgeKey = ({ id, type }: { id: string; type: string }) => `${id}\0${type}`;
  const incoming = new Map<string, string[]>();
  for (const [owner, edges] of dependencies)
    for (const edge of edges) {
      if (edge.issue_id !== owner)
        throw new Error("Tracker export has an invalid dependency owner");
      const values = incoming.get(edge.depends_on_id) ?? [];
      values.push(edgeKey({ id: owner, type: edge.type }));
      incoming.set(edge.depends_on_id, values);
    }
  for (const issue of graph.issues) {
    const raw = IssueSchema.parse(byId.get(issue.id));
    const actual = {
      title: raw.title,
      description: raw.description,
      acceptanceCriteria: raw.acceptance_criteria,
      type: raw.issue_type,
      status: raw.status,
      priority: raw.priority,
      assignee: raw.assignee ?? null,
      closedAt: raw.closed_at ?? null,
      closeReason: raw.close_reason ?? null,
      closedBySession: raw.closed_by_session ?? null,
      updatedAt: raw.updated_at ?? null,
      agentContext: raw.agent_context ?? null,
    };
    const expected = {
      title: issue.title,
      description: issue.description,
      acceptanceCriteria: issue.acceptanceCriteria,
      type: issue.type,
      status: issue.status,
      priority: issue.priority,
      assignee: issue.assignee,
      closedAt: issue.closedAt,
      closeReason: issue.closeReason,
      closedBySession: issue.closedBySession,
      updatedAt: issue.updatedAt,
      agentContext: issue.instructions === null ? null : JSON.parse(issue.instructions).own,
    };
    const own = dependencies.get(issue.id)!;
    if (
      digestJson(actual) !== digestJson(expected) ||
      digestJson(own.map((edge) => edgeKey({ id: edge.depends_on_id, type: edge.type })).sort()) !==
        digestJson(issue.dependencies.map(edgeKey).sort()) ||
      digestJson((incoming.get(issue.id) ?? []).sort()) !==
        digestJson(issue.dependents.map(edgeKey).sort())
    )
      throw new Error(`Tracker export disagrees with captured issue scope: ${issue.id}`);
  }
}

async function readRegular(path: string, optional = false): Promise<Buffer | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(LIMIT))
      throw new Error("Tracker export input is shared, non-regular or oversized");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true }),
      entry = await lstat(path, { bigint: true });
    if (
      offset !== Number(before.size) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino ||
      entry.nlink !== 1n
    )
      throw new Error("Tracker export input changed during capture");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}
async function createFile(path: string, bytes: Buffer) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
}
