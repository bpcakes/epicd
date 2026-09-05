import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { BeadsClient } from "./adapters/beads.js";
import { GitClient } from "./adapters/git.js";
import {
  resolveCodexExecutable,
  resolveCodexModel,
  resolveSdkCodexExecutable,
  verifyCodexExecutable,
  type CodexExecutable,
} from "./adapters/codex-settings.js";
import type { DoctorCheck, RuntimeKind } from "./domain/types.js";
import { runCommand } from "./util/command.js";

export type DoctorMode = "workflow" | "cleanup" | "selection";

export async function runDoctor(
  repoInput: string,
  runtime: RuntimeKind = "sdk",
  options: { probeModelDiscovery?: boolean; mode?: DoctorMode; codexPath?: string } = {},
): Promise<{ repoPath: string; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const mode = options.mode ?? "workflow";
  const cleanupOnly = mode === "cleanup";
  const checkRuntime = mode !== "selection";
  let repoPath = resolve(repoInput);
  let sdkExecutable: CodexExecutable | null = null;
  if (checkRuntime && runtime === "sdk") {
    try {
      const candidate = options.codexPath
        ? resolveCodexExecutable(options.codexPath)
        : resolveSdkCodexExecutable();
      const runtimeDescription = await verifyCodexExecutable(process.cwd(), candidate);
      sdkExecutable = candidate;
      checks.push({
        name: "Codex SDK runtime",
        status: "pass",
        message: runtimeDescription,
      });
    } catch (error) {
      checks.push({
        name: "Codex SDK runtime",
        status: cleanupOnly ? "warn" : "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (runtime === "herdr" && options.codexPath) {
    checks.push({
      name: "Codex executable override",
      status: "fail",
      message: "--codex-path applies only to the sdk runtime",
    });
  }

  try {
    repoPath = await new GitClient(repoPath).root();
    checks.push({ name: "Git repository", status: "pass", message: repoPath });
  } catch (error) {
    checks.push({
      name: "Git repository",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
    return { repoPath, checks };
  }

  if (sdkExecutable && options.probeModelDiscovery) {
    try {
      const model = await resolveCodexModel(repoPath, { executable: sdkExecutable });
      checks.push({
        name: "Codex SDK model discovery",
        status: "pass",
        message: model,
      });
    } catch (error) {
      checks.push({
        name: "Codex SDK model discovery",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!cleanupOnly) {
    try {
      await access(resolve(repoPath, ".beads"), constants.R_OK | constants.W_OK);
      checks.push({
        name: "Beads workspace",
        status: "pass",
        message: ".beads is readable and writable",
      });
    } catch {
      checks.push({
        name: "Beads workspace",
        status: "fail",
        message: `${repoPath}/.beads is missing or inaccessible`,
      });
    }

    try {
      const versions = await new BeadsClient(repoPath).versions();
      checks.push({ name: "br", status: "pass", message: versions.br });
      checks.push({ name: "bv", status: "pass", message: versions.bv });
    } catch (error) {
      checks.push({
        name: "Beads tools",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (checkRuntime && runtime === "herdr") {
    checks.push(
      process.env.HERDR_ENV === "1"
        ? { name: "Herdr environment", status: "pass", message: "HERDR_ENV=1" }
        : {
            name: "Herdr environment",
            status: cleanupOnly ? "warn" : "fail",
            message: cleanupOnly
              ? "HERDR_ENV is not required for cleanup through the running Herdr server"
              : "Launch epicd from a Herdr pane before selecting --runtime herdr",
          },
    );
    try {
      const version = await runCommand("herdr", ["--version"], { cwd: repoPath });
      await runCommand("herdr", cleanupOnly ? ["agent", "list"] : ["pane", "current"], {
        cwd: repoPath,
      });
      checks.push({ name: "Herdr", status: "pass", message: version.stdout.trim() });
    } catch (error) {
      checks.push({
        name: "Herdr",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!cleanupOnly) {
      try {
        const integration = await runCommand("herdr", ["integration", "status"], {
          cwd: repoPath,
        });
        const codex = integration.stdout
          .split("\n")
          .find((line) => line.trimStart().startsWith("codex:"));
        checks.push(
          codex?.includes("current")
            ? { name: "Herdr Codex integration", status: "pass", message: codex.trim() }
            : {
                name: "Herdr Codex integration",
                status: "fail",
                message: codex?.trim() || "Codex integration was not reported",
              },
        );
      } catch (error) {
        checks.push({
          name: "Herdr Codex integration",
          status: "fail",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (mode === "workflow") {
    try {
      const version = await runCommand("codex", ["--version"], { cwd: repoPath });
      checks.push({ name: "Codex", status: "pass", message: version.stdout.trim() });
    } catch (error) {
      checks.push({
        name: "Codex CLI",
        status: runtime === "herdr" ? "fail" : "warn",
        message:
          runtime === "herdr"
            ? `Herdr agents require the Codex CLI. ${error instanceof Error ? error.message : String(error)}`
            : `System CLI was not found; the SDK-bundled runtime will be used. ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (!cleanupOnly) {
    const status = await new GitClient(repoPath).status();
    checks.push({
      name: "Working tree",
      status: status.trim() ? "warn" : "pass",
      message: status.trim() ? "Dirty; a new run will wait until it is clean" : "Clean",
    });
  }
  return { repoPath, checks };
}
