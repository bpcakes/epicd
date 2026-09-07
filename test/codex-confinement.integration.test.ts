import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { CommandError, runCommand } from "../src/util/command.js";
import {
  codexConfinementConfig,
  writeCodexConfinement,
  CODEX_PERMISSION_PROFILE,
  type CodexConfinement,
} from "../src/adapters/codex-confinement.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(sourceMode: CodexConfinement["sourceMode"] = "read-only") {
  const root = await mkdtemp(
    join(
      process.platform === "linux" && process.env.EPICD_CODEX_CONFINEMENT === "1"
        ? "/var/tmp"
        : tmpdir(),
      "epicd-codex-policy-",
    ),
  );
  roots.push(root);
  const spec: CodexConfinement = {
    executable: await realpath(
      process.env.EPICD_TEST_CODEX_PATH ??
        (process.env.EPICD_CODEX_CONFINEMENT === "1"
          ? join(
              dirname(
                createRequire(import.meta.url).resolve("@openai/codex-linux-x64/package.json"),
              ),
              "vendor/x86_64-unknown-linux-musl/bin/codex",
            )
          : process.execPath),
    ),
    workspace: join(root, "workspace"),
    providerHome: join(root, "provider"),
    scratch: join(root, "scratch"),
    artifacts: join(root, "artifacts"),
    sourceMode,
  };
  for (const path of [spec.workspace, spec.providerHome, spec.scratch, spec.artifacts])
    await mkdir(path, { mode: 0o700 });
  await mkdir(join(spec.workspace, ".git"));
  await mkdir(join(spec.workspace, ".beads"));
  await mkdir(join(spec.workspace, ".epicd"));
  await mkdir(join(spec.workspace, ".codex"));
  await copyFile(process.execPath, join(spec.workspace, "fixture-node"));
  for (const path of [
    "source.js",
    ".git/config",
    ".beads/issues.jsonl",
    ".epicd/policy.json",
    "AGENTS.md",
  ])
    await writeFile(join(spec.workspace, path), "original");
  // This hostile project configuration must not override the kernel's selected profile.
  await writeFile(
    join(spec.workspace, ".codex/config.toml"),
    'sandbox_mode = "danger-full-access"\n',
  );
  await writeFile(join(spec.providerHome, "auth.json"), '{"secret":"test-only-sentinel"}');
  await writeFile(join(root, "operator.txt"), "user-owned");
  await symlink(join(root, "operator.txt"), join(spec.workspace, "escape"));
  await writeCodexConfinement(spec);
  async function command(script: string) {
    const outputPath = join(spec.artifacts, "command-output");
    const output = await runCommand(
      spec.executable,
      [
        "sandbox",
        "-P",
        CODEX_PERMISSION_PROFILE,
        "-C",
        spec.workspace,
        "--",
        "/bin/sh",
        "-c",
        'exec "$1" -e "$2" > "$3"',
        "epicd-confinement-check",
        join(spec.workspace, "fixture-node"),
        script,
        outputPath,
      ],
      {
        cwd: spec.workspace,
        env: { PATH: process.env.PATH, CODEX_HOME: spec.providerHome, HOME: spec.providerHome },
        timeoutMs: 10_000,
      },
    ).catch((error: unknown) => {
      if (error instanceof CommandError) throw new Error(error.result.stderr, { cause: error });
      throw error;
    });
    // The inspected CLI captures rather than forwards command stdout. Require an actual
    // confined output file; exit 0 by itself is never evidence that the probe executed.
    return { ...output, stdout: await readFile(outputPath, "utf8") };
  }
  return { root, spec, command };
}

