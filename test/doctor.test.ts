import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCodexExecutable: vi.fn((path: string) => ({
    executablePath: path,
    args: [],
  })),
  resolveCodexModel: vi.fn(async () => "gpt-discovered"),
  resolveSdkCodexExecutable: vi.fn(() => ({
    executablePath: "/bundled/codex",
    args: [],
  })),
  verifyCodexExecutable: vi.fn(async (_cwd: string, executable: { executablePath: string }) =>
    executable.executablePath === "/bundled/codex"
      ? "/bundled/codex — codex-test"
      : `${executable.executablePath} — codex-test`,
  ),
  runCommand: vi.fn(async () => ({ stdout: "codex-test\n", stderr: "" })),
}));

vi.mock("../src/adapters/codex-settings.js", () => ({
  resolveCodexExecutable: mocks.resolveCodexExecutable,
  resolveCodexModel: mocks.resolveCodexModel,
  resolveSdkCodexExecutable: mocks.resolveSdkCodexExecutable,
  verifyCodexExecutable: mocks.verifyCodexExecutable,
}));

vi.mock("../src/adapters/git.js", () => ({
  GitClient: class {
    constructor(private readonly path: string) {}
    async root(): Promise<string> {
      return this.path;
    }
    async status(): Promise<string> {
      return "";
    }
  },
}));

vi.mock("../src/util/command.js", () => ({
  runCommand: mocks.runCommand,
}));

vi.mock("../src/adapters/beads.js", () => ({
  BeadsClient: class {
    async versions(): Promise<{ br: string; bv: string }> {
      return { br: "br-test", bv: "bv-test" };
    }
  },
}));

import { runDoctor } from "../src/doctor.js";

const tempDirs: string[] = [];

beforeEach(() => {
  mocks.resolveCodexExecutable.mockClear();
  mocks.resolveCodexModel.mockClear();
  mocks.resolveSdkCodexExecutable.mockClear();
  mocks.verifyCodexExecutable.mockClear();
  mocks.runCommand.mockClear();
  mocks.runCommand.mockImplementation(async () => ({ stdout: "codex-test\n", stderr: "" }));
  mocks.resolveSdkCodexExecutable.mockImplementation(() => ({
    executablePath: "/bundled/codex",
    args: [],
  }));
});

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), "epicd-doctor-"));
  tempDirs.push(path);
  mkdirSync(join(path, ".beads"));
  return path;
}

describe("runDoctor", () => {
  it("keeps model discovery out of normal launch preflight", async () => {
    const result = await runDoctor(repository(), "sdk");

    expect(mocks.resolveCodexModel).not.toHaveBeenCalled();
    expect(mocks.verifyCodexExecutable).toHaveBeenCalledWith(process.cwd(), {
      executablePath: "/bundled/codex",
      args: [],
    });
    expect(result.checks.some((check) => check.name === "Codex SDK model discovery")).toBe(false);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails normal preflight when the SDK shim cannot launch its platform binary", async () => {
    mocks.verifyCodexExecutable.mockRejectedValueOnce(new Error("Missing optional dependency"));

    const result = await runDoctor(repository(), "sdk");

    expect(result.checks).toContainEqual({
      name: "Codex SDK runtime",
      status: "fail",
      message: "Missing optional dependency",
    });
  });

  it("fails normal preflight when a bare executable override is not on PATH", async () => {
    mocks.verifyCodexExecutable.mockRejectedValueOnce(new Error("spawn missing-codex ENOENT"));

    const result = await runDoctor(repository(), "sdk", { codexPath: "missing-codex" });

    expect(mocks.resolveCodexExecutable).toHaveBeenCalledWith("missing-codex");
    expect(result.checks).toContainEqual({
      name: "Codex SDK runtime",
      status: "fail",
      message: "spawn missing-codex ENOENT",
    });
  });

  it("probes model discovery when explicitly requested by the doctor command", async () => {
    const repoPath = repository();
    const result = await runDoctor(repoPath, "sdk", { probeModelDiscovery: true });

    expect(mocks.resolveCodexModel).toHaveBeenCalledWith(repoPath, {
      executable: { executablePath: "/bundled/codex", args: [] },
    });
    expect(result.checks).toContainEqual({
      name: "Codex SDK model discovery",
      status: "pass",
      message: "gpt-discovered",
    });
  });

  it("probes an explicitly selected Codex executable", async () => {
    const repoPath = repository();
    await runDoctor(repoPath, "sdk", { probeModelDiscovery: true, codexPath: "/local/codex" });

    expect(mocks.resolveCodexExecutable).toHaveBeenCalledWith("/local/codex");
    expect(mocks.resolveSdkCodexExecutable).not.toHaveBeenCalled();
    expect(mocks.resolveCodexModel).toHaveBeenCalledWith(repoPath, {
      executable: { executablePath: "/local/codex", args: [] },
    });
  });

  it("reports a missing SDK binary as a warning for cleanup-only preflight", async () => {
    mocks.resolveSdkCodexExecutable.mockImplementationOnce(() => {
      throw new Error("bundled Codex is missing");
    });

    const result = await runDoctor(repository(), "sdk", { mode: "cleanup" });

    expect(result.checks).toContainEqual({
      name: "Codex SDK runtime",
      status: "warn",
      message: "bundled Codex is missing",
    });
  });

  it("allows cleanup-only Herdr preflight outside a managed pane", async () => {
    const previous = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    try {
      const result = await runDoctor(repository(), "herdr", { mode: "cleanup" });

      expect(result.checks).toContainEqual({
        name: "Herdr environment",
        status: "warn",
        message: "HERDR_ENV is not required for cleanup through the running Herdr server",
      });
      expect(result.checks.some((check) => check.name === "Herdr Codex integration")).toBe(false);
      expect(result.checks.every((check) => check.status !== "fail")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = previous;
    }
  });

  it("rejects a Codex executable override for the Herdr runtime", async () => {
    const result = await runDoctor(repository(), "herdr", { codexPath: "/local/codex" });

    expect(result.checks).toContainEqual({
      name: "Codex executable override",
      status: "fail",
      message: "--codex-path applies only to the sdk runtime",
    });
  });

  it("checks repository selection prerequisites without assuming an agent runtime", async () => {
    const result = await runDoctor(repository(), "sdk", { mode: "selection" });

    expect(mocks.resolveSdkCodexExecutable).not.toHaveBeenCalled();
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(result.checks.map((check) => check.name)).toEqual([
      "Git repository",
      "Beads workspace",
      "br",
      "bv",
      "Working tree",
    ]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });
});
