import { createHash } from "node:crypto";
import type { ControllerAuthority, KernelAction } from "../domain/orchestration.js";
import type { WorkspaceManager } from "./workspaces.js";
import { InspectionError, InspectionFiles, inspectionPath } from "./inspection-files.js";
import { redactDiagnosticText } from "../util/redact.js";

type Request = Extract<KernelAction, { kind: "inspect_repo" }>;
type Row = Record<string, unknown>;
const textBytes = (bytes: Buffer): string | null => {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};
const lines = (value: string): string[] =>
  value === "" ? [] : value.replace(/\n$/, "").split("\n");
const secretFile = (path: string) =>
  path
    .split("/")
    .some((part) =>
      /^(auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519)|.*\.(?:pem|key)|\.env(?:\.(?!example$|sample$).*)?)$/i.test(
        part,
      ),
    );
// Redact whole contents before selecting a page, so a page boundary cannot expose a split assignment.
const diagnostic = redactDiagnosticText;

/** Bounded source observations. Never creates a candidate, validation, or approval record. */
export async function inspectRepository(
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  request: Request,
  signal: AbortSignal,
): Promise<string> {
  const path = inspectionPath(request.path);
  if (request.offset > 4 * 1024 * 1024)
    throw new InspectionError("inspection_offset_limit", "Select a narrower inspection range");
  if (request.operation !== "search" && request.query !== null)
    throw new InspectionError(
      "inspection_query",
      "Only literal source search accepts a query; Git arguments and revisions are not query input",
    );
  if (request.operation === "search" && (!request.query || request.query.includes("\0")))
    throw new InspectionError("inspection_query", "Search requires a nonempty literal text query");
  if (secretFile(path))
    throw new InspectionError(
      "inspection_secret_path",
      "Credential files are not available as diagnostic artifacts",
    );
  const workspace = await workspaces.inspectionSource(authority, request);
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const files = await InspectionFiles.open(workspace.path, boundedSignal);
  try {
    let rows: Row[] = [];
    let total: number | null = null;
    let more = false;
    let skippedBinary = 0;
    let skippedCredentials = 0;
    let paged = false;
    const page = (count: number, row: (index: number) => Row) => {
      total = count;
      more = count > request.offset + request.limit;
      rows = Array.from(
        { length: Math.max(0, Math.min(request.limit, count - request.offset)) },
        (_, index) => row(index + request.offset),
      );
      paged = true;
    };
    if (request.operation === "read") {
      if (!path) throw new InspectionError("inspection_file_required", "Read requires a file path");
      const bytes = await files.read(path);
      const text = textBytes(bytes);
      if (text === null)
        throw new InspectionError(
          "inspection_binary",
          "File is binary or non-UTF-8; use listing or diff metadata",
        );
      const content = diagnostic(text);
      total = content.length;
      more = total > request.offset + request.limit;
      rows =
        request.offset >= total
          ? []
          : [{ text: content.slice(request.offset, request.offset + request.limit) }];
      paged = true;
    } else if (request.operation === "history") {
      rows = (
        await workspaces.inspectionHistory(
          authority,
          request,
          path,
          request.offset,
          request.limit + 1,
          boundedSignal,
        )
      ).map((text) => ({ text: diagnostic(text) }));
      more = rows.length > request.limit;
      rows = rows.slice(0, request.limit);
      paged = true;
    } else if (request.operation === "diff" && path && (await files.stat(path)) !== "directory") {
      const baseline = await workspaces.inspectionBaseline(authority, request, path, boundedSignal);
      const kind = await files.stat(path);
      const current =
        kind === "file"
          ? await files.file(path)
          : kind === "symlink"
            ? { bytes: await files.link(path), mode: "120000" }
            : null;
      if (!baseline && kind === null)
        throw new InspectionError(
          "inspection_not_found",
          "Neither baseline nor current source contains this path",
        );
      const beforeText = baseline ? textBytes(baseline.bytes) : "";
      const afterText = current ? textBytes(current.bytes) : "";
      const metadata = {
        format: "before_after",
        beforeMode: baseline?.entry.mode ?? null,
        afterMode: current?.mode ?? null,
        afterKind: kind,
        beforeSha256: baseline ? createHash("sha256").update(baseline.bytes).digest("hex") : null,
        afterSha256: current ? createHash("sha256").update(current.bytes).digest("hex") : null,
        binary: beforeText === null || afterText === null,
        symlinkTargetsFollowed: false,
      };
      const beforeLines = beforeText === null ? [] : lines(diagnostic(beforeText));
      const afterLines = afterText === null ? [] : lines(diagnostic(afterText));
      page(1 + beforeLines.length + afterLines.length, (index) =>
        index === 0
          ? metadata
          : index <= beforeLines.length
            ? { side: "before", line: index, text: beforeLines[index - 1]! }
            : {
                side: "after",
                line: index - beforeLines.length,
                text: afterLines[index - beforeLines.length - 1]!,
              },
      );
    } else {
      const entries = await files.list(path);
      if (request.operation === "list") rows = entries;
      else if (request.operation === "search") {
        let matches = 0;
        for (const entry of entries) {
          boundedSignal.throwIfAborted();
          if (entry.kind !== "file") continue;
          if (secretFile(entry.path)) {
            skippedCredentials++;
            continue;
          }
          const text = textBytes(await files.read(entry.path));
          if (text === null) {
            skippedBinary++;
            continue;
          }
          for (const [index, line] of lines(diagnostic(text)).entries()) {
            if (!line.includes(request.query!)) continue;
            if (matches++ < request.offset) continue;
            rows.push({ path: entry.path, line: index + 1, text: line });
            if (rows.length > request.limit) break;
          }
          if (rows.length > request.limit) {
            more = true;
            break;
          }
        }
        total = more ? null : matches;
        rows = rows.slice(0, request.limit);
        paged = true;
      } else {
        const baseline = (
          await workspaces.inspectionTree(authority, request, boundedSignal)
        ).filter(
          (entry) =>
            (!path || entry.path === path || entry.path.startsWith(`${path}/`)) &&
            !entry.path.split("/").some((part) => [".git", ".codex"].includes(part.toLowerCase())),
        );
        const previous = new Map(baseline.map((entry) => [entry.path, entry]));
        for (const entry of entries) {
          boundedSignal.throwIfAborted();
          if (entry.kind === "directory") continue;
          const before = previous.get(entry.path);
          previous.delete(entry.path);
          if (secretFile(entry.path)) {
            skippedCredentials++;
            continue;
          }
          if (entry.kind !== "file" && entry.kind !== "symlink") {
            rows.push({
              path: entry.path,
              change: "not_compared",
              beforeMode: before?.mode ?? null,
              afterKind: entry.kind,
            });
            continue;
          }
          const { bytes, mode } =
            entry.kind === "file"
              ? await files.file(entry.path)
              : { bytes: await files.link(entry.path), mode: "120000" };
          const objectId = createHash(workspace.baselineRevision.length === 64 ? "sha256" : "sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex");
          if (before?.objectId !== objectId || before.mode !== mode)
            rows.push({
              path: entry.path,
              change: before ? "modified" : "added",
              beforeObjectId: before?.objectId ?? null,
              observedObjectId: objectId,
              beforeMode: before?.mode ?? null,
              observedMode: mode,
            });
        }
        for (const entry of previous.values()) {
          if (secretFile(entry.path)) {
            skippedCredentials++;
            continue;
          }
          rows.push({ path: entry.path, change: "deleted", beforeObjectId: entry.objectId });
        }
        rows.sort((a, b) =>
          String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0,
        );
      }
    }
    if (!paged) {
      total = more ? null : rows.length;
      more ||= rows.length > request.offset + request.limit;
      rows = rows.slice(request.offset, request.offset + request.limit);
    }
    const result = {
      operation: request.operation,
      path,
      workspaceId: workspace.workspaceId,
      workspaceGeneration: workspace.workspaceGeneration,
      workspaceStatus: workspace.status,
      baselineRevision: workspace.baselineRevision,
      observedAt: new Date().toISOString(),
      evidenceWarning:
        "Diagnostic observation, not validation or approval. Quarantined copies stay ineligible; reading a delta does not establish its writer or authorize restoration. Concurrent source changes and later pages may differ. History is anchored to the registered baseline, not mutable HEAD.",
      offsetUnit: request.operation === "read" ? "redacted_utf16_characters" : "rows",
      offset: request.offset,
      rows,
      total,
      nextOffset: more
        ? request.offset +
          (request.operation === "read" ? String(rows[0]?.text ?? "").length : rows.length)
        : null,
      skippedBinary,
      skippedCredentials,
      rowTextTruncated: false,
    };
    // Bound retained JSON, including control-character escaping and long names/lines.
    for (const row of rows)
      if (typeof row.text === "string" && row.text.length > 4000) {
        row.text = row.text.slice(0, 4000);
        result.rowTextTruncated = true;
      }
    while (Buffer.byteLength(JSON.stringify(result)) > 64000 && result.rows.length > 1) {
      result.rows.pop();
      result.nextOffset = request.offset + result.rows.length;
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 64000)
      throw new InspectionError(
        "inspection_result_limit",
        "Inspection row exceeds its diagnostic budget",
      );
    await files.assertRoot();
    await workspaces.inspectionSource(authority, request);
    boundedSignal.throwIfAborted();
    return JSON.stringify(result);
  } finally {
    await files.close();
  }
}
