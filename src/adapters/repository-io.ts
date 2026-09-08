import type { FileHandle } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Socket } from "node:net";
import { NamespaceStopUnprovenError, startNamespaceProcess } from "./pid-namespace.js";
import { redactSensitiveText } from "../util/redact.js";
import { z } from "zod";
import {
  preparePrivateIO,
  openPrivateIO,
  claimPrivateIO,
  publishPrivateStop,
  readPrivateStop,
} from "./private-io-files.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import {
  RepositoryAdmissionSchema,
  RepositoryIOStopSchema,
  repositoryIOBinding,
  type RepositoryAdmission,
  type RepositoryIOStop,
} from "../domain/repository-admission.js";
import type { StateFileIdentity } from "../domain/state-file-identity.js";

export const RepositoryIORequestSchema = z
  .strictObject({
    record: RepositoryAdmissionSchema,
    authority: z.strictObject({
      runId: z.string().min(1),
      ownerToken: z.string().min(1),
      leaseId: z.string().min(1),
    }),
  })
  .superRefine(({ record, authority }, context) => {
    if (
      !record.ioId ||
      !record.ioDirectory ||
      record.ioStopped ||
      !["acquiring", "releasing"].includes(record.phase) ||
      record.runId !== authority.runId ||
      record.controllerLeaseId !== authority.leaseId
    )
      context.addIssue({
        code: "custom",
        message: "Repository worker requires the original admitted intent",
      });
  });

const entrypoint = fileURLToPath(new URL("repository-io-cli.js", import.meta.url));
export async function readRepositoryIORequest(input: Readable) {
  let data = "";
  for await (const chunk of input) {
    data += chunk.toString();
    if (Buffer.byteLength(data) > 65_536)
      throw new Error("Repository I/O request exceeded its bound");
  }
  return RepositoryIORequestSchema.parse(JSON.parse(data));
}

/** Host supervisor. Entrypoint injection is for trusted process tests, not a model capability. */
export async function superviseRepositoryIO(workerEntrypoint = entrypoint) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  const control = new Socket({ fd: 3, readable: true, writable: false });
  control.on("end", stop);
  control.on("error", stop);
  control.resume();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const deadline = setTimeout(stop, 120_000);
  try {
    const request = await readRepositoryIORequest(process.stdin);
    const directory = await openRepositoryIO(request.record);
    try {
      // Losing this gate must not authorize a second owner's terminal record.
      if (!(await claimRepositoryIO(directory, request.record, false)))
        throw new Error("Repository I/O dispatch gate is already owned");
      if (abort.signal.aborted) {
        await writeRepositoryIOStop(directory, request.record, {
          kind: "not_started",
          code: null,
          interrupted: true,
          detail: null,
        });
        return;
      }
      const namespace = startNamespaceProcess(process.execPath, [workerEntrypoint, "work"], {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        stdio: "pipe",
        extraInput: JSON.stringify(request),
      });
      abort.signal.addEventListener("abort", namespace.interrupt, { once: true });
      if (abort.signal.aborted) namespace.interrupt();
      namespace.child.stdout!.resume();
      let diagnostics = "";
      namespace.child.stderr!.on("data", (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8000);
      });
      const code = await new Promise<number | null>((resolve) =>
        namespace.child.once("close", resolve),
      );
      abort.signal.removeEventListener("abort", namespace.interrupt);
      const error = namespace.failure();
      if (error instanceof NamespaceStopUnprovenError) throw error;
      await writeRepositoryIOStop(directory, request.record, {
        kind: "stopped",
        code: error ? null : code,
        interrupted: abort.signal.aborted,
        detail:
          error || diagnostics ? redactSensitiveText(error?.message ?? diagnostics, 4000) : null,
      });
    } finally {
      await directory.close();
    }
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    control.destroy();
  }
}
const within = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (!rest.startsWith("../") && rest !== ".." && !rest.startsWith("/"));
};

