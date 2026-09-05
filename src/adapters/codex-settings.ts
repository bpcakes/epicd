import { CODEX_PROCESS_SHUTDOWN_MS, runCodexCommand, startCodexProcess } from "./codex-process.js";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { ModelIdSchema } from "../domain/types.js";
import { CommandError } from "../util/command.js";
import { redactSensitiveText } from "../util/redact.js";

const ConfigReadResponseSchema = z.object({
  id: z.literal(2),
  result: z.object({
    config: z.object({ model: ModelIdSchema.nullable().optional() }),
  }),
});

const ModelListResponseSchema = z.object({
  id: z.number().int().positive(),
  result: z.object({
    data: z.array(z.object({ model: ModelIdSchema, isDefault: z.boolean() })),
    nextCursor: z.string().min(1).nullable().optional(),
  }),
});

const RpcErrorResponseSchema = z.object({
  id: z.number().int().positive(),
  error: z.object({ message: z.string() }),
});

const APP_SERVER_TIMEOUT_MS = 10_000;
const MAX_MODEL_LIST_PAGES = 20;

class ModelDiscoveryFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelDiscoveryFailure";
  }
}

function discoveryFailure(
  message: string,
  retryable: boolean,
  cause?: unknown,
  stderr = "",
): ModelDiscoveryFailure {
  const causes = [
    ...(cause === undefined ? [] : [cause]),
    ...(stderr.trim() ? [new Error(redactSensitiveText(stderr.trim()))] : []),
  ];
  const combinedCause =
    causes.length === 0
      ? undefined
      : causes.length === 1
        ? causes[0]
        : new AggregateError(causes, "Codex app-server diagnostics");
  const detail = [
    ...(cause instanceof Error ? [cause.message] : cause === undefined ? [] : [String(cause)]),
    ...(stderr.trim() ? [stderr.trim()] : []),
  ]
    .map((value) => redactSensitiveText(value.replaceAll(/\s+/g, " ").trim(), 4_096))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("; ");
  return new ModelDiscoveryFailure(
    detail ? `${message}: ${detail}` : message,
    retryable,
    combinedCause === undefined ? undefined : { cause: combinedCause },
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export type CodexExecutable = {
  executablePath: string;
  args: string[];
};

export function resolveSdkCodexExecutable(): CodexExecutable {
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const packagePath = sdkRequire.resolve("@openai/codex/package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
  if (!bin) throw new Error("The SDK-pinned @openai/codex package has no Codex CLI entry point");
  const cliPath = join(dirname(packagePath), bin);
  if (!isFile(cliPath)) throw new Error(`The SDK-pinned Codex CLI is missing: ${cliPath}`);
  return { executablePath: process.execPath, args: [cliPath] };
}

export function resolveCodexExecutable(override?: string): CodexExecutable {
  if (!override) return resolveSdkCodexExecutable();
  const configuredPath = override.trim();
  if (!configuredPath) throw new Error("Configured Codex executable cannot be empty");
  const explicitPath =
    isAbsolute(configuredPath) || configuredPath.includes("/") || configuredPath.includes("\\");
  const executablePath = explicitPath ? resolve(configuredPath) : configuredPath;
  if (explicitPath && !isFile(executablePath)) {
    throw new Error(`Configured Codex executable does not exist: ${executablePath}`);
  }
  return { executablePath, args: [] };
}

export function codexProcessEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sourceEnvironment).flatMap(([key, value]) =>
      value === undefined ? [] : ([[key, value]] as const),
    ),
  );
}

export function codexExecutableLabel(executable: CodexExecutable): string {
  return [executable.executablePath, ...executable.args].join(" ");
}

export async function verifyCodexExecutable(
  cwd: string,
  executable: CodexExecutable,
): Promise<string> {
  try {
    const result = await runCodexCommand(
      executable.executablePath,
      [...executable.args, "--version"],
      {
        cwd,
        env: codexProcessEnvironment(),
        timeoutMs: 10_000,
      },
    );
    const version = result.stdout.trim() || result.stderr.trim();
    return version
      ? `${codexExecutableLabel(executable)} — ${version}`
      : codexExecutableLabel(executable);
  } catch (error) {
    if (!(error instanceof CommandError) || !error.result.stderr.trim()) throw error;
    throw new Error(
      `${error.message}: ${redactSensitiveText(error.result.stderr.replaceAll(/\s+/g, " ").trim())}`,
      { cause: error },
    );
  }
}

export type ResolveCodexModelOptions = {
  codexPath?: string;
  executable?: CodexExecutable;
  signal?: AbortSignal;
  timeoutMs?: number;
  attempts?: number;
};

/** Resolves the concrete model that a new Codex SDK thread would inherit. */
export async function resolveCodexModel(
  repoPath: string,
  options: ResolveCodexModelOptions = {},
): Promise<string> {
  const executable = options.executable ?? resolveCodexExecutable(options.codexPath);
  const attempts = options.attempts ?? 2;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Codex model resolution attempts must be a positive integer");
  }
  let lastError: unknown;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptsMade = attempt;
    try {
      return await resolveCodexModelOnce(repoPath, executable, options);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error("Codex model resolution was interrupted");
      }
      if (error instanceof ModelDiscoveryFailure && !error.retryable) break;
      if (attempt === attempts) break;
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `Unable to resolve the effective Codex model after ${attemptsMade} attempt${attemptsMade === 1 ? "" : "s"}${detail}; configure an explicit model or verify Codex app-server`,
    { cause: lastError },
  );
}

