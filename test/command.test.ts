import process from "node:process";
import { describe, expect, it } from "vitest";
import { CommandError, runCommand, runJson } from "../src/util/command.js";

describe("command runner", () => {
  it("preserves stderr and reports a bounded timeout", async () => {
    const result = runCommand(
      process.execPath,
      [
        "-e",
        "process.stderr.write(process.env.EPICD_TEST_OUTPUT + '\\n'); setTimeout(() => {}, 5000)",
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 50,
        env: { ...process.env, EPICD_TEST_OUTPUT: "private-command-output" },
      },
    );
    await expect(result).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof CommandError &&
        error.result.stderr.includes("Timed out after 50ms") &&
        !error.message.includes("private-command-output")
      );
    });
  });

  it("rejects malformed JSON instead of treating it as an empty result", async () => {
    await expect(
      runJson(process.execPath, ["-e", "process.stdout.write('not-json')"], { cwd: process.cwd() }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("returned invalid JSON") &&
        !error.message.includes("not-json"),
    );
  });
});
