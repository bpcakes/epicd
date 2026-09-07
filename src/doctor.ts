import { resolve } from "node:path";
import { discoverHerdr, resolveExecutable, sdkNativeExecutable } from "./bootstrap.js";
import { verifyCodexExecutable } from "./adapters/codex-settings.js";
import { ORCHESTRATOR_MODEL, type RuntimeKind } from "./domain/types.js";

/** Read-only availability checks. Successful checks do not certify a model request or delivery. */
export async function runDoctor(options: {
  repoPath: string;
  runtime: RuntimeKind;
  codexPath?: string;
}) {
  const cwd = resolve(options.repoPath);
  const executable = options.codexPath
    ? await resolveExecutable(options.codexPath)
    : options.runtime === "sdk"
      ? await sdkNativeExecutable()
      : await resolveExecutable("codex");
  const version = await verifyCodexExecutable(cwd, { executablePath: executable, args: [] });
  const herdr =
    options.runtime === "herdr" ? await discoverHerdr(await resolveExecutable("herdr"), cwd) : null;
  return {
    runtime: options.runtime,
    executable,
    version,
    orchestratorModel: ORCHESTRATOR_MODEL,
    defaultReasoning: "high",
    fallback: false,
    herdr,
    warning:
      "Executable/endpoint checks only. Authentication, confinement and model result admission are verified by the controlled launch; final epic completion remains unavailable.",
  };
}
