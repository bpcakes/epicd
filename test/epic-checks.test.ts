import { describe, expect, it } from "vitest";
import { collectEpicChecks } from "../src/adapters/epic-delivery.js";
import { RequiredCheckSchema } from "../src/domain/repository-policy.js";

const check = RequiredCheckSchema.parse({
  id: "test",
  command: "/bin/sh",
  args: ["-c", "test -s app.txt"],
  cwd: ".",
  timeoutMs: 5000,
  stage: "pre_commit",
});
describe("epic check aggregation", () => {
  it("promotes pre-commit checks, reuses exactly identical commands and exposes their provenance", () => {
    expect(
      collectEpicChecks(
        [check],
        [
          { taskId: "epic.1", checks: [{ ...check, id: "task-test" }] },
          { taskId: "epic.2", checks: [{ ...check, stage: "exact_revision" }] },
        ],
      ),
    ).toEqual({
      checks: [{ ...check, stage: "both" }],
      bindings: [
        { taskId: "epic.1", checkId: "task-test", finalCheckId: "test" },
        { taskId: "epic.2", checkId: "test", finalCheckId: "test" },
      ],
    });
  });
  it.each([
    { args: ["-c", "test -s other.txt"] },
    { cwd: "subdir" },
    { timeoutMs: 6000 },
    { environmentBindings: ["private-db"] },
  ])("retains distinct commands despite a shared task-local name: %j", (change) => {
    const tasks = [
      { taskId: "epic.1", checks: [check] },
      { taskId: "epic.2", checks: [{ ...check, ...change }] },
    ];
    const result = collectEpicChecks([], tasks);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[1]).toMatchObject({ ...change, stage: "both" });
    expect(result.checks[1]!.id).not.toBe("test");
    expect(result.bindings[1]).toEqual({
      taskId: "epic.2",
      checkId: "test",
      finalCheckId: result.checks[1]!.id,
    });
    expect(collectEpicChecks([], tasks)).toEqual(result);
  });
  it("does not hide conflicting policy or epic reviewer requirements by renaming them", () => {
    expect(() => collectEpicChecks([check, { ...check, args: ["-c", "true"] }], [])).toThrow(
      "distinct ID",
    );
  });
});
