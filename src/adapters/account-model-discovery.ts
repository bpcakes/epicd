import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { AccountSource } from "../domain/accounts.js";
import { pathsOverlap, projectAccountAccessToken } from "./accounts.js";
import { digestJson } from "../domain/repository-policy.js";
import { CommandLifetimeSchema } from "../domain/command-lifetime.js";
import { readOwnerFile } from "./codex-credentials.js";
import {
  prepareCommandLifetime,
  readCommandStop,
  startDurableCommand,
  type CommandLaunch,
} from "./command-lifetime.js";
import { NamespaceStopUnprovenError } from "./pid-namespace.js";
import type { CodexProcess } from "./codex-process.js";

export type AccountModelDiscovery = { source: AccountSource | null; root: string };

/** Reclaim only probes with an original, identity-checked stop receipt. Active probes stay intact. */
export async function cleanupAccountModelDiscovery(root: string): Promise<void> {
  await privateDirectory(root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("model-")) continue;
    const directory = join(root, entry.name);
    try {
      await privateDirectory(directory);
      // Only failed callers relinquish cleanup to a later probe. Do not race a live caller
      // still consuming the supervisor's receipt after a normal completion.
      await readOwnerFile(join(directory, "cleanup-pending"), 64);
      const controls = join(directory, ".command-io");
      await privateDirectory(controls);
      const operations = await readdir(controls, { withFileTypes: true });
      if (operations.length !== 1 || !operations[0]!.isDirectory()) continue;
      const operation = join(controls, operations[0]!.name);
      const saved = JSON.parse(await readOwnerFile(join(operation, "intent.json"), 64 * 1024));
      const intent = CommandLifetimeSchema.parse(saved.intent);
      if (intent.directory.path !== operation || !intent.runId.startsWith("account-discovery-"))
        continue;
      if (await readCommandStop(intent)) await rm(directory, { recursive: true, force: true });
    } catch {
      // Incomplete, active, concurrently removed, or unverifiable probes cannot authorize deletion.
    }
  }
}

