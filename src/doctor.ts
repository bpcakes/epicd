import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { BeadsClient } from "./adapters/beads.js";
import { GitClient } from "./adapters/git.js";
import type { DoctorCheck, RuntimeKind } from "./domain/types.js";
import { runCommand } from "./util/command.js";

export async function runDoctor(
  repoInput: string,
  runtime: RuntimeKind = "sdk",
): Promise<{ repoPath: string; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  let repoPath = resolve(repoInput);
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

  if (runtime === "herdr") {
    checks.push(
      process.env.HERDR_ENV === "1"
        ? { name: "Herdr environment", status: "pass", message: "HERDR_ENV=1" }
        : {
            name: "Herdr environment",
            status: "fail",
            message: "Launch epicd from a Herdr pane before selecting --runtime herdr",
          },
    );
    try {
      const version = await runCommand("herdr", ["--version"], { cwd: repoPath });
      await runCommand("herdr", ["pane", "current"], { cwd: repoPath });
      checks.push({ name: "Herdr", status: "pass", message: version.stdout.trim() });
    } catch (error) {
      checks.push({
        name: "Herdr",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
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

  const status = await new GitClient(repoPath).status();
  checks.push({
    name: "Working tree",
    status: status.trim() ? "warn" : "pass",
    message: status.trim() ? "Dirty; a new run will wait until it is clean" : "Clean",
  });
  return { repoPath, checks };
}
