import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

/** Test-only, self-contained dependency bundle. No host directory is added to a runtime sandbox. */
export function buildBrowserBundle(toolchainRoot: string, browserDirectory: string): Buffer {
  const modules = join(realpathSync(toolchainRoot), "node_modules"),
    browser = realpathSync(browserDirectory),
    node = realpathSync(process.execPath);
  const manifest = JSON.parse(readFileSync(join(modules, "playwright-core/browsers.json"), "utf8"));
  const expected = manifest.browsers.find(
    (entry: { name: string }) => entry.name === "chromium-headless-shell",
  );
  const version = execFileSync(join(browser, "chrome-headless-shell"), ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  if (
    basename(browser) !== "chrome-headless-shell-linux64" ||
    basename(node) !== "node" ||
    !version.includes(expected?.browserVersion)
  )
    throw new Error(
      "Select the matching Playwright headless-shell directory and native node executable",
    );
  const root = mkdtempSync("/var/tmp/epicd-browser-bundle-");
  const archive = join(root, "toolchain.tar.gz");
  execFileSync(
    "tar",
    [
      "-czf",
      archive,
      "-C",
      dirname(node),
      "node",
      "-C",
      dirname(modules),
      "node_modules",
      "-C",
      dirname(browser),
      basename(browser),
    ],
    { timeout: 120000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const bytes = readFileSync(archive);
  process.stderr.write(
    `Browser dependency bundle: ${archive} (${bytes.length} bytes; ${version})\n`,
  );
  return bytes;
}

export function browserProject(source: string, bundle: Buffer, psql: string) {
  mkdirSync(join(source, "tools"), { recursive: true });
  mkdirSync(join(source, "e2e"));
  mkdirSync(join(source, "vendor"));
  const template = join(import.meta.dirname, "browser-project");
  const files = [
    "tools/browser-check.sh",
    "tools/browser-server.cjs",
    "playwright.config.cjs",
    "e2e/login.spec.cjs",
  ];
  for (const file of files)
    copyFileSync(
      join(template, file === "e2e/login.spec.cjs" ? "login.cjs" : basename(file)),
      join(source, file),
    );
  writeFileSync(join(source, "tools/browser-runtime.json"), JSON.stringify({ psql }));
  files.push("tools/browser-runtime.json");
  // Stay within the real kernel's 64 MiB per-file limit without changing that limit.
  const partBytes = 32 * 1024 * 1024;
  for (let offset = 0; offset < bundle.length; offset += partBytes) {
    const file = `vendor/toolchain.part-${String(offset / partBytes).padStart(3, "0")}`;
    writeFileSync(join(source, file), bundle.subarray(offset, offset + partBytes));
    files.push(file);
  }
  writeFileSync(
    join(source, "BROWSER.md"),
    `# Browser validation\n\nThe browser command is \`/bin/sh tools/browser-check.sh\` from the repository root. It expands the bundled Node, Playwright and matching headless Chromium into private temporary storage, starts the local test server and signs in through a real browser. The test requires PostgreSQL-backed authentication and the delivered green application output. No browser download, global package installation or tracked receipt is needed.\n\nOrdinary worker commands have private scratch but cannot open network listeners. Run the source comparison normally; for browser execution, stop the implementation turn and ask the engineering lead to execute the unchanged command through the kernel on a captured candidate copy. The lead has \`run_diagnostic_check\` for investigating a command/environment without changing the required validation plan, and \`run_validation\` for satisfying required checks. Do not bypass the worker's confinement. When the lead supplies a result, report its actual outcome and evidence ID in the tests detail, explicitly attributing execution to the kernel. Do not claim that the worker ran it or that a diagnostic pass satisfies required validation.\n\nThe database is the declared disposable host fixture with environment binding \`browser\`. Repository commands require a kernel-supplied \`DATABASE_URL\`; they cannot reach host PostgreSQL sockets directly. The browser login uses disposable application credentials from the test, not a PostgreSQL administrator password. The server prepares its own application schema inside the allowed database. See \`playwright.config.cjs\`, \`e2e/login.spec.cjs\`, \`tools/browser-server.cjs\` and the frozen policy for the exact check and database declaration. Do not weaken the login assertion or change the policy, helpers, oracle, runtime metadata or bundled dependencies to make a failing test pass.\n\nToolchain SHA-256: \`${createHash("sha256").update(bundle).digest("hex")}\`.\n`,
  );
  files.push("BROWSER.md");
  return files;
}
