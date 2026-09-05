import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { parseModelArgument } from "../src/cli-options.js";

describe("CLI model arguments", () => {
  it("normalizes a nonblank model identifier", () => {
    expect(parseModelArgument("  gpt-test  ")).toBe("gpt-test");
  });

  it.each(["", "   ", "\t"])("rejects a blank model identifier %#", (value) => {
    expect(() => parseModelArgument(value)).toThrow(InvalidArgumentError);
    expect(() => parseModelArgument(value)).toThrow("must not be blank");
  });
});
