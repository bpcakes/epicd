import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { nativeShellBootstrap } from "../src/adapters/controlled-herdr.js";
import { runCommand } from "../src/util/command.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture() {
  const root = await mkdtemp("/var/tmp/epicd-native-shell-");
  roots.push(root);
  return { root, ready: join(root, "shell's ready marker"), generation: "exact-generation" };
}

describe.runIf(process.platform === "linux")("native shell setup publication", () => {
  it("never exposes an incomplete generation, even when the write is suspended after open", async () => {
    const { root, ready, generation } = await fixture();
    const opened = join(root, "opened"),
      gate = join(root, "release");
    // POSIX redirection opens the destination before calling printf. Suspend
    // there deterministically to test the actual production bootstrap's race.
    const script = [
      `printf() { command printf opened > ${quote(opened)};`,
      `  epicd_test_remaining=300; while [ ! -e ${quote(gate)} ]; do`,
      `    epicd_test_remaining=$((epicd_test_remaining - 1)); [ "$epicd_test_remaining" -gt 0 ] || return 72;`,
      `    /bin/sleep 0.01; done;`,
      `  command printf "$@"; }`,
      nativeShellBootstrap("/bin/false", generation, ready),
    ].join("\n");
    const abort = new AbortController();
    const running = runCommand("/bin/sh", ["-c", script], {
      cwd: root,
      timeoutMs: 5000,
      signal: abort.signal,
    }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    try {
      const deadline = Date.now() + 3000;
      for (;;) {
        const seen = await readFile(opened, "utf8").catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (seen === "opened") break;
        if (Date.now() >= deadline) throw new Error("Bootstrap never reached the gated write");
        await delay(10);
      }
      expect(await readFile(`${ready}.pending`, "utf8")).toBe("");
      await expect(stat(ready)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(gate, "release");
      const outcome = await running;
      if ("error" in outcome) throw outcome.error;
      expect(await readFile(ready, "utf8")).toBe(generation + "\n");
      expect((await stat(ready)).mode & 0o777).toBe(0o600);
      await expect(stat(`${ready}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await writeFile(gate, "release");
      await running;
      abort.abort();
    }
  });

  it("does not acknowledge a failed write", async () => {
    const { root, ready, generation } = await fixture();
    await expect(
      runCommand(
        "/bin/sh",
        [
          "-c",
          "printf() { return 71; };\n" + nativeShellBootstrap("/bin/false", generation, ready),
        ],
        { cwd: root, timeoutMs: 5000 },
      ),
    ).rejects.toMatchObject({ result: { exitCode: 71 } });
    await expect(stat(ready)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${ready}.pending`, "utf8")).toBe("");
  });

  it("retains the quoted launcher function and forwards arguments after setup", async () => {
    const { root, ready, generation } = await fixture();
    const outcome = await runCommand(
      "/bin/sh",
      [
        "-c",
        nativeShellBootstrap("/usr/bin/printf", generation, ready) +
          `codex '%s\\n' 'argument with spaces'`,
      ],
      { cwd: root, timeoutMs: 5000 },
    );
    expect(outcome.stdout).toBe("argument with spaces\n");
    expect(await readFile(ready, "utf8")).toBe(generation + "\n");
  });
});
