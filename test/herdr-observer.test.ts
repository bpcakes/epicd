import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeHerdrIdentity } from "../src/adapters/herdr-observer.js";

const commands = vi.hoisted(() => ({ runJson: vi.fn(), runCommand: vi.fn() }));
vi.mock("../src/util/command.js", () => commands);
import { HerdrObserver } from "../src/adapters/herdr-observer.js";

const identity: NativeHerdrIdentity = {
  name: "ed-owned-r-one",
  paneId: "w1:p2",
  tabId: "w1:t2",
  terminalId: "term-one",
  providerSessionId: "provider-one",
};

function agent(overrides: Record<string, unknown> = {}) {
  return {
    result: {
      agent: {
        name: identity.name,
        pane_id: identity.paneId,
        tab_id: identity.tabId,
        terminal_id: identity.terminalId,
        agent_status: "idle",
        interactive_ready: true,
        agent_session: { kind: "id", value: identity.providerSessionId },
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Herdr native observations", () => {
  const observer = new HerdrObserver({ cwd: "/repo", herdrPath: "herdr-test" });

  it.each(["working", "blocked", "unknown"])("does not treat %s as ready", async (state) => {
    commands.runJson.mockResolvedValueOnce(agent({ agent_status: state }));
    expect(await observer.observe(identity.name, identity)).toMatchObject({
      ready: false,
      state,
      sourceSequence: null,
    });
  });

  it("does not infer readiness merely from idle", async () => {
    commands.runJson.mockResolvedValueOnce(agent({ interactive_ready: false }));
    expect((await observer.observe(identity.name, identity)).ready).toBe(false);
  });

  it("treats omitted native readiness and a pending launch as not ready", async () => {
    commands.runJson.mockResolvedValueOnce(agent({ interactive_ready: undefined }));
    expect((await observer.observe(identity.name, identity)).ready).toBe(false);
    commands.runJson.mockResolvedValueOnce(agent({ launch_pending: true }));
    expect((await observer.observe(identity.name, identity)).ready).toBe(false);
  });

  it("routes all native observations and diagnostics to the explicitly selected session", async () => {
    const env = { HERDR_ENV: "1", HERDR_SESSION: "unrelated" };
    const selected = new HerdrObserver({
      cwd: "/repo",
      herdrPath: "herdr-test",
      sessionName: "owned",
      env,
    });
    commands.runJson.mockResolvedValue(agent());
    commands.runCommand.mockResolvedValue({ stdout: "bounded text" });
    await selected.readDiagnostic(identity);
    expect(commands.runJson).toHaveBeenCalledTimes(2);
    for (const call of [...commands.runJson.mock.calls, ...commands.runCommand.mock.calls]) {
      expect(call[1].slice(0, 2)).toEqual(["--session", "owned"]);
      expect(call[2]).toMatchObject({ cwd: "/repo", env });
    }
  });

  it("rejects diagnostics if the native occupant changed during the read", async () => {
    commands.runJson
      .mockResolvedValueOnce(agent())
      .mockResolvedValueOnce(agent({ terminal_id: "replacement" }));
    commands.runCommand.mockResolvedValueOnce({ stdout: "unrelated claims" });
    await expect(observer.readDiagnostic(identity)).rejects.toThrow("identity changed");
  });

  it.each(["name", "pane_id", "tab_id", "terminal_id"])(
    "rejects replacement of the registered %s",
    async (field) => {
      commands.runJson.mockResolvedValueOnce(agent({ [field]: "another-occupant" }));
      await expect(observer.observe(identity.name, identity)).rejects.toThrow("identity changed");
    },
  );

  it("rejects a changed or missing provider identity after it has been established", async () => {
    commands.runJson.mockResolvedValueOnce(
      agent({ agent_session: { kind: "id", value: "other-session" } }),
    );
    await expect(observer.observe(identity.name, identity)).rejects.toThrow("identity changed");
    commands.runJson.mockResolvedValueOnce(agent({ agent_session: null }));
    await expect(observer.observe(identity.name, identity)).rejects.toThrow("identity changed");
  });

  it("redacts diagnostic text without interpreting claims as evidence", async () => {
    commands.runJson.mockResolvedValueOnce(agent()).mockResolvedValueOnce(agent());
    commands.runCommand.mockResolvedValueOnce({ stdout: "token=secret tests passed" });
    expect(await observer.readDiagnostic(identity)).toEqual({
      text: "token=[REDACTED] tests passed",
      truncated: true,
    });
    expect(commands.runCommand.mock.calls[0]?.[1]).toEqual([
      "agent",
      "read",
      identity.name,
      "--source",
      "recent-unwrapped",
      "--lines",
      "120",
    ]);
  });

  it("redacts structured credential values before clipping and forwards cancellation to every read", async () => {
    const controller = new AbortController();
    commands.runJson.mockResolvedValue(agent());
    commands.runCommand.mockResolvedValue({
      stdout: '{"password":"' + "hidden".repeat(4000) + '"}\nvisible failure',
    });
    expect(await observer.readDiagnostic(identity, controller.signal)).toEqual({
      text: '{"password":"[REDACTED]"}\nvisible failure',
      truncated: true,
    });
    for (const call of [...commands.runJson.mock.calls, ...commands.runCommand.mock.calls])
      expect(call[2].signal).toBe(controller.signal);
  });

  it("rechecks identity before requesting interruption and does not claim stop", async () => {
    commands.runJson.mockResolvedValueOnce(agent({ agent_status: "working" }));
    commands.runCommand.mockResolvedValueOnce({});
    expect(await observer.requestInterrupt(identity)).toBeUndefined();
    expect(commands.runCommand.mock.calls[0]?.[1]).toEqual([
      "agent",
      "send-keys",
      identity.name,
      "ctrl+c",
    ]);
  });
});
