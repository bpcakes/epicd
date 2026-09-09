import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Real discovery commands with no model, external endpoint, or host PATH dependency. */
export function doctorFixture(
  options: {
    versionFails?: boolean;
    incompatible?: boolean;
    ambiguous?: boolean;
    malformedSessions?: boolean;
    invalidPane?: boolean;
  } = {},
) {
  const root = mkdtempSync("/var/tmp/epicd-doctor-");
  const repo = join(root, "repository with spaces");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(repo, "user.txt"), "user-owned content\n");
  const log = join(root, "invocations.log");
  writeFileSync(log, "");
  const codex = join(bin, "codex");
  writeFileSync(
    codex,
    `#!/bin/sh
printf '%s\\n' "codex $*" >> "$EPICD_DOCTOR_LOG"
test "$#" = 1 && test "$1" = --version || exit 9
${options.versionFails ? "printf '%s\\n' 'token=doctor-test-secret version unavailable' >&2\nexit 7" : "printf '%s\\n' 'codex-cli fixture'"}
`,
    { mode: 0o700 },
  );
  const herdr = join(bin, "herdr");
  const session = { name: "owned", running: true, socket_path: "/fixture/socket" };
  const sessions = options.malformedSessions
    ? "{"
    : JSON.stringify({
        sessions: options.ambiguous ? [session, { ...session, name: "other" }] : [session],
      });
  const pane = JSON.stringify({
    result: { pane: { workspace_id: options.invalidPane ? "" : "fixture-workspace" } },
  });
  writeFileSync(
    herdr,
    `#!/bin/sh
printf '%s\\n' "herdr $*" >> "$EPICD_DOCTOR_LOG"
case "$*" in
  'status server') printf 'compatible: ${options.incompatible ? "no" : "yes"}\\nsocket: /fixture/socket\\n';;
  'session list --json') printf '%s\\n' '${sessions}';;
  'pane current --current') printf '%s\\n' '${pane}';;
  *) exit 9;;
esac
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: bin,
    HERDR_ENV: "1",
    EPICD_DOCTOR_LOG: log,
    XDG_STATE_HOME: join(root, "state"),
  };
  return {
    root,
    repo,
    codex,
    herdr,
    env,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    // Include directory entries so creating an empty state/resource directory is observable too.
    snapshot: () =>
      readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((name) => name !== "invocations.log")
        .sort()
        .map((name) => [
          name,
          statSync(join(root, name)).isDirectory() ? null : readFileSync(join(root, name), "utf8"),
        ]),
    cli: (runtime: "sdk" | "herdr" = "sdk") =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
          "doctor",
          "--repo",
          repo,
          "--runtime",
          runtime,
          "--codex-path",
          codex,
        ],
        { cwd: repo, env, encoding: "utf8", timeout: 10_000 },
      ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
