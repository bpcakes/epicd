import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerInspectionCapabilities } from "../src/kernel/inspection.js";
import { fixture, check, git, success, target } from "./fixtures/review.js";
import { receiptProject, receiptFaultDriver, RECEIPT_FILES } from "./fixtures/receipt-incident.js";

describe.skipIf(process.platform !== "linux")("receipt-only review contamination", () => {
  it("uses equivalent comparisons with and without append-only receipts", async () => {
    const s = await fixture(check, "sha1", undefined, (source) =>
      receiptProject(source, "app.txt"),
    );
    const before = RECEIPT_FILES.map((path) => readFileSync(join(s.workspace.path, path), "utf8"));
    execFileSync("/bin/sh", ["tools/check.sh", "--no-receipts"], {
      cwd: s.workspace.path,
      timeout: 5000,
    });
    expect(RECEIPT_FILES.map((path) => readFileSync(join(s.workspace.path, path), "utf8"))).toEqual(
      before,
    );
    execFileSync("/bin/sh", ["tools/check.sh"], { cwd: s.workspace.path, timeout: 5000 });
    for (const [index, path] of RECEIPT_FILES.entries()) {
      expect(readFileSync(join(s.workspace.path, path), "utf8")).toBe(
        before[index] + "validated application output\n",
      );
    }
    expect(git(s.workspace.path, "diff", "--name-only").split("\n").sort()).toEqual(
      ["app.txt", ...RECEIPT_FILES].sort(),
    );
    expect(readFileSync(join(s.workspace.path, "app.txt"), "utf8")).toBe("green\n");
  });

  it("rejects an actual receipt delta, exposes its retained evidence and approves a fresh copy without restoring unknown changes", async () => {
    const s = await fixture(check, "sha1", undefined, (source) =>
      receiptProject(source, "app.txt"),
    );
    registerInspectionCapabilities(s.kernel, s.manager);
    const candidate = await s.capture(await s.define());
    await s.validate(candidate, await s.copy(candidate));
    const incident = receiptFaultDriver(s.journal, s.driver, join(s.root, "managed"));
    s.driver.run = incident.driver.run;
    const originalIndex = readFileSync(join(s.source, ".git/index"));
    writeFileSync(join(s.source, "app.txt"), "operator-owned concurrent edit\n");
    const first = await s.review(candidate, {}, ["/bin/sh tools/check.sh --no-receipts"]);
    expect(first.result.status).toBe("failed");
    expect(first.evidence).toMatchObject({ status: "finished", sourceIntact: false, report: null });
    expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBeNull();
    const fault = incident.fault;
    expect(fault).not.toBeNull();
    if (!fault) throw new Error("The receipt fault did not occur");
    expect(s.journal.agents.turn(s.authority.runId, fault.identity).resultEligible).toBe(false);
    expect(git(fault.workspacePath, "diff", "--name-only").split("\n").sort()).toEqual(
      [...RECEIPT_FILES].sort(),
    );
    const retained = s.journal.diagnostics.read(s.authority.runId, fault.artifactId, 0, 65536);
    expect(JSON.parse(retained.text)).toMatchObject({ faultInjection: true, deltas: fault.deltas });
    for (const delta of fault.deltas) {
      const result = success(
        await s.dispatch({
          kind: "inspect_repo",
          ...target(first.reviewCopy),
          operation: "read",
          path: delta.path,
          query: null,
          offset: 0,
          limit: 1000,
        }),
      );
      if (result.kind !== "inspection") throw new Error("Expected retained-copy inspection");
      expect(result.text).toContain("validated application output");
      expect(delta.after).toBe(delta.before + "validated application output\n");
    }
    // A second external writer's edit must remain in the old, ineligible copy too.
    writeFileSync(join(fault.workspacePath, "app.txt"), "unknown-writer edit\n");
    const next = await s.review(candidate, {}, ["/bin/sh tools/check.sh --no-receipts"]);
    expect(next.result.status).toBe("succeeded");
    expect(next.reviewCopy.workspaceId).not.toBe(first.reviewCopy.workspaceId);
    expect(next.evidence).toMatchObject({ sourceIntact: true, report: { verdict: "approved" } });
    expect(s.journal.reviews.approval(s.authority.runId, candidate)).toBe(next.evidence.evidenceId);
    expect(incident.fault).toEqual(fault); // No second forced failure or scripted recovery.
    expect(readFileSync(join(fault.workspacePath, "app.txt"), "utf8")).toBe(
      "unknown-writer edit\n",
    );
    for (const delta of fault.deltas) {
      expect(readFileSync(join(fault.workspacePath, delta.path), "utf8")).toBe(delta.after);
      expect(readFileSync(join(next.reviewCopy.path, delta.path), "utf8")).toBe(delta.before);
    }
    expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe(
      "operator-owned concurrent edit\n",
    );
    expect(readFileSync(join(s.source, ".git/index"))).toEqual(originalIndex);
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
    expect(s.journal.control(s.authority.runId).status).toBe("active");
  });
});
