import { describe, expect, it } from "vitest";
import { CodexRuntime } from "../src/adapters/codex.js";
import type { AgentSession } from "../src/adapters/runtime.js";
import { DEFAULT_AGENT_SETTINGS } from "../src/domain/types.js";

describe("CodexRuntime sessions", () => {
  it("rejects foreign and fabricated sessions before starting a turn", async () => {
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      settings: DEFAULT_AGENT_SETTINGS,
      accessMode: "sandboxed",
    });
    const foreignSession: AgentSession = { runtime: "herdr", id: null, role: "review" };
    const fabricatedSession: AgentSession = { runtime: "sdk", id: null, role: "review" };

    await expect(runtime.run(foreignSession, "Review")).rejects.toThrow("non-SDK session");
    await expect(runtime.run(fabricatedSession, "Review")).rejects.toThrow("did not create");
  });
});
