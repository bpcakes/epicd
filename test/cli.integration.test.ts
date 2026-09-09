import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { doctorFixture } from "./fixtures/doctor.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
describe.runIf(process.platform === "linux")("doctor CLI", () => {
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
