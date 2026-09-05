import { describe, expect, it } from "vitest";
import {
  resolveCodexModel,
  resolveSdkCodexExecutable,
  verifyCodexExecutable,
} from "../src/adapters/codex-settings.js";

describe("live Codex integration", () => {
  it.runIf(process.env.EPICD_LIVE_CODEX === "1")(
    "discovers a model from the authenticated SDK-pinned app-server",
    async () => {
      const executable = resolveSdkCodexExecutable();
      await expect(verifyCodexExecutable(process.cwd(), executable)).resolves.toContain("codex");
      const model = await resolveCodexModel(process.cwd(), {
        executable,
        attempts: 1,
        timeoutMs: 20_000,
      });

      expect(model.trim()).not.toBe("");
    },
    30_000,
  );
});
