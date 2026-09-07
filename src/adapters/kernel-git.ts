import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { redactSensitiveText } from "../util/redact.js";

const CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "core.autocrlf=false",
  "core.quotePath=false",
  "core.pager=cat",
  "gc.auto=0",
  "maintenance.auto=false",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "user.name=Epicd",
  "user.email=epicd@epicd.local",
  "protocol.allow=never",
  "protocol.file.allow=always",
];
export type KernelGitOptions = {
  input?: Buffer | string;
  indexPath?: string;
  signal?: AbortSignal;
  allowedExitCodes?: readonly number[];
  // Trusted update-ref transaction only: inspect while refs are prepared/locked.
  beforeRefCommit?: (signal: AbortSignal) => Promise<void>;
};
export class KernelGitError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly detail: string,
  ) {
    super(
      `Kernel Git failed (${exitCode ?? "no exit status"}): ${redactSensitiveText(detail, 2000)}`,
    );
    this.name = "KernelGitError";
  }
}

/** Trusted plumbing only. Never expose this raw command surface to a model. */
export class KernelGit {
  constructor(
    readonly path: string,
    private readonly gitDirectory?: string,
  ) {
    if (!isAbsolute(path)) throw new Error("Kernel Git requires an absolute repository path");
    if (gitDirectory && !isAbsolute(gitDirectory))
      throw new Error("Git metadata path must be absolute");
  }

  async text(args: readonly string[], options: KernelGitOptions = {}): Promise<string> {
    return new TextDecoder("utf-8", { fatal: true }).decode(await this.bytes(args, options));
  }

  /** No shell, inherited Git environment, user/system config, filters, or optional lock writes. */
  async bytes(args: readonly string[], options: KernelGitOptions = {}): Promise<Buffer> {
    options.signal?.throwIfAborted();
    if (
      options.beforeRefCommit &&
      (args[0] !== "update-ref" ||
        !args.includes("--stdin") ||
        typeof options.input !== "string" ||
        !options.input.startsWith("start\n") ||
        !options.input.endsWith("prepare\n") ||
        options.input.includes("\0") ||
        options.input
          .split("\n")
          .slice(1, -2)
          .some(
            (line) => !/^(?:option no-deref|(?:create|update|verify|delete) [^\r\n]+)$/.test(line),
          ))
    )
      throw new Error(
        "Prepared transaction guard requires a single explicit update-ref transaction",
      );
    const env = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      ...(options.indexPath ? { GIT_INDEX_FILE: options.indexPath } : {}),
    };
    return await new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "--no-optional-locks",
          ...CONFIG.flatMap((value) => ["-c", value]),
          "-C",
          this.path,
          ...(this.gitDirectory ? [`--git-dir=${this.gitDirectory}`] : []),
          ...args,
        ],
        { env, stdio: ["pipe", "pipe", "pipe"], shell: false },
      );
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let size = 0;
      let errorSize = 0;
      let failure: Error | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      let exited = false;
      const guardController = new AbortController();
      let guard: Promise<void> | null = null;
      let commitRequested = false;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        guardController.abort(error);
        if (!exited) {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (!exited) child.kill("SIGKILL");
          }, 500);
        }
      };
      const abort = () => stop(new Error("Kernel Git was interrupted"));
      const timer = setTimeout(
        () => stop(new Error("Kernel Git exceeded its 120-second deadline")),
        120000,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdout.on("data", (data: Buffer) => {
        size += data.length;
        if (size > 64 * 1024 * 1024) stop(new Error("Kernel Git output exceeds 64 MiB"));
        else output.push(data);
        if (
          options.beforeRefCommit &&
          !guard &&
          !failure &&
          !exited &&
          Buffer.concat(output).toString("utf8") === "start: ok\nprepare: ok\n"
        ) {
          guard = Promise.resolve()
            .then(() => {
              guardController.signal.throwIfAborted();
              return options.beforeRefCommit!(guardController.signal);
            })
            .then(() => {
              if (!failure && !exited) {
                commitRequested = true;
                child.stdin.end("commit\n");
              }
            })
            .catch((error: unknown) =>
              stop(error instanceof Error ? error : new Error("Ref transaction guard failed")),
            );
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        errorSize += data.length;
        if (errorSize <= 65536) errors.push(data);
        else stop(new Error("Kernel Git error output exceeds 64 KiB"));
      });
      child.on("error", (error) => {
        failure ??= error;
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stop(error);
      });
      child.once("exit", () => {
        exited = true;
      });
      child.once("close", async (code) => {
        guardController.abort(new Error("Git process stopped"));
        await guard;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (
          options.beforeRefCommit &&
          (code !== 0 ||
            !commitRequested ||
            Buffer.concat(output).toString("utf8") !== "start: ok\nprepare: ok\ncommit: ok\n")
        )
          reject(
            new KernelGitError(
              code,
              `Prepared ref transaction was not acknowledged: ${Buffer.concat(errors).toString("utf8")}`,
            ),
          );
        else if (code !== null && (options.allowedExitCodes ?? [0]).includes(code))
          resolve(Buffer.concat(output));
        else reject(new KernelGitError(code, Buffer.concat(errors).toString("utf8")));
      });
      if (options.beforeRefCommit) child.stdin.write(options.input);
      else child.stdin.end(options.input);
    });
  }
}
