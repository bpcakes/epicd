import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { KernelActionSchema, type KernelAction } from "../src/domain/orchestration.js";
import { digestJson } from "../src/domain/repository-policy.js";
import { fixture, check, success, target, waitFor } from "./fixtures/review.js";

async function setup() {
  const s = await fixture(check, "sha1", undefined, undefined, { writableScratch: ["scratch"] }),
    validationPlanId = await s.define(),
    candidate = await s.capture(validationPlanId),
    copy = await s.copy(candidate);
  const { stage: _stage, ...command } = check;
  const action = (
    delta: Partial<typeof command> = {},
  ): Extract<KernelAction, { kind: "run_diagnostic_check" }> => ({
    kind: "run_diagnostic_check",
    ...candidate,
    ...target(copy),
    validationPlanId,
    check: { ...command, ...delta },
  });
  const run = async (delta: Partial<typeof command> = {}) => {
    const result = success(await s.dispatch(action(delta)));
    if (result.kind !== "validation") throw new Error("Expected check result");
    return { result, evidence: s.journal.delivery.evidence(s.authority.runId, result.evidenceId) };
  };
  return { s, candidate, copy, validationPlanId, action, run };
}

describe.skipIf(process.platform !== "linux")("model-selected diagnostic checks", () => {
  it("records a real green diagnostic without satisfying, weakening or replacing the required check", async () => {
    const f = await setup();
    const before = f.s.journal.delivery.plan(f.s.authority.runId, f.validationPlanId);
    const { result, evidence } = await f.run();
    expect(result).toMatchObject({ outcome: "succeeded", satisfiesCheck: false });
    expect(evidence).toMatchObject({
      purpose: "diagnostic",
      check: { ...check, stage: "pre_commit" },
      sourceUnchanged: true,
      environmentVerified: true,
      outcome: { processTreeStopped: true, exitCode: 0 },
    });
    expect(f.s.journal.delivery.preCommitEvidence(f.s.authority.runId, f.candidate)).toMatchObject({
      evidence: [],
      missingCheckIds: [check.id],
    });
    const inspected = success(
      await f.s.dispatch({ kind: "inspect_evidence", evidenceId: evidence.evidenceId }),
    );
    if (inspected.kind !== "inspection") throw new Error("Expected evidence inspection");
    expect(JSON.parse(inspected.text)).toMatchObject({
      purpose: "diagnostic",
      satisfiesCheck: false,
      evidenceWarning: expect.stringContaining("Never satisfies"),
    });
    const delivery = await f.s.validate(f.candidate, f.copy);
    expect(delivery).toMatchObject({ kind: "validation", satisfiesCheck: true });
    const failure = await f.run({ args: ["-c", "echo diagnostic-failure; exit 17"] });
    expect(failure.result).toMatchObject({ outcome: "failed", satisfiesCheck: false });
    // Reusing a check ID for diagnosis must neither approve nor shadow delivery evidence.
    if (delivery.kind !== "validation") throw new Error("Expected delivery evidence");
    expect(f.s.journal.delivery.satisfiesCheck(f.s.authority.runId, delivery.evidenceId)).toBe(
      true,
    );
    expect(f.s.journal.delivery.plan(f.s.authority.runId, f.validationPlanId)).toEqual(before);
  });

  it("denies source writes while retaining their actual failed outcome", async () => {
    const f = await setup();
    const { result, evidence } = await f.run({ args: ["-c", "printf changed > app.txt"] });
    expect(result).toMatchObject({ outcome: "failed", satisfiesCheck: false });
    expect(evidence.sourceUnchanged).toBe(true);
    expect(readFileSync(join(f.copy.path, "app.txt"), "utf8")).toBe("green\n");
    expect(readFileSync(join(f.s.workspace.path, "app.txt"), "utf8")).toBe("green\n");
    expect(readFileSync(join(f.s.source, "app.txt"), "utf8")).toBe("red\n");
  });

  it("rejects independent review citations that try to use diagnostic success as delivery evidence", async () => {
    const f = await setup(),
      { evidence } = await f.run();
    const delivery = await f.s.validate(f.candidate, f.copy);
    if (delivery.kind !== "validation") throw new Error("Expected delivery validation");
    const reviewed = await f.s.review(f.candidate, {
      validationEvidenceIds: [delivery.evidenceId, evidence.evidenceId],
    });
    expect(reviewed.evidence.failure).toContain("unsupplied finding or validation result");
    expect(f.s.journal.reviews.approval(f.s.authority.runId, f.candidate)).toBeNull();
  });

  it("runs an actual loopback client/server inside private validation networking without granting host access", async () => {
    const f = await setup();
    const script = `import os, socket
assert not os.path.exists(${JSON.stringify(f.s.path)}), 'host journal exposed'
with socket.socket() as server, socket.socket() as client:
    server.bind(('127.0.0.1', 0))
    server.listen(1)
    client.connect(server.getsockname())
    peer, _ = server.accept()
    with peer:
        peer.sendall(b'private-loopback-ok')
        print(client.recv(128).decode(), end='')
`;
    const { result, evidence } = await f.run({ command: "/usr/bin/python3", args: ["-c", script] });
    expect(result, JSON.stringify(evidence.outcome)).toMatchObject({
      outcome: "succeeded",
      satisfiesCheck: false,
    });
    expect(evidence.outcome?.stdout).toBe("private-loopback-ok");
    expect(evidence.fixtureAccessIds).toEqual([]);
  });

  it("rejects undeclared service bindings and mutable or mismatched targets before command dispatch", async () => {
    const f = await setup();
    expect(await f.s.dispatch(f.action({ environmentBindings: ["not-declared"] }))).toMatchObject({
      status: "rejected",
      code: "fixture_bridge_unavailable",
    });
    expect(await f.s.dispatch({ ...f.action(), ...target(f.s.workspace) })).toMatchObject({
      status: "rejected",
    });
    expect(
      await f.s.dispatch({
        ...f.action(),
        candidateGeneration: f.candidate.candidateGeneration + 1,
      }),
    ).toMatchObject({ status: "rejected" });
    expect(f.s.journal.delivery.summaries(f.s.authority.runId).validation).toEqual([]);
    expect(f.s.journal.agents.activeWorkspaceOperation(f.s.authority.runId, f.copy)).toBeNull();
  });

  it("replays one admitted action without running the diagnostic again", async () => {
    const f = await setup(),
      decision = f.s.decision(f.action());
    const running = await f.s.kernel.execute(decision, f.s.authority);
    if (running.status !== "running") throw new Error("Expected running check");
    const result = await f.s.kernel.operation(running.operationId)!;
    expect(await f.s.kernel.execute(decision, f.s.authority)).toEqual(result);
    expect(f.s.journal.delivery.summaries(f.s.authority.runId).validation).toHaveLength(1);
  });

  it("bounds a diagnostic by its timeout and retains process-stop evidence before workspace reuse", async () => {
    const f = await setup();
    const { result, evidence } = await f.run({ args: ["-c", "sleep 30"], timeoutMs: 100 });
    expect(result).toMatchObject({ outcome: "timed_out", satisfiesCheck: false });
    expect(evidence.outcome?.processTreeStopped).toBe(true);
    expect(
      f.s.journal.agents.workspaceOperation(f.s.authority.runId, evidence.workspaceOperationId)
        .stopEvidence,
    ).not.toBeNull();
    expect(f.s.journal.agents.activeWorkspaceOperation(f.s.authority.runId, f.copy)).toBeNull();
  });

  it("interrupts active diagnosis without accepting late output or permitting overlapping use", async () => {
    const f = await setup();
    const running = await f.s.kernel.execute(
      f.s.decision(
        f.action({ args: ["-c", "while :; do printf x >> scratch/heartbeat; sleep 0.03; done"] }),
      ),
      f.s.authority,
    );
    if (running.status !== "running") throw new Error("Expected running check");
    const pending = f.s.kernel.operation(running.operationId)!;
    await waitFor(() => existsSync(join(f.copy.path, "scratch", "heartbeat")));
    expect(await f.s.dispatch(f.action())).toMatchObject({ status: "rejected" });
    f.s.kernel.interruptAll();
    expect(await pending).toMatchObject({ status: "cancelled" });
    const evidence = f.s.journal.delivery.validationForOperation(
      f.s.authority.runId,
      running.operationId,
    )!;
    expect(evidence).toMatchObject({
      purpose: "diagnostic",
      status: "finished",
      outcome: { status: "cancelled", processTreeStopped: true },
    });
    expect(f.s.journal.delivery.satisfiesCheck(f.s.authority.runId, evidence.evidenceId)).toBe(
      false,
    );
    expect(f.s.journal.agents.activeWorkspaceOperation(f.s.authority.runId, f.copy)).toBeNull();
    const stopped = readFileSync(join(f.copy.path, "scratch", "heartbeat"));
    await delay(100);
    expect(readFileSync(join(f.copy.path, "scratch", "heartbeat"))).toEqual(stopped);
  });

  it.each(["purpose", "command", "command-with-updated-digest"])(
    "rejects retained %s corruption instead of converting diagnostic output into delivery evidence",
    async (mode) => {
      const f = await setup(),
        { evidence } = await f.run();
      const db = new Database(f.s.path);
      try {
        const changed = structuredClone(evidence);
        if (mode === "purpose") changed.purpose = "delivery";
        else {
          changed.check.args = ["-c", "echo forged"];
          if (mode === "command-with-updated-digest")
            changed.commandDigest = digestJson(changed.check);
        }
        db.prepare("UPDATE validation_evidence SET record_json = ? WHERE evidence_id = ?").run(
          JSON.stringify(changed),
          evidence.evidenceId,
        );
        expect(() =>
          f.s.journal.delivery.evidence(f.s.authority.runId, evidence.evidenceId),
        ).toThrow();
        db.prepare("UPDATE validation_evidence SET record_json = ? WHERE evidence_id = ?").run(
          JSON.stringify(evidence),
          evidence.evidenceId,
        );
      } finally {
        db.close();
      }
    },
  );

  it("rejects escaping cwd, caller-supplied phase and oversized command metadata", async () => {
    const f = await setup();
    for (const check of [
      { ...f.action().check, cwd: "../outside" },
      { ...f.action().check, stage: "exact_revision" },
      { ...f.action().check, args: Array.from({ length: 5 }, () => "x".repeat(4096)) },
    ])
      expect(KernelActionSchema.safeParse({ ...f.action(), check }).success).toBe(false);
  });
});
