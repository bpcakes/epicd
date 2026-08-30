import { spawn } from "node:child_process";
import { redactSensitiveText } from "./redact.js";

export type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string;
};

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    const invocation = redactSensitiveText(`${result.command} ${result.args.join(" ")}`, 2_000);
    super(`${invocation} failed with exit code ${result.exitCode}`);
    this.name = "CommandError";
    this.result = result;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });

    let stdout = "";
    let stderr = "";
    const outputLimit = 32 * 1024 * 1024;
    let stopping = false;
    let forceKill: NodeJS.Timeout | undefined;
    const stop = (reason: string) => {
      if (stopping) return;
      stopping = true;
      stderr += `${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}${reason}\n`;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > outputLimit) stop(`Output exceeded ${outputLimit} bytes`);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > outputLimit) stop(`Output exceeded ${outputLimit} bytes`);
    });

    const timeoutMs = options.timeoutMs ?? 120_000;
    const timeout = setTimeout(() => stop(`Timed out after ${timeoutMs}ms`), timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      const result: CommandResult = {
        command,
        args,
        exitCode: code ?? (signal ? 128 : 1),
        stdout,
        stderr,
      };
      if (result.exitCode === 0) resolve(result);
      else reject(new CommandError(result));
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export type JsonParser<Result> = {
  parse(value: unknown): Result;
};

export function runJson(command: string, args: string[], options: CommandOptions): Promise<unknown>;
export function runJson<Result>(
  command: string,
  args: string[],
  options: CommandOptions,
  parser: JsonParser<Result>,
): Promise<Result>;
export async function runJson(
  command: string,
  args: string[],
  options: CommandOptions,
  parser?: JsonParser<unknown>,
): Promise<unknown> {
  const result = await runCommand(command, args, options);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${command} returned invalid JSON`);
  }
  return parser ? parser.parse(value) : value;
}
