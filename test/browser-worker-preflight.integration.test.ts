import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sdkNativeExecutable } from "../dist/bootstrap.js";
import { runCommand } from "../src/util/command.js";
import { probeBrowserWorker, requireBrowserWorker } from "./fixtures/browser-worker-preflight.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("browser helper temporary storage", () => {
  it("honors private TMPDIR with spaces without changing the source checkout", async () => {
    const root = await mkdtemp("/var/tmp/epicd-browser-helper-");
    roots.push(root);
    const source = join(root, "source"),
      toolchain = join(root, "toolchain"),
      scratch = join(root, "private scratch");
    for (const path of [source, toolchain, scratch]) await mkdir(path);
    await mkdir(join(source, "vendor"));
    // Stub only the toolchain to isolate the shell helper's storage contract.
    // This does not run Chromium or claim browser/authentication evidence.
    const node = join(toolchain, "node");
    await writeFile(node, "#!/bin/sh\nprintf '%s\\n' \"$EPICD_BROWSER_OUTPUT\"\n");
    await chmod(node, 0o700);
    const archive = join(source, "vendor/toolchain.part-000");
    await runCommand("/usr/bin/tar", ["-czf", archive, "-C", toolchain, "node"], { cwd: root });
    const before = await readFile(archive);
    const result = await runCommand(
      "/bin/sh",
      [join(import.meta.dirname, "fixtures/browser-project/browser-check.sh")],
      { cwd: source, env: { PATH: "/usr/bin:/bin", TMPDIR: scratch } },
    );
    const extracted = dirname(result.stdout.trim());
    // Retain a safe cleanup target even when a regression writes to /tmp instead.
    if (/^\/tmp\/epicd-browser-check-[A-Za-z0-9]{6}$/.test(extracted)) roots.push(extracted);
    expect(extracted).toMatch(new RegExp(`^${scratch}/epicd-browser-check-[A-Za-z0-9]{6}$`));
    expect(await readFile(join(extracted, "node"), "utf8")).toContain("EPICD_BROWSER_OUTPUT");
    expect(await readFile(archive)).toEqual(before);
    expect(await readdir(source)).toEqual(["vendor"]);
    expect(await readdir(join(source, "vendor"))).toEqual(["toolchain.part-000"]);
  });
});

describe.runIf(process.platform === "linux" && process.env.EPICD_CODEX_CONFINEMENT === "1")(
  "browser worker prerequisite under the installed Codex permission profile",
  () => {
    it("reports private scratch success and rejects the unreachable local-server incident before model work", async () => {
      const result = await probeBrowserWorker(await sdkNativeExecutable());
      roots.push(result.root);
      expect(result).toMatchObject({
        scratchAvailable: true,
        localServerAvailable: false,
        error: "EPERM",
      });
      expect(() => requireBrowserWorker(result)).toThrow("No authenticated run was started");
      expect(await readFile(join(result.root, "artifacts/result.json"), "utf8")).toContain(
        '"localServer":false',
      );
    }, 30000);
  },
);
