import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexExecutable } from "../src/adapters/codex-settings.js";

const mocks = vi.hoisted(() => ({
  resolveCodexExecutable: vi.fn<() => CodexExecutable>(() => {
    throw new Error("public Codex shim is unavailable");
  }),
  resumeThread: vi.fn(() => ({ id: "thread" })),
  startThread: vi.fn(() => ({ id: "new-thread" })),
  resolveCodexModel: vi.fn<() => Promise<string>>(),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    resumeThread = mocks.resumeThread;
    startThread = mocks.startThread;
  },
}));

vi.mock("../src/adapters/codex-settings.js", () => ({
  codexProcessEnvironment: vi.fn(() => ({})),
  resolveCodexExecutable: mocks.resolveCodexExecutable,
  resolveCodexModel: mocks.resolveCodexModel,
}));

import { CodexRuntime } from "../src/adapters/codex.js";
import type { AgentRoleSettings, SdkAgentSessionContract } from "../src/domain/types.js";
import type { AgentSessionSpec } from "../src/adapters/runtime.js";

beforeEach(() => {
  mocks.resolveCodexExecutable.mockClear();
  mocks.resumeThread.mockClear();
  mocks.startThread.mockClear();
  mocks.resolveCodexModel.mockReset();
});

describe("CodexRuntime executable resolution", () => {
  it("captures requested settings before asynchronous discovery can yield to its caller", async () => {
    const runtime = new CodexRuntime({ repoPath: "/repo", accessMode: "sandboxed" });
    const settings: AgentRoleSettings = { model: null, reasoningEffort: "high" };
    mocks.resolveCodexExecutable.mockReturnValueOnce({ executablePath: "fixture", args: [] });
    mocks.resolveCodexModel.mockReturnValueOnce(
      new Promise((resolve) => {
        queueMicrotask(() => {
          settings.model = "gpt-later";
          settings.reasoningEffort = "low";
          resolve("gpt-discovered");
        });
      }),
    );
    const contract = await runtime.prepareNewSession("review", settings);
    expect(mocks.resolveCodexModel).toHaveBeenCalledOnce();
    expect(contract.requested).toEqual({ model: null, reasoningEffort: "high" });
    expect(contract.effective).toEqual({ model: "gpt-discovered", reasoningEffort: "high" });
  });

  it.each(["new", "existing"] as const)(
    "rejects a foreign %s contract before creating an SDK thread",
    async (kind) => {
      const runtime = new CodexRuntime({ repoPath: "/repo", accessMode: "sandboxed" });
      const contract = {
        runtime: "herdr" as const,
        requested: { model: "gpt-explicit", reasoningEffort: "high" as const },
        effective: { model: "gpt-explicit", reasoningEffort: "high" as const },
      };
      const spec: AgentSessionSpec<"herdr"> =
        kind === "new" ? { kind, contract } : { kind, contract, sessionId: "foreign-thread" };
      // @ts-expect-error Untyped callers must also be rejected before any thread is created.
      await expect(runtime.open("review", spec)).rejects.toThrow("runtime");
      expect(mocks.startThread).not.toHaveBeenCalled();
      expect(mocks.resumeThread).not.toHaveBeenCalled();
    },
  );

  it("owns and freezes prepared settings independently of its caller", async () => {
    const runtime = new CodexRuntime({ repoPath: "/repo", accessMode: "sandboxed" });
    const settings: AgentRoleSettings = { model: "gpt-original", reasoningEffort: "high" };
    const contract = await runtime.prepareNewSession("review", settings);
    settings.model = "gpt-changed";
    settings.reasoningEffort = "low";
    expect(contract.requested).toEqual({ model: "gpt-original", reasoningEffort: "high" });
    expect(contract.effective).toEqual(contract.requested);
    expect(Reflect.set(contract.effective, "model", "gpt-changed")).toBe(false);
    expect(Reflect.set(contract.requested, "reasoningEffort", "low")).toBe(false);
    expect(Reflect.set(contract, "runtime", "herdr")).toBe(false);
  });

  it.each(["new", "existing"] as const)(
    "copies and freezes a supplied %s contract before opening",
    async (kind) => {
      const runtime = new CodexRuntime({ repoPath: "/repo", accessMode: "sandboxed" });
      const settings: AgentRoleSettings & { model: string } = {
        model: "gpt-original",
        reasoningEffort: "high",
      };
      const contract: SdkAgentSessionContract = {
        runtime: "sdk",
        requested: settings,
        effective: settings,
      };
      const opened = await runtime.open(
        "review",
        kind === "new" ? { kind, contract } : { kind, contract, sessionId: "existing-thread" },
      );
      settings.model = "gpt-changed";
      expect(opened.contract.effective.model).toBe("gpt-original");
      expect(opened.contract.requested.model).toBe("gpt-original");
      expect(Reflect.set(opened.contract.effective, "model", "gpt-changed")).toBe(false);
      expect(Reflect.set(opened, "contract", contract)).toBe(false);
      const threadOptions = expect.objectContaining({ model: "gpt-original" });
      if (kind === "new") expect(mocks.startThread).toHaveBeenCalledWith(threadOptions);
      else expect(mocks.resumeThread).toHaveBeenCalledWith("existing-thread", threadOptions);
    },
  );

  it("opens an explicit-model session without resolving the discovery shim", async () => {
    const runtime = new CodexRuntime({ repoPath: "/repo", accessMode: "sandboxed" });
    const opened = await runtime.open("review", {
      kind: "new",
      settings: { model: "gpt-explicit", reasoningEffort: "high" },
    });
    expect(opened.contract.effective.model).toBe("gpt-explicit");
    expect(mocks.startThread).toHaveBeenCalledOnce();
    expect(mocks.resolveCodexExecutable).not.toHaveBeenCalled();
  });

  it("reuses a cached default without resolving the discovery shim", async () => {
    const runtime = new CodexRuntime({ repoPath: "/repo", accessMode: "sandboxed" });
    const contract = await runtime.prepareNewSession(
      "review",
      { model: null, reasoningEffort: "high" },
      {
        runtime: "sdk",
        requested: { model: null, reasoningEffort: "low" },
        effective: { model: "gpt-cached", reasoningEffort: "low" },
      },
    );
    expect(contract.effective).toEqual({ model: "gpt-cached", reasoningEffort: "high" });
    expect(mocks.resolveCodexExecutable).not.toHaveBeenCalled();
  });

  it("resumes a default SDK thread without resolving the discovery shim", async () => {
    const runtime = new CodexRuntime({ repoPath: "/repo", accessMode: "sandboxed" });

    const opened = await runtime.open("review", {
      kind: "existing",
      sessionId: "thr-existing",
      contract: {
        runtime: "sdk",
        requested: { model: null, reasoningEffort: "xhigh" },
        effective: { model: "gpt-pinned", reasoningEffort: "xhigh" },
      },
    });

    expect(opened.session.id).toBe("thr-existing");
    expect(mocks.resumeThread).toHaveBeenCalledOnce();
    expect(mocks.resolveCodexExecutable).not.toHaveBeenCalled();
  });
});
