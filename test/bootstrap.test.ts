import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import {
  createRun,
  discoverHerdr,
  sdkNativeExecutable,
  selectedCodexExecutable,
} from "../src/bootstrap.js";
import { resolveAgentRoleSettings } from "../src/domain/types.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-bootstrap-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  mkdirSync(join(repo, ".epicd"));
  mkdirSync(join(repo, ".beads"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const policyPath = join(repo, ".epicd", "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({ schemaVersion: 1, budgets: { taskDecisions: 4, epicDecisions: 8 } }),
  );
  writeFileSync(join(repo, ".beads", "beads.db"), "fixture only");
  writeFileSync(join(repo, "app.txt"), "baseline\n");
  git("add", "app.txt", ".epicd/policy.json");
  git("commit", "-qm", "baseline");
  const store = new StateStore(join(root, "state.sqlite3"));
  cleanup.push(() => store.close());
  const codex = join(root, "codex"),
    br = join(root, "br");
  writeFileSync(codex, "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\n", { mode: 0o700 });
  const epic = {
    id: "demo",
    title: "Bootstrap demonstration",
    status: "open",
    issue_type: "epic",
    dependencies: [],
    dependents: [],
  };
  writeFileSync(
    br,
    "#!/bin/sh\ncase \"$1\" in\nshow) printf '%s\\n' '" +
      JSON.stringify([epic]) +
      "\';;\nready) printf '[]\\n';;\n*) exit 7;;\nesac\n",
    { mode: 0o700 },
  );
  return {
    root,
    repo,
    git,
    policyPath,
    store,
    codex,
    br,
    options: {
      repoPath: repo,
      epicId: "demo",
      runtime: "sdk" as const,
      codexPath: codex,
      trackerPath: br,
      model: "worker",
      authCachePath: null,
    },
  };
}
describe.runIf(process.platform === "linux")("fresh run bootstrap", () => {
  it("freezes runtime paths, selected epic, policy and baseline without claiming tasks or changing user files", async () => {
    const f = fixture(),
      baseline = f.git("rev-parse", "HEAD");
    writeFileSync(join(f.repo, "app.txt"), "user-owned change\n");
    const run = await createRun(f.store, f.options);
    expect(run).toMatchObject({
      epicId: "demo",
      epicTitle: "Bootstrap demonstration",
      epicBaseRevision: baseline,
      runtime: "sdk",
      model: "worker",
    });
    expect(resolveAgentRoleSettings(run, "orchestrator")).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(run.runtimeConfiguration).toMatchObject({
      executable: f.codex,
      trackerExecutable: f.br,
      authCachePath: null,
      herdr: null,
    });
    expect(f.store.orchestration.tracker.configured(run.runId)).toBe(true);
    expect(() => f.store.orchestration.tracker.assertTaskOwned(run.runId, "unclaimed")).toThrow();
    expect(f.store.orchestration.tracker.operations(run.runId)).toEqual([]);
    expect(f.store.orchestration.agents.instances(run.runId)).toEqual([]);
    writeFileSync(f.policyPath, JSON.stringify({ schemaVersion: 1 }));
    expect(f.store.orchestration.policy(run.runId).budgets.epicDecisions).toBe(8);
    expect(f.git("rev-parse", "HEAD")).toBe(baseline);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("user-owned change\n");
  });
  it("rejects an invalid policy and never starts an unconfigured run", async () => {
    const f = fixture();
    writeFileSync(
      f.policyPath,
      JSON.stringify({ schemaVersion: 1, coordinator: { model: "wrong-model" } }),
    );
    await expect(createRun(f.store, f.options)).rejects.toThrow();
    expect(f.store.list()).toEqual([]);
  });
  it("preserves existing run ownership and does not convert it on a second start", async () => {
    const f = fixture();
    const first = await createRun(f.store, f.options);
    await expect(createRun(f.store, { ...f.options, runtime: "herdr" })).rejects.toThrow(
      "already has a run",
    );
    expect(f.store.get(first.runId)?.runtime).toBe("sdk");
    expect(f.store.list()).toHaveLength(1);
  });
  it("rejects a second run through a linked checkout of the same Git repository", async () => {
    const f = fixture();
    const linked = join(f.root, "linked");
    f.git("worktree", "add", "--quiet", "--detach", linked, "HEAD");
    const first = await createRun(f.store, f.options);
    await expect(createRun(f.store, { ...f.options, repoPath: linked })).rejects.toThrow(
      "already has a run",
    );
    expect(f.store.list()).toEqual([first]);
    expect(
      execFileSync("git", ["-C", linked, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe(first.epicBaseRevision);
    expect(readFileSync(join(linked, "app.txt"), "utf8")).toBe("baseline\n");
  });
  it("resolves the actual SDK-pinned native binary, not its JavaScript shim", async () => {
    const executable = await sdkNativeExecutable();
    expect(readFileSync(executable).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    expect(execFileSync(executable, ["--version"], { encoding: "utf8" })).toContain("codex-cli");
  });
  it.each(["sdk", "herdr"] as const)(
    "resolves a selected npm installation for %s without executing its shim or selecting another package",
    async (runtime) => {
      const f = fixture();
      const pkg = join(f.root, "node_modules/@openai/codex");
      const nativePkg = join(pkg, "node_modules/@openai/codex-linux-x64");
      const native = join(nativePkg, "vendor/x86_64-unknown-linux-musl/bin/codex");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      mkdirSync(join(nativePkg, "vendor/x86_64-unknown-linux-musl/bin"), { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
      );
      writeFileSync(
        join(pkg, "bin/codex.js"),
        "#!/usr/bin/env node\nthrow new Error('Do not execute this shim')\n",
        { mode: 0o700 },
      );
      writeFileSync(join(nativePkg, "package.json"), JSON.stringify({ name: "@openai/codex" }));
      copyFileSync("/usr/bin/true", native);
      const alias = join(f.root, "selected-codex");
      symlinkSync(join(pkg, "bin/codex.js"), alias);
      expect(await selectedCodexExecutable(runtime, alias)).toBe(native);
      expect(await selectedCodexExecutable(runtime, native)).toBe(native);
      if (runtime === "sdk") {
        const run = await createRun(f.store, { ...f.options, codexPath: alias });
        expect(run.runtimeConfiguration?.executable).toBe(native);
      }
    },
  );
  it("refuses an incomplete selected npm installation instead of falling back to the SDK bundle", async () => {
    const f = fixture(),
      pkg = join(f.root, "node_modules/@openai/codex");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
    );
    writeFileSync(join(pkg, "bin/codex.js"), "#!/bin/false\n", { mode: 0o700 });
    await expect(selectedCodexExecutable("herdr", join(pkg, "bin/codex.js"))).rejects.toThrow(
      "no installation fallback",
    );
    expect(f.store.list()).toEqual([]);
  });
  it("rejects state storage reached through an outside symlink into the delivery repository", async () => {
    const f = fixture();
    const privateDirectory = join(f.repo, "private");
    mkdirSync(privateDirectory);
    const alias = join(f.root, "state-alias");
    symlinkSync(privateDirectory, alias, "dir");
    const store = new StateStore(join(alias, "state.sqlite3"));
    cleanup.push(() => store.close());
    await expect(createRun(store, f.options)).rejects.toThrow(
      "must be outside the delivery repository",
    );
    expect(store.list()).toEqual([]);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("baseline\n");
  });
});
describe("native Herdr caller discovery", () => {
  function herdrFixture(sessionSocket = "/session/socket") {
    const root = mkdtempSync("/var/tmp/epicd-herdr-discovery-");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const executable = join(root, "herdr");
    const sessions = JSON.stringify({
      sessions: [{ name: "owned", running: true, socket_path: sessionSocket }],
    });
    const pane = JSON.stringify({ result: { pane: { workspace_id: "opaque-workspace" } } });
    writeFileSync(
      executable,
      '#!/bin/sh\ncase "$1 $2" in\n"status server") printf "status: running\\ncompatible: yes\\nsocket: /session/socket\\n";;\n"session list") printf \'%s\\n\' \'' +
        sessions +
        '\';;\n"pane current") test "$3" = "--current" || exit 8; printf \'%s\\n\' \'' +
        pane +
        "\';;\n*) exit 9;;\nesac\n",
      { mode: 0o700 },
    );
    return { root, executable };
  }
  it("resolves the caller's actual named session and workspace using only read commands", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    const f = herdrFixture();
    expect(await discoverHerdr(f.executable, f.root)).toEqual({
      executable: f.executable,
      sessionName: "owned",
      workspaceId: "opaque-workspace",
    });
  });
  it("does not guess a session or workspace when endpoint identity is ambiguous", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    const f = herdrFixture("/different/socket");
    await expect(discoverHerdr(f.executable, f.root)).rejects.toThrow("exact named Herdr session");
  });
  it("does not inspect Herdr outside a managed caller", async () => {
    vi.stubEnv("HERDR_ENV", "");
    await expect(discoverHerdr("/does-not-exist", "/tmp")).rejects.toThrow("Herdr-managed caller");
  });
});
