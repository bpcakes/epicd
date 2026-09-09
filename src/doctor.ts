import { resolve } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { discoverHerdr, resolveExecutable, selectedCodexExecutable } from "./bootstrap.js";
import { verifyCodexExecutable } from "./adapters/codex-settings.js";
import { ORCHESTRATOR_MODEL, type RuntimeKind } from "./domain/types.js";

export type DoctorOptions = {
  repoPath: string;
  runtime: RuntimeKind;
  codexPath?: string;
};

export type DoctorReport = {
  runtime: RuntimeKind;
  executable: string;
  version: string;
  orchestratorModel: typeof ORCHESTRATOR_MODEL;
  defaultReasoning: "high";
  fallback: false;
  herdr: Awaited<ReturnType<typeof discoverHerdr>> | null;
  warning: string;
};

export class DoctorCheckFailed extends Data.TaggedError("DoctorCheckFailed")<{
  readonly stage: "select_executable" | "verify_version" | "resolve_herdr" | "discover_herdr";
  readonly cause: unknown;
}> {}

function check<A>(stage: DoctorCheckFailed["stage"], run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new DoctorCheckFailed({ stage, cause }),
  });
}

/** Helpers own their deadlines; fiber interruption does not drain their underlying I/O. */
export function doctorEffect(
  options: DoctorOptions,
): Effect.Effect<DoctorReport, DoctorCheckFailed> {
  return Effect.gen(function* () {
    const cwd = resolve(options.repoPath);
    const executable = yield* check("select_executable", () =>
      selectedCodexExecutable(options.runtime, options.codexPath),
    );
    const version = yield* check("verify_version", () =>
      verifyCodexExecutable(cwd, { executablePath: executable, args: [] }),
    );
    let herdr: DoctorReport["herdr"] = null;
    if (options.runtime === "herdr") {
      const herdrExecutable = yield* check("resolve_herdr", () => resolveExecutable("herdr"));
      herdr = yield* check("discover_herdr", () => discoverHerdr(herdrExecutable, cwd));
    }
    return {
      runtime: options.runtime,
      executable,
      version,
      orchestratorModel: ORCHESTRATOR_MODEL,
      defaultReasoning: "high" as const,
      fallback: false as const,
      herdr,
      warning:
        "Executable/endpoint checks only. These checks do not prove authentication, confinement, model result admission or epic delivery.",
    };
  });
}

/** Read-only availability checks. Successful checks do not certify a model request or delivery. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const outcome = await Effect.runPromise(Effect.result(doctorEffect(options)));
  // Keep the Promise/CLI rejection contract; only Effect callers receive the stage wrapper.
  if (Result.isFailure(outcome)) throw outcome.failure.cause;
  return outcome.success;
}
