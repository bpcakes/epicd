import { describe, expect, it } from "vitest";
import { progressBar, shortId } from "../src/ui/format.js";

describe("TUI formatting", () => {
  it("renders bounded progress without overflowing", () => {
    expect(progressBar(5, 10, 10)).toBe("█████░░░░░");
    expect(progressBar(20, 10, 4)).toBe("████");
    expect(progressBar(0, 0, 3)).toBe("░░░");
  });

  it("keeps absent and long identifiers readable", () => {
    expect(shortId(null)).toBe("—");
    expect(shortId("1234567890abcdef", 8)).toBe("12345678");
  });
});
