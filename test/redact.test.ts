import { describe, expect, it } from "vitest";
import { redactDiagnosticValue, redactSensitiveText } from "../src/util/redact.js";

describe("sensitive text redaction", () => {
  it("redacts assignments, credential flags, bearer values, and URL passwords", () => {
    const value = redactSensitiveText(
      "OPENAI_API_KEY=alpha tool --token beta Authorization: Bearer gamma https://user:delta@example.test",
    );

    for (const secret of ["alpha", "beta", "gamma", "delta"]) {
      expect(value).not.toContain(secret);
    }
    expect(value.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("preserves structured fields and output after credential lines before JSON serialization", () => {
    const original = {
      stdout: "password=private-value\n" + "x".repeat(14000) + " END\n",
      stderr: "--token hidden-token",
      status: "failed",
      exitCode: 7,
      nested: [{ password: "hidden-password", authorization: "hidden-header", ok: true }, null],
      escaped: 'first\n"quoted"\nlast',
    };
    const retained = JSON.parse(JSON.stringify(redactDiagnosticValue(original)));
    expect(retained).toEqual({
      ...original,
      stdout: "password=[REDACTED]\n" + "x".repeat(14000) + " END\n",
      stderr: "--token [REDACTED]",
      nested: [{ password: "[REDACTED]", authorization: "[REDACTED]", ok: true }, null],
    });
    expect(original.stdout).toContain("private-value");
    expect(original.nested[0]?.password).toBe("hidden-password");
  });

  it.each([
    "api_key",
    "api-key",
    "access_token",
    "auth-token",
    "refresh_token",
    "session_token",
    "token",
    "password",
    "client-secret",
    "secret",
    "authorization",
    "cookie",
    "set-cookie",
    "private_key",
  ])("redacts nested %s values without erasing adjacent metadata", (key) => {
    expect(redactDiagnosticValue({ nested: { [key]: "private", tail: "kept" }, after: 0 })).toEqual(
      { nested: { [key]: "[REDACTED]", tail: "kept" }, after: 0 },
    );
  });
});
