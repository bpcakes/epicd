import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { doctorFixture } from "./fixtures/doctor.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
describe("CLI entrypoint", () => {
  it.each(["default", "explicit"])(
    "prints usable recovery steps for an unsupported %s state path without resetting it",
    (kind) => {
      const root = mkdtempSync("/var/tmp/epicd-cli-old-state-");
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const stateHome = join(root, "state home");
      const relative = "state dir/old ' token=retained $(touch INJECTED) `touch INJECTED`.sqlite3";
      const path =
        kind === "default" ? join(stateHome, "epicd", "epicd.sqlite3") : join(root, relative);
      mkdirSync(resolve(path, ".."), { recursive: true });
      const db = new Database(path);
      db.exec(
        "CREATE TABLE retained_work(value TEXT); INSERT INTO retained_work VALUES ('keep this')",
      );
      db.close();
      const before = readFileSync(path);
      writeFileSync(`${path}.fresh`, "existing file: do not overwrite");
      const neighbor = join(root, "unrelated.sqlite3");
      writeFileSync(neighbor, "unrelated data");
      const result = spawnSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "status",
          "unused",
          ...(kind === "explicit" ? ["--state", relative] : []),
        ],
        {
          cwd: root,
          env: { ...process.env, XDG_STATE_HOME: stateHome },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("This Epicd state format is unsupported");
      expect(result.stderr).toContain(`State file: ${JSON.stringify(path)}`);
      expect(result.stderr).toContain("Keep the old data");
      expect(result.stderr).toContain(".fresh-2'");
      expect(result.stderr).toContain("Stop any Epicd controllers");
      expect(result.stderr).toContain("permanently delete all saved runs");
      expect(result.stderr).toContain("does not release existing repository run reservations");
      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(`${path}.fresh-2`)).toBe(false);
      const deletion = result.stderr
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("rm -f -- "));
      expect(deletion).toBeDefined();
      const files = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
      // Verify literal argument handling in the user's shell, including quotes,
      // credential-looking filenames and command substitutions, without deleting yet.
      if (existsSync("/usr/bin/fish")) {
        const argumentsOnly = deletion!.replace("rm -f -- ", "printf '%s\\n' ");
        const fish = spawnSync("/usr/bin/fish", ["--no-config", "-c", argumentsOnly], {
          cwd: root,
          encoding: "utf8",
          timeout: 10000,
        });
        expect(fish.status, fish.stderr).toBe(0);
        expect(fish.stdout.trimEnd().split("\n")).toEqual(files);
      }
      for (const file of files.slice(1)) writeFileSync(file, "test-owned sidecar");
      // Execute only the printed deletion command against this disposable fixture.
      const removed = spawnSync("/bin/sh", ["-c", deletion!], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
      });
      expect(removed.status, removed.stderr).toBe(0);
      expect(files.some(existsSync)).toBe(false);
      expect(readFileSync(`${path}.fresh`, "utf8")).toBe("existing file: do not overwrite");
      expect(readFileSync(neighbor, "utf8")).toBe("unrelated data");
      expect(existsSync(join(root, "INJECTED"))).toBe(false);
    },
  );

  it.each([{ args: [] }, { args: ["--help"] }, { args: ["--version"] }])(
    "runs through an installed executable symlink with arguments $args",
    ({ args }) => {
      const root = mkdtempSync("/var/tmp/epicd-cli-entry-");
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const entry = resolve("dist/cli.js");
      const link = join(root, "epicd");
      symlinkSync(entry, link);
      const direct = spawnSync(process.execPath, [entry, ...args], {
        encoding: "utf8",
        timeout: 10_000,
      });
      const linked = spawnSync(process.execPath, [link, ...args], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(linked.error).toBeUndefined();
      expect(linked.status).toBe(args.length ? 0 : 1);
      expect(linked.status).toBe(direct.status);
      expect(linked.stdout).toBe(direct.stdout);
      expect(linked.stderr).toBe(direct.stderr);
      expect(linked.stdout + linked.stderr).toContain(
        args.includes("--version") ? "0.1.0" : "Usage: epicd",
      );
    },
  );

  it("can be imported without starting the CLI", () => {
    const root = mkdtempSync("/var/tmp/epicd-cli-import-");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const wrapper = join(root, "import.mjs");
    writeFileSync(
      wrapper,
      `import { createProgram } from ${JSON.stringify(pathToFileURL(resolve("dist/cli.js")).href)};\nconsole.log(createProgram().name());\n`,
    );
    const result = spawnSync(process.execPath, [wrapper], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("epicd\n");
    expect(result.stderr).toBe("");
  });
});