// Explicit installed-runtime contract check. A missing runtime is not a passing admission proof.
// It is opt-in for normal CI, which must not depend on a separately installed native Codex.
describe.skipIf(process.platform !== "linux" || process.env.EPICD_CODEX_CONFINEMENT !== "1")(
  "native Codex permission enforcement",
  () => {
    it.each(["read-only", "workspace-write"] as const)(
      "enforces %s source and protects credentials, Git, Beads and host files",
      async (sourceMode) => {
        const { root, spec, command } = await fixture(sourceMode);
        const writes = [
          "source.js",
          ".git/config",
          ".beads/issues.jsonl",
          ".epicd/policy.json",
          ".codex/config.toml",
          "AGENTS.md",
          join(spec.providerHome, "config.toml"),
        ];
        const reads = [join(root, "operator.txt"), "escape", join(spec.providerHome, "auth.json")];
        const outsideWrites = ["escape", join(root, "operator.txt")];
        const output = await command(`
      const fs = require('node:fs');
      const reads = ${JSON.stringify(reads)}.map(path => { try { fs.readFileSync(path); return true; } catch { return false; } });
      const writes = ${JSON.stringify(writes)}.map(path => { try { fs.writeFileSync(path, 'changed'); return true; } catch { return false; } });
      // Bubblewrap constructs private ancestor directories for its mounts. A write
      // there may create an ephemeral file, including through the source symlink.
      // The host-side sentinel below distinguishes that from changing a host file.
      for (const path of ${JSON.stringify(outsideWrites)}) {
        try { fs.writeFileSync(path, 'changed'); } catch {}
      }
      fs.writeFileSync(${JSON.stringify(join(spec.scratch, "build"))}, 'scratch');
      fs.writeFileSync(${JSON.stringify(join(spec.artifacts, "result"))}, 'result');
      console.log(JSON.stringify({writes, reads}));
    `);
        expect(await readFile(join(root, "operator.txt"), "utf8")).toBe("user-owned");
        expect(JSON.parse(output.stdout)).toEqual({
          writes: writes.map((_, index) => index === 0 && sourceMode === "workspace-write"),
          reads: [false, false, false],
        });
        expect(await readFile(join(spec.workspace, ".git/config"), "utf8")).toBe("original");
        expect(await readFile(join(spec.scratch, "build"), "utf8")).toBe("scratch");
        expect(await readFile(join(spec.artifacts, "result"), "utf8")).toBe("result");
        expect(await readFile(join(spec.workspace, "source.js"), "utf8")).toBe(
          sourceMode === "workspace-write" ? "changed" : "original",
        );
      },
    );

    it("denies a connection to an undeclared host service", async () => {
      const { command } = await fixture();
      let connections = 0;
      const server = createServer((socket) => {
        connections += 1;
        socket.end("host-secret");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
      try {
        const output = await command(`
        const net = require('node:net');
        const socket = net.connect(${address.port}, '127.0.0.1');
        socket.on('connect', () => { console.log('escaped'); socket.destroy(); });
        socket.on('error', () => console.log('denied'));
        socket.setTimeout(2000, () => { console.log('denied'); socket.destroy(); });
      `);
        expect(output.stdout).toBe("denied\n");
        expect(connections).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  },
);

describe("Codex confinement configuration", () => {
  it("does not combine profiles with legacy sandbox configuration or grant credential access", async () => {
    const { spec } = await fixture();
    const config = codexConfinementConfig(spec);
    expect(config).not.toContain("sandbox_mode");
    expect(config).not.toContain("sandbox_workspace_write");
    expect(config).toContain('trust_level = "untrusted"');
    expect(config).toContain('\":root\" = "deny"');
    expect(config).not.toContain(`${JSON.stringify(spec.providerHome)} = "read"`);
    expect(config).not.toContain(`${JSON.stringify(spec.providerHome)} = "write"`);
    await expect(writeCodexConfinement(spec)).rejects.toThrow("EEXIST");
  });
  it("rejects overlapping credentials, source, scratch and result directories", async () => {
    const { spec } = await fixture();
    expect(() => codexConfinementConfig({ ...spec, scratch: spec.providerHome })).toThrow(
      "overlap",
    );
    expect(() =>
      codexConfinementConfig({ ...spec, artifacts: join(spec.workspace, "artifacts") }),
    ).toThrow("overlap");
  });
});