function resolveCodexModelOnce(
  repoPath: string,
  executable: CodexExecutable,
  options: ResolveCodexModelOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = startCodexProcess(
      executable.executablePath,
      [...executable.args, "app-server", "--listen", "stdio://"],
      repoPath,
      codexProcessEnvironment(),
    );
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
    });
    let settled = false;
    let modelRequestId = 2;
    let modelPagesRequested = 0;
    const seenModelCursors = new Set<string>();
    let transportFailure: ModelDiscoveryFailure | null = null;
    let transportFailureTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, model?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (transportFailureTimer) clearTimeout(transportFailureTimer);
      options.signal?.removeEventListener("abort", abort);
      lines.close();
      child.stop(() => {
        if (error) reject(error);
        else if (model) resolve(model);
        else
          reject(
            new ModelDiscoveryFailure("Codex did not report an effective default model", false),
          );
      });
      child.stdin.end();
    };
    const abort = (): void =>
      finish(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error("Codex model resolution was interrupted"),
      );
    // Codex app-server uses JSON-RPC semantics but intentionally omits the
    // `jsonrpc: "2.0"` header on its wire messages.
    const write = (message: unknown): void => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const rpcError = (message: unknown, operation: string): boolean => {
      const parsed = RpcErrorResponseSchema.safeParse(message);
      if (!parsed.success) return false;
      finish(
        discoveryFailure(
          `Codex app-server ${operation} failed`,
          false,
          new Error(redactSensitiveText(parsed.data.error.message)),
        ),
      );
      return true;
    };
    const requestModelPage = (cursor?: string): void => {
      modelPagesRequested += 1;
      if (modelPagesRequested > MAX_MODEL_LIST_PAGES) {
        finish(
          new ModelDiscoveryFailure(
            `Codex app-server model list exceeded ${MAX_MODEL_LIST_PAGES} pages`,
            false,
          ),
        );
        return;
      }
      modelRequestId += 1;
      write({
        id: modelRequestId,
        method: "model/list",
        params: { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) },
      });
    };

    const timer = setTimeout(
      () =>
        finish(
          new ModelDiscoveryFailure("Timed out while resolving the effective Codex model", true),
        ),
      options.timeoutMs ?? APP_SERVER_TIMEOUT_MS,
    );
    timer.unref();

    const deferTransportFailure = (failure: ModelDiscoveryFailure): void => {
      if (settled) return;
      transportFailure ??= failure;
      transportFailureTimer ??= setTimeout(
        () => finish(transportFailure ?? failure),
        CODEX_PROCESS_SHUTDOWN_MS,
      );
      transportFailureTimer.unref();
    };

    child.onError((error) =>
      deferTransportFailure(discoveryFailure("Could not start Codex app-server", true, error)),
    );
    child.stdin.on("error", (error) =>
      deferTransportFailure(discoveryFailure("Codex app-server input failed", true, error)),
    );
    child.stdout.on("error", (error) =>
      deferTransportFailure(discoveryFailure("Codex app-server output failed", true, error)),
    );
    child.stderr.on("error", (error) =>
      deferTransportFailure(discoveryFailure("Codex app-server diagnostics failed", true, error)),
    );
    child.onClose((code) => {
      if (settled) return;
      if (transportFailure) {
        finish(
          discoveryFailure(
            transportFailure.message,
            transportFailure.retryable,
            transportFailure.cause,
            stderr,
          ),
        );
        return;
      }
      finish(
        discoveryFailure(
          `Codex app-server exited with code ${code ?? "unknown"}`,
          // A process exit is a completed local failure, not a protocol request that asked
          // the client to retry. Transport errors and timeouts remain retryable.
          false,
          undefined,
          stderr,
        ),
      );
    });
    lines.on("line", (line) => {
      if (settled || !line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        finish(
          new ModelDiscoveryFailure("Codex app-server returned malformed JSON-RPC output", false),
        );
        return;
      }
      if (!message || typeof message !== "object" || !("id" in message) || "method" in message) {
        return;
      }
      const id = (message as { id?: unknown }).id;
      if (id === 1) {
        if (rpcError(message, "initialization")) return;
        write({ method: "initialized", params: {} });
        write({
          id: 2,
          method: "config/read",
          params: { cwd: repoPath, includeLayers: false },
        });
        return;
      }
      if (id === 2) {
        if (rpcError(message, "config/read")) return;
        const parsed = ConfigReadResponseSchema.safeParse(message);
        if (!parsed.success) {
          finish(
            new ModelDiscoveryFailure(
              "Codex app-server returned an invalid configuration response",
              false,
            ),
          );
          return;
        }
        if (parsed.data.result.config.model) {
          finish(undefined, parsed.data.result.config.model);
          return;
        }
        requestModelPage();
        return;
      }
      if (id !== modelRequestId) return;
      if (rpcError(message, "model/list")) return;
      const parsed = ModelListResponseSchema.safeParse(message);
      if (!parsed.success) {
        finish(new ModelDiscoveryFailure("Codex app-server returned an invalid model list", false));
        return;
      }
      const defaultModel = parsed.data.result.data.find((model) => model.isDefault)?.model;
      if (defaultModel) {
        finish(undefined, defaultModel);
        return;
      }
      const cursor = parsed.data.result.nextCursor;
      if (!cursor) {
        finish();
        return;
      }
      if (seenModelCursors.has(cursor)) {
        finish(
          new ModelDiscoveryFailure(
            "Codex app-server returned a repeated pagination cursor",
            false,
          ),
        );
        return;
      }
      seenModelCursors.add(cursor);
      requestModelPage(cursor);
    });

    if (options.signal?.aborted) abort();
    else {
      options.signal?.addEventListener("abort", abort, { once: true });
      write({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "epicd", version: "0.1.0" }, capabilities: {} },
      });
    }
  });
}