describe.runIf(process.platform === "linux")("doctor CLI", () => {
  it("serializes the exact Herdr endpoint after ordered discovery", () => {
    const f = doctorFixture();
    cleanup.push(f.cleanup);
    const before = f.snapshot();
    const result = f.cli("herdr");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      runtime: "herdr",
      executable: f.codex,
      herdr: { executable: f.herdr, sessionName: "owned", workspaceId: "fixture-workspace" },
    });
    expect(f.calls()).toEqual([
      "codex --version",
      "herdr status server",
      "herdr session list --json",
      "herdr pane current --current",
    ]);
    expect(f.snapshot()).toEqual(before);
  });

  it("prints the read-only report as JSON without creating state", () => {
    const f = doctorFixture();
    cleanup.push(f.cleanup);
    const before = f.snapshot();
    const result = f.cli();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      runtime: "sdk",
      executable: f.codex,
      version: `${f.codex} — codex-cli fixture`,
      orchestratorModel: "gpt-6-astra",
      defaultReasoning: "high",
      fallback: false,
      herdr: null,
      warning:
        "Executable/endpoint checks only. These checks do not prove authentication, confinement, model result admission or epic delivery.",
    });
    expect(f.calls()).toEqual(["codex --version"]);
    expect(f.snapshot()).toEqual(before);
  });

  it("prints a redacted failure with exit code 1 and no success report or state", () => {
    const f = doctorFixture({ versionFails: true });
    cleanup.push(f.cleanup);
    const before = f.snapshot();
    const result = f.cli("herdr");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `epicd: ${f.codex} --version failed with exit code 7: token=[REDACTED] version unavailable\n`,
    );
    expect(result.stderr).not.toContain("doctor-test-secret");
    expect(f.calls()).toEqual(["codex --version"]);
    expect(f.snapshot()).toEqual(before);
  });
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-cli-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite3"),
    store = new StateStore(path);
  cleanup.push(() => store.close());
  const state = store.create(initialRun(), RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["dist/cli.js", ...args, "--state", path], {
      encoding: "utf8",
      timeout: 10_000,
    });
  return { store, state, cli };
}
describe("hard-cut CLI", () => {
  it("offers a separate operator console and refuses noninteractive input without changing the run", () => {
    const f = fixture();
    const help = f.cli("control", "--help");
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("operator console");
    const before = f.store.orchestration.control(f.state.runId);
    const refused = f.cli("control", f.state.runId);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("interactive terminal");
    expect(f.store.orchestration.control(f.state.runId)).toEqual(before);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });

  it("reports journal status with Astra settings and no lifecycle/session aliases", () => {
    const f = fixture(),
      result = f.cli("status", f.state.runId, "--json");
    expect(result.status, result.stderr).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status).toMatchObject({
      runId: f.state.runId,
      control: { status: "active" },
      settings: { orchestrator: { model: "gpt-6-astra", reasoningEffort: "high" } },
    });
    expect(status).not.toHaveProperty("phase");
    expect(status).not.toHaveProperty("orchestratorThreadId");
  });
  it("requires the observed control version and durably pauses a live controller without stealing its lease", () => {
    const f = fixture(),
      lease = f.store.acquireLease(f.state.runId);
    const missing = f.cli("pause", f.state.runId);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("--control-version");
    const result = f.cli("pause", f.state.runId, "--control-version", "0");
    expect(result.status, result.stderr).toBe(0);
    expect(f.store.orchestration.control(f.state.runId).status).toBe("paused");
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(lease.leaseId);
    expect(f.cli("pause", f.state.runId, "--control-version", "0").status).not.toBe(0);
  });
  it("answers only the exact pending escalation and preserves the instruction", () => {
    const f = fixture(),
      lease = f.store.acquireLease(f.state.runId);
    const id = f.store.orchestration.setEscalation(
      { runId: f.state.runId, ...lease },
      "Need a scope decision",
      "judgment",
      [],
    );
    f.store.releaseLease(f.state.runId, lease.ownerToken);
    expect(
      f.cli("respond", f.state.runId, "wrong", "stay in scope", "--control-version", "1").status,
    ).not.toBe(0);
    const result = f.cli("respond", f.state.runId, id, "stay in scope", "--control-version", "1");
    expect(result.status, result.stderr).toBe(0);
    expect(f.store.orchestration.pendingEscalation(f.state.runId)).toBeNull();
    expect(f.store.orchestration.observations(f.state.runId).at(-1)?.summary).toContain(
      "stay in scope",
    );
  });
  it("rejects implicit runtime switching on resume and obsolete bypass flags at argument parsing", () => {
    const f = fixture();
    for (const args of [
      ["resume", f.state.runId, "--runtime", "herdr"],
      ["run", "epic", "--orchestration", "legacy"],
      ["run", "epic", "--dangerously-bypass-approvals-and-sandbox"],
    ]) {
      const result = f.cli(...args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unknown option");
    }
    expect(f.store.list()).toHaveLength(1);
  });
  it("requires an explicit target and observed control version for handoff", () => {
    const f = fixture();
    const missingRuntime = f.cli("handoff", f.state.runId, "--control-version", "0");
    expect(missingRuntime.status).not.toBe(0);
    expect(missingRuntime.stderr).toContain("--runtime");
    const missingVersion = f.cli("handoff", f.state.runId, "--runtime", "herdr");
    expect(missingVersion.status).not.toBe(0);
    expect(missingVersion.stderr).toContain("--control-version");
    expect(f.store.get(f.state.runId)).toEqual(f.state);
  });
  it("does not change control state or settings when another controller owns the run", () => {
    const f = fixture(),
      lease = f.store.acquireLease(f.state.runId);
    const resume = f.cli("resume", f.state.runId, "--headless");
    expect(resume.status).not.toBe(0);
    expect(resume.stderr).toContain("already controlled");
    const settings = f.cli("settings", f.state.runId, "--role", "review", "--model", "new-worker");
    expect(settings.status).not.toBe(0);
    expect(f.store.get(f.state.runId)?.agentSettings).toEqual(f.state.agentSettings);
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(lease.leaseId);
  });
  it("allows worker changes but rejects any coordinator model fallback", () => {
    const f = fixture();
    expect(
      f.cli("settings", f.state.runId, "--role", "orchestrator", "--model", "other").status,
    ).not.toBe(0);
    const result = f.cli("settings", f.state.runId, "--role", "review", "--model", "review-worker");
    expect(result.status, result.stderr).toBe(0);
    expect(f.store.get(f.state.runId)?.agentSettings.review.model).toBe("review-worker");
  });
});
