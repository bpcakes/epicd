import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindFixtureProvider } from "../src/adapters/fixtures.js";
import { FixtureDefinitionSchema } from "../src/domain/repository-policy.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-fixture-provider-");
  roots.push(root);
  const sockets = join(root, "sockets");
  mkdirSync(sockets);
  const definition = FixtureDefinitionSchema.parse({
    id: "db",
    provider: "postgresql",
    socketDirectory: sockets,
    port: 5432,
    role: "fixture",
    database: "disposable",
    expectedOwner: "fixture",
    operations: ["create"],
    environmentBinding: "test",
    cleanup: "retain",
  });
  return { root, definition };
}
describe.runIf(process.platform === "linux")("fixture provider file admission", () => {
  it("pins native file bytes and distinguishes an absent socket without opening a server connection", async () => {
    const f = fixture();
    // This is an ELF binding test, not a psql invocation or provider certification.
    const binding = await bindFixtureProvider(f.definition, "/usr/bin/true");
    expect(binding).toMatchObject({
      directory: { path: f.definition.socketDirectory },
      socket: null,
      executable: { path: "/usr/bin/true", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(await bindFixtureProvider(f.definition, "/usr/bin/true")).toEqual(binding);
  });
  it("rejects wrappers and executable/socket-directory symlink aliases", async () => {
    const f = fixture(),
      wrapper = join(f.root, "wrapper"),
      executableLink = join(f.root, "executable-link"),
      directoryLink = join(f.root, "directory-link");
    writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    symlinkSync("/usr/bin/true", executableLink);
    symlinkSync(f.definition.socketDirectory, directoryLink);
    await expect(bindFixtureProvider(f.definition, wrapper)).rejects.toThrow("native ELF");
    await expect(bindFixtureProvider(f.definition, executableLink)).rejects.toThrow(
      "canonical native",
    );
    await expect(
      bindFixtureProvider({ ...f.definition, socketDirectory: directoryLink }, "/usr/bin/true"),
    ).rejects.toThrow("symlink aliases");
  });
  it("rejects a provider FIFO without waiting for a writer", () => {
    const f = fixture(),
      fifo = join(f.root, "provider-fifo");
    execFileSync("/usr/bin/mkfifo", ["--", fifo]);
    // Separate bounded process: a regression cannot strand Vitest's libuv pool or cleanup.
    const script = `import { bindFixtureProvider } from './dist/adapters/fixtures.js';
      try { await bindFixtureProvider(JSON.parse(process.argv[1]), process.argv[2]); process.exitCode = 1; }
      catch (error) { process.stdout.write(error.message); }`;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify(f.definition), fifo],
      { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" },
    );
    expect(output).toContain("bounded native fixture executable");
  });
});