/** Empty private storage is allocated before the atomic journal intent. No Git effect exists yet. */
export async function prepareRepositoryIO(record: RepositoryAdmission): Promise<StateFileIdentity> {
  const root = `${record.stateFile.path}.repository-io`;
  if (
    within(record.repository.root.path, root) ||
    within(record.repository.commonDirectory.path, root)
  )
    throw new Error("Repository I/O control storage must be outside the checkout and Git metadata");
  return preparePrivateIO(root);
}

/** All gate/receipt I/O is relative to the held, journal-bound directory inode. */
export async function openRepositoryIO(record: RepositoryAdmission) {
  const identity = record.ioDirectory;
  if (!identity) throw new Error("Repository I/O directory is not registered");
  return openPrivateIO(identity, `${record.stateFile.path}.repository-io`);
}

export async function claimRepositoryIO(
  directory: FileHandle,
  record: RepositoryAdmission,
  prevented: boolean,
) {
  return claimPrivateIO(directory, { ioId: record.ioId, prevented });
}

export async function writeRepositoryIOStop(
  directory: FileHandle,
  record: RepositoryAdmission,
  outcome: Pick<RepositoryIOStop, "kind" | "code" | "interrupted" | "detail">,
) {
  const receipt = RepositoryIOStopSchema.parse({
    ioId: record.ioId,
    controllerLeaseId: record.controllerLeaseId,
    bindingDigest: repositoryIOBinding(record),
    operation: record.phase,
    stoppedAt: new Date().toISOString(),
    ...outcome,
  });
  await publishPrivateStop(directory, receipt);
  return receipt;
}

export async function readRepositoryIOStop(
  record: RepositoryAdmission,
): Promise<RepositoryIOStop | null> {
  const directory = await openRepositoryIO(record);
  try {
    const raw = await readPrivateStop(directory);
    if (raw === null) return null;
    const receipt = RepositoryIOStopSchema.parse(raw);
    assertRepositoryIOStop(record, receipt);
    return receipt;
  } finally {
    await directory.close();
  }
}

export function assertRepositoryIOStop(record: RepositoryAdmission, receipt: RepositoryIOStop) {
  if (
    receipt.ioId !== record.ioId ||
    receipt.controllerLeaseId !== record.controllerLeaseId ||
    receipt.bindingDigest !== repositoryIOBinding(record) ||
    receipt.operation !== record.phase
  )
    throw new Error("Repository stop receipt differs from the exact I/O intent");
}

/** May close an unused gate, but never infer termination from a missing process or ref. */
export async function recoverRepositoryIO(record: RepositoryAdmission) {
  const existing = await readRepositoryIOStop(record);
  if (existing) return existing;
  const directory = await openRepositoryIO(record);
  try {
    if (!(await claimRepositoryIO(directory, record, true))) return readRepositoryIOStop(record);
    return await writeRepositoryIOStop(directory, record, {
      kind: "not_started",
      code: null,
      interrupted: true,
      detail: null,
    });
  } finally {
    await directory.close();
  }
}

/** Fixed trusted operation, never a model-provided shell command. The supervisor outlives its caller. */
export async function runRepositoryIO(
  record: RepositoryAdmission,
  authority: ControllerAuthority,
  signal?: AbortSignal,
) {
  const request = RepositoryIORequestSchema.parse({ record, authority });
  const child = spawn(process.execPath, [entrypoint, "supervise"], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    detached: true,
    stdio: ["pipe", "ignore", "pipe", "pipe"],
    shell: false,
  });
  let diagnostics = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString("utf8")).slice(-4000);
  });
  const control = child.stdio[3] as Writable;
  const stop = () => control.end();
  control.on("error", () => {});
  child.stdin!.on("error", () => {});
  child.stdin!.end(JSON.stringify(request));
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  let failure: Error | undefined;
  child.once("error", (error) => {
    failure = error;
  });
  try {
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    // Supervisor death itself is never stop proof. It may have retained a receipt first.
    const receipt = await recoverRepositoryIO(record);
    if (!receipt)
      throw (
        failure ??
        new Error(
          `Repository I/O has no independent stop proof${diagnostics ? `: ${diagnostics}` : ""}`,
        )
      );
    return receipt;
  } finally {
    signal?.removeEventListener("abort", stop);
    control.destroy();
  }
}
