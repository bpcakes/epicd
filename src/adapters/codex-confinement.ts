import { lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const CODEX_PERMISSION_PROFILE = "epicd-isolated";
const PROTECTED_SOURCE = [".git", ".beads", ".epicd", ".codex", "AGENTS.md"];

export type CodexConfinement = {
  /** Exact native executable: Codex re-execs it inside its command sandbox. */
  executable: string;
  workspace: string;
  sourceMode: "read-only" | "workspace-write";
  /** Private Codex state/config/auth directory, never a workspace or a tool-readable directory. */
  providerHome: string;
  /** Private tool HOME/TMPDIR, not the provider's home or the user's /tmp. */
  scratch: string;
  /** Exact generation-owned output directory for the native result envelope. */
  artifacts: string;
};

/**
 * Local-command policy, not a complete runtime-admission certificate. The agent
 * additionally requires an outer filesystem/PID boundary and a verified stop owner.
 * Deliberately omit legacy sandbox_mode: --sandbox would override this profile.
 */
export function codexConfinementConfig(input: CodexConfinement): string {
  const spec = validatePaths(input);
  const quoted = (value: string) => JSON.stringify(value);
  const filesystem: Record<string, "read" | "write" | "deny"> = {
    ":root": "deny",
    ":minimal": "read",
    // Resolved from the tool environment below, so this is the private scratch
    // directory, not the host TMPDIR. A deny here overrides its explicit grant.
    ":tmpdir": "write",
    ":slash_tmp": "deny",
    [spec.executable]: "read",
    [spec.workspace]: spec.sourceMode === "read-only" ? "read" : "write",
    [spec.scratch]: "write",
    [spec.artifacts]: "write",
  };
  for (const path of PROTECTED_SOURCE) filesystem[join(spec.workspace, path)] = "read";
  return [
    `default_permissions = ${quoted(CODEX_PERMISSION_PROFILE)}`,
    'approval_policy = "never"',
    'web_search = "disabled"',
    'cli_auth_credentials_store = "file"',
    "project_doc_max_bytes = 0",
    "allow_login_shell = false",
    "[features]",
    // Current Codex uses this local tool host even when code-mode aggregation is off.
    // Its executable lives inside the outer boundary; local commands still use this profile.
    "code_mode_host = true",
    ...[
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "code_mode",
      "goals",
      "hooks",
      "image_generation",
      "in_app_browser",
      "multi_agent",
      "multi_agent_v2",
      "plugins",
      "remote_plugin",
      "shell_snapshot",
      "skill_mcp_dependency_install",
      "skill_search",
      "tool_suggest",
      "view_image",
    ].map((feature) => `${feature} = false`),
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    "[shell_environment_policy.set]",
    'PATH = "/usr/bin:/bin"',
    `HOME = ${quoted(spec.scratch)}`,
    `TMPDIR = ${quoted(spec.scratch)}`,
    'LANG = "C.UTF-8"',
    `[projects.${quoted(spec.workspace)}]`,
    'trust_level = "untrusted"',
    `[permissions.${quoted(CODEX_PERMISSION_PROFILE)}.filesystem]`,
    ...Object.entries(filesystem).map(([path, access]) => `${quoted(path)} = ${quoted(access)}`),
    `[permissions.${quoted(CODEX_PERMISSION_PROFILE)}.network]`,
    "enabled = false",
    "",
  ].join("\n");
}

/** Create once in kernel-owned storage. Never overwrite provider/user configuration on resume. */
export async function writeCodexConfinement(input: CodexConfinement): Promise<string> {
  const spec = validatePaths(input);
  const binary = await lstat(spec.executable);
  if (
    !binary.isFile() ||
    binary.isSymbolicLink() ||
    (await realpath(spec.executable)) !== spec.executable
  )
    throw new Error("Codex confinement needs a canonical native executable");
  for (const path of [spec.workspace, spec.providerHome, spec.scratch, spec.artifacts]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Codex confinement paths must be canonical private directories");
  }
  const path = join(spec.providerHome, "config.toml");
  await writeFile(path, codexConfinementConfig(spec), { flag: "wx", mode: 0o600 });
  return path;
}

function validatePaths(input: CodexConfinement): CodexConfinement {
  const spec = structuredClone(input);
  const paths = [spec.workspace, spec.providerHome, spec.scratch, spec.artifacts];
  if (
    !isAbsolute(spec.executable) ||
    resolve(spec.executable) !== spec.executable ||
    spec.executable.includes("\0")
  )
    throw new Error("Codex confinement needs an explicit executable path");
  if (
    [spec.workspace, spec.scratch, spec.artifacts].some((path) => contains(path, spec.executable))
  )
    throw new Error("Codex executable must be outside agent-writable storage");
  if (spec.sourceMode !== "read-only" && spec.sourceMode !== "workspace-write")
    throw new Error("Unknown Codex confinement source mode");
  for (const path of paths) {
    if (!isAbsolute(path) || resolve(path) !== path || path === "/" || path.includes("\0"))
      throw new Error("Codex confinement requires explicit bounded absolute paths");
  }
  for (let i = 0; i < paths.length; i += 1)
    for (let j = i + 1; j < paths.length; j += 1) {
      if (contains(paths[i]!, paths[j]!) || contains(paths[j]!, paths[i]!))
        throw new Error("Codex source, credentials, scratch, and results must not overlap");
    }
  return spec;
}
function contains(root: string, child: string): boolean {
  const path = relative(root, child);
  return path === "" || (!path.startsWith("../") && !isAbsolute(path));
}