/** A neutral, token-only home for model/list. Source config and repository files are absent. */
export async function startAccountModelDiscovery(
  executable: string,
  input: AccountModelDiscovery,
  timeoutMs: number,
): Promise<CodexProcess> {
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  await privateDirectory(input.root);
  if (input.source && pathsOverlap(input.root, input.source.codexHome))
    throw new Error("Discovery storage overlaps its account source");
  await cleanupAccountModelDiscovery(input.root);
  const directory = await mkdtemp(join(input.root, "model-"));
  const home = join(directory, "home"),
    workspace = join(directory, "workspace"),
    scratch = join(directory, "scratch");
  for (const path of [home, workspace, scratch]) await mkdir(path, { mode: 0o700 });
  let started = false;
  try {
    if (input.source)
      await projectAccountAccessToken(input.source.authCachePath, home, randomUUID(), input.source);
    const config = [
      'cli_auth_credentials_store = "file"',
      'approval_policy = "never"',
      'web_search = "disabled"',
      "project_doc_max_bytes = 0",
      "allow_login_shell = false",
      "[features]",
      "hooks = false",
      "plugins = false",
      "remote_plugin = false",
      "apps = false",
      "skill_mcp_dependency_install = false",
      "[shell_environment_policy]",
      'inherit = "none"',
      "",
    ].join("\n");
    await writeFile(join(home, "config.toml"), config, { flag: "wx", mode: 0o600 });
    const args = [
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
    ];
    const mount = (path: string, writable = false) => {
      if (
        pathsOverlap(path, join(directory, ".command-io")) ||
        (input.source && pathsOverlap(path, input.source.codexHome))
      )
        throw new Error("Discovery mounts would expose account source or supervisor control");
      args.push(writable ? "--bind" : "--ro-bind", path, path);
    };
    for (const path of [
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/etc/ld.so.cache",
      "/etc/localtime",
      "/etc/resolv.conf",
      "/etc/hosts",
      "/etc/nsswitch.conf",
      "/etc/passwd",
      "/etc/group",
      "/etc/ssl/certs",
    ])
      if (await exists(path)) mount(path);
    for (const path of ["/etc/codex/config.toml", "/etc/codex/managed_config.toml"])
      if (await exists(path))
        throw new Error(
          `Account model discovery does not support system Codex configuration (${path}); select an explicit worker model`,
        );
    if (await exists("/etc/codex/requirements.toml")) mount("/etc/codex/requirements.toml");
    if (
      !(await lstat(executable)).isFile() ||
      (await realpath(executable)) !== executable ||
      pathsOverlap(executable, directory)
    )
      throw new Error("Model discovery requires the canonical selected Codex executable");
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    mount(executable);
    const resources = join(dirname(dirname(executable)), "codex-resources");
    if (await exists(resources)) mount(resources);
    mount(home, true);
    mount(workspace);
    mount(scratch, true);
    mount(join(home, "config.toml"));
    args.push("--chdir", workspace, "--", executable, "app-server", "--listen", "stdio://");
    const launch: CommandLaunch = {
      command: "/usr/bin/bwrap",
      args,
      cwd: workspace,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        CODEX_HOME: home,
        TMPDIR: scratch,
        LANG: "C.UTF-8",
      },
      extraInput: null,
      interactiveInput: true,
    };
    const operationId = randomUUID();
    const intent = await prepareCommandLifetime(
      {
        runId: `account-discovery-${operationId}`,
        operationId,
        controllerLeaseId: operationId,
        scopeDigest: digestJson(["account-model-discovery-v1", input.source?.bindingId ?? null]),
        timeoutMs,
      },
      launch,
    );
    // Retain the exact intent outside probe mounts so pending cleanup remains inspectable.
    await writeFile(
      join(intent.directory.path, "intent.json"),
      JSON.stringify({ intent, launch }),
      { flag: "wx", mode: 0o600 },
    );
    const running = startDurableCommand(intent, launch);
    started = true;
    // Keep observing after the caller's stop deadline so late receipts also reclaim token copies.
    const outcome = running.result
      .then(async (result) => {
        await rm(directory, { recursive: true, force: true });
        return { result };
      })
      .catch((error) => ({ error: error instanceof Error ? error : new Error(String(error)) }));
    let closed = false;
    let stopPromise: Promise<Error | undefined> | undefined;
    running.child.once("close", () => {
      closed = true;
    });
    const stop = () =>
      (stopPromise ??= (async () => {
        running.interrupt();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending = new Promise<{ error: Error }>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                error: new NamespaceStopUnprovenError(
                  `Model discovery cleanup is pending; retained intent: ${join(intent.directory.path, "intent.json")}`,
                ),
              }),
            2000,
          );
        });
        const finished = await Promise.race([outcome, pending]);
        clearTimeout(timer);
        if ("error" in finished) {
          await writeFile(join(directory, "cleanup-pending"), "pending\n", { mode: 0o600 }).catch(
            (error) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
          if (!closed) {
            running.child.unref();
            running.child.stdin?.destroy();
            running.child.stdout?.destroy();
            running.child.stderr?.destroy();
            running.input?.destroy();
          }
          return finished.error;
        }
        return undefined;
      })());
    return {
      stdin: running.input!,
      stdout: running.child.stdout as Readable,
      stderr: running.child.stderr as Readable,
      onError: (listener) => {
        running.child.on("error", listener);
      },
      onClose: (listener) => {
        void outcome.then((finished) =>
          listener("result" in finished ? finished.result.receipt.code : null),
        );
      },
      stop: (done) => {
        void stop().then(done, (error) =>
          done(error instanceof Error ? error : new Error(String(error))),
        );
      },
    };
  } catch (error) {
    if (!started) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new Error("Model discovery storage must be canonical and owner-only");
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
