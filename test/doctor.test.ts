import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as bootstrap from "../src/bootstrap.js";
import * as codexSettings from "../src/adapters/codex-settings.js";
import { doctorEffect, runDoctor, type DoctorCheckFailed } from "../src/doctor.js";
import { doctorFixture } from "./fixtures/doctor.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) close();
});

describe("doctor Effect boundary", () => {
  it.each([
    { stage: "select_executable", cause: new Error("not installed") },
    { stage: "verify_version", cause: { detail: "legacy rejection object" } },
    { stage: "resolve_herdr", cause: null },
    { stage: "discover_herdr", cause: "legacy rejection string" },
  ] satisfies { stage: DoctorCheckFailed["stage"]; cause: unknown }[])(
    "retains $stage failures lazily, short-circuits, and preserves the Promise rejection",
    async ({ stage, cause }) => {
      // Fault injection is limited to existing I/O helpers; the Effect program runs normally.
      const stages = {
        select_executable: vi
          .spyOn(bootstrap, "selectedCodexExecutable")
          .mockResolvedValue("/fixture/codex"),
        verify_version: vi
          .spyOn(codexSettings, "verifyCodexExecutable")
          .mockResolvedValue("fixture"),
        resolve_herdr: vi.spyOn(bootstrap, "resolveExecutable").mockResolvedValue("/fixture/herdr"),
        discover_herdr: vi.spyOn(bootstrap, "discoverHerdr").mockResolvedValue({
          executable: "/fixture/herdr",
          sessionName: "owned",
          workspaceId: "fixture-workspace",
        }),
      };
      stages[stage].mockRejectedValue(cause);
      const options = { repoPath: "/fixture", runtime: "herdr" as const };
      const program = doctorEffect(options);
      for (const helper of Object.values(stages)) expect(helper).not.toHaveBeenCalled();

      const result = await Effect.runPromise(Effect.result(program));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) throw new Error("Expected a typed doctor failure");
      expect(result.failure._tag).toBe("DoctorCheckFailed");
      expect(result.failure.stage).toBe(stage);
      expect(result.failure.cause).toBe(cause);
      const failedIndex = Object.keys(stages).indexOf(stage);
      Object.values(stages).forEach((helper, index) => {
        expect(helper).toHaveBeenCalledTimes(index <= failedIndex ? 1 : 0);
      });

      await expect(runDoctor(options)).rejects.toBe(cause);
      Object.values(stages).forEach((helper, index) => {
        expect(helper).toHaveBeenCalledTimes(index <= failedIndex ? 2 : 0);
      });
    },
  );
});
function fixture(options: Parameters<typeof doctorFixture>[0] = {}) {
  const f = doctorFixture(options);
  cleanup.push(f.cleanup);
  vi.stubEnv("PATH", f.env.PATH);
  vi.stubEnv("HERDR_ENV", f.env.HERDR_ENV);
  vi.stubEnv("EPICD_DOCTOR_LOG", f.env.EPICD_DOCTOR_LOG);
  vi.stubEnv("XDG_STATE_HOME", f.env.XDG_STATE_HOME);
  return f;
}

describe.runIf(process.platform === "linux")("read-only doctor", () => {
  it("reports the selected SDK executable once without inspecting Herdr or changing files", async () => {
    const f = fixture();
    const before = f.snapshot();
    expect(await runDoctor({ repoPath: f.repo, runtime: "sdk", codexPath: f.codex })).toEqual({
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

  it("discovers the exact Herdr session and workspace in order without changing files", async () => {
    const f = fixture();
    const before = f.snapshot();
    expect(
      await runDoctor({ repoPath: f.repo, runtime: "herdr", codexPath: f.codex }),
    ).toMatchObject({
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

  it("does not fall back or continue when the selected executable is missing", async () => {
    const f = fixture();
    rmSync(f.codex);
    const before = f.snapshot();
    await expect(
      runDoctor({ repoPath: f.repo, runtime: "herdr", codexPath: f.codex }),
    ).rejects.toThrow(`Executable unavailable: ${f.codex}`);
    expect(f.calls()).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  });

  it("does not discover Herdr or retry when version verification fails", async () => {
    const f = fixture({ versionFails: true });
    await expect(
      runDoctor({ repoPath: f.repo, runtime: "herdr", codexPath: f.codex }),
    ).rejects.toThrow("failed with exit code 7: token=[REDACTED] version unavailable");
    expect(f.calls()).toEqual(["codex --version"]);
  });

  it("fails if Herdr is unavailable on the selected PATH", async () => {
    const f = fixture();
    rmSync(f.herdr);
    await expect(
      runDoctor({ repoPath: f.repo, runtime: "herdr", codexPath: f.codex }),
    ).rejects.toThrow("Executable unavailable: herdr");
    expect(f.calls()).toEqual(["codex --version"]);
  });

  it.each([
    {
      options: { incompatible: true },
      message: "protocol compatibility could not be verified",
      calls: ["codex --version", "herdr status server"],
    },
    {
      options: { ambiguous: true },
      message: "Cannot identify the caller's exact named Herdr session",
      calls: ["codex --version", "herdr status server", "herdr session list --json"],
    },
  ])("stops discovery on $message", async ({ options, message, calls }) => {
    const f = fixture(options);
    const before = f.snapshot();
    await expect(
      runDoctor({ repoPath: f.repo, runtime: "herdr", codexPath: f.codex }),
    ).rejects.toThrow(message);
    expect(f.calls()).toEqual(calls);
    expect(f.snapshot()).toEqual(before);
  });
});
