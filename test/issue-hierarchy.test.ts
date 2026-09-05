import { describe, expect, it } from "vitest";
import { compareIssuesDeepestFirst, isIssueDescendant } from "../src/domain/issue-hierarchy.js";

describe("issue hierarchy", () => {
  it.each([
    ["epic.1.child", "epic.1", true],
    ["epic.1.child.deep", "epic.1", true],
    ["epic.1", "epic.1", false],
    ["epic.10", "epic.1", false],
    ["epic.10.child", "epic.1", false],
    ["epic.2", "epic.1", false],
    ["epic", "epic.1", false],
  ] as const)("classifies %s under %s as %s", (id, ancestor, expected) => {
    expect(isIssueDescendant({ id }, { id: ancestor })).toBe(expected);
  });

  it("orders deepest issues first and preserves sibling order", () => {
    const issues = ["epic", "epic.10", "epic.1", "epic.1.child", "other"].map((id) => ({ id }));

    expect(issues.toSorted(compareIssuesDeepestFirst).map((issue) => issue.id)).toEqual([
      "epic.1.child",
      "epic.10",
      "epic.1",
      "epic",
      "other",
    ]);
  });
});
