import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/util/redact.js";

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
});
