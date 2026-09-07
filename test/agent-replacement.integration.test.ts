import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { fixture, finding, resource, target } from "./fixtures/review.js";

describe.runIf(process.platform === "linux")("orchestrator-chosen agent replacement", () => {
  it("reserves a new generation in a fresh workspace and preserves the old private delta", async () => {
    const f = await fixture();
    const ws = await f.manager.create(f.authority, f.source, f.head, "implementation");
    const request = f.decision({
      kind: "replace_agent",
      ...target(ws),
      agentId: f.writer.agentId,
      agentGeneration: f.writer.agentGeneration,
      reason: "Try another implementation approach",
      instructions: "Inspect the preserved delta before changing the new copy",
    });
    const first = await f.kernel.execute(request, f.authority);
    const replacement = resource(first);
    expect(replacement).toMatchObject({ resourceId: f.writer.agentId, generation: 2 });
    expect(await f.kernel.execute(request, f.authority)).toEqual(first);
    expect(f.journal.agents.instances(f.authority.runId)).toHaveLength(2);
    expect(f.journal.agents.instance(f.authority.runId, f.writer).status).toBe("released");
    expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("quarantined");
    expect(readFileSync(join(f.workspace.path, "app.txt"), "utf8")).toBe("green\n");
    expect(readFileSync(join(ws.path, "app.txt"), "utf8")).toBe("red\n");
    expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("red\n");
    const next = f.journal.agents.instance(f.authority.runId, {
      agentId: replacement.resourceId,
      agentGeneration: replacement.generation,
    });
    expect(next).toMatchObject({
      status: "reserved",
      provider: null,
      activeTurnId: null,
      workspaceId: ws.workspaceId,
    });
    expect(f.journal.agents.turns(f.authority.runId)).toEqual([]);
    const reopened = new StateStore(f.path);
    try {
      expect(reopened.orchestration.agents.instance(f.authority.runId, next)).toEqual(next);
      expect(reopened.orchestration.control(f.authority.runId).decisionsUsed).toBe(1);
    } finally {
      reopened.close();
    }
    expect((await f.dispatch({ ...request.request.action })).status).toBe("rejected");
    expect(f.journal.agents.instances(f.authority.runId)).toHaveLength(2);
  });
  it("requires exact stop proof and does not revoke or start a replacement while a turn is unsettled", async () => {
    const f = await fixture();
    const turn = f.journal.agents.prepareTurn(
      f.authority,
      f.writer,
      "prepared-operation",
      "Implement",
      { type: "object" },
      f.journal.control(f.authority.runId).controlVersion,
    );
    const ws = await f.manager.create(f.authority, f.source, f.head, "implementation");
    expect(
      await f.dispatch({
        kind: "replace_agent",
        ...target(ws),
        agentId: f.writer.agentId,
        agentGeneration: 1,
        reason: "Drifting",
        instructions: "Diagnose",
      }),
    ).toMatchObject({ status: "rejected", code: "agent_not_stopped" });
    expect(f.journal.agents.instance(f.authority.runId, f.writer).status).toBe("busy");
    expect(f.journal.agents.instances(f.authority.runId)).toHaveLength(1);
    f.journal.agents.cancelPreparedTurn(f.authority, turn.identity);
    expect(
      (
        await f.dispatch({
          kind: "replace_agent",
          ...target(ws),
          agentId: f.writer.agentId,
          agentGeneration: 1,
          reason: "Stopped",
          instructions: "Diagnose",
        })
      ).status,
    ).toBe("succeeded");
  });
  it.each(["same_workspace", "wrong_workspace_role", "wrong_generation"] as const)(
    "rejects %s without retiring the original assignment",
    async (variant) => {
      const f = await fixture();
      const ws =
        variant === "same_workspace"
          ? f.workspace
          : await f.manager.create(
              f.authority,
              f.source,
              f.head,
              variant === "wrong_workspace_role" ? "coordinator" : "implementation",
            );
      const before = f.journal.agents.instance(f.authority.runId, f.writer);
      const version = f.journal.control(f.authority.runId).controlVersion;
      expect(
        (
          await f.dispatch({
            kind: "replace_agent",
            ...target(ws),
            agentId: f.writer.agentId,
            agentGeneration: variant === "wrong_generation" ? 2 : 1,
            reason: "Replace",
            instructions: "Continue the same assignment",
          })
        ).status,
      ).toBe("rejected");
      expect(f.journal.agents.instance(f.authority.runId, f.writer)).toEqual(before);
      expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("ready");
      expect(f.journal.control(f.authority.runId).controlVersion).toBe(version);
    },
  );
  it("rolls back revocation and reservation if the action result cannot be committed", async () => {
    const f = await fixture();
    const ws = await f.manager.create(f.authority, f.source, f.head, "implementation");
    const db = new Database(f.path);
    try {
      db.exec(
        "CREATE TRIGGER fail_replacement_result BEFORE UPDATE OF result_json ON actions WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'result unavailable'); END",
      );
      const version = f.journal.control(f.authority.runId).controlVersion;
      await expect(
        f.dispatch({
          kind: "replace_agent",
          ...target(ws),
          agentId: f.writer.agentId,
          agentGeneration: 1,
          reason: "Replace",
          instructions: "Preserve context",
        }),
      ).rejects.toThrow("result unavailable");
      expect(f.journal.agents.instances(f.authority.runId)).toEqual([f.writer]);
      expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("ready");
      expect(f.journal.control(f.authority.runId).controlVersion).toBe(version);
    } finally {
      db.close();
    }
  });
  it("replaces a contaminated reviewer without losing findings or accepting approval from the revoked generation", async () => {
    const f = await fixture();
    const candidate = await f.capture(await f.define());
    await f.validate(candidate, await f.copy(candidate));
    const old = await f.review(candidate, { verdict: "changes_requested", findings: [finding] });
    const previous = old.evidence.turnIdentity!;
    const found = f.journal.reviews.openFindings(f.authority.runId, candidate);
    writeFileSync(join(old.reviewCopy.path, "receipt.txt"), "retained diagnostic receipt\n");
    const ws = await f.copy(candidate);
    const replacement = resource(
      await f.dispatch({
        kind: "replace_agent",
        ...target(ws),
        agentId: previous.agentId,
        agentGeneration: previous.agentGeneration,
        reason: "The old verification copy is contaminated",
        instructions: "Use no-receipt checks and assess all retained findings",
      }),
    );
    expect(f.journal.reviews.openFindings(f.authority.runId, candidate)).toEqual(found);
    expect(f.journal.agents.turn(f.authority.runId, previous).resultEligible).toBe(false);
    expect(readFileSync(join(old.reviewCopy.path, "receipt.txt"), "utf8")).toContain(
      "retained diagnostic",
    );
    f.response(f.report(candidate));
    expect(
      (
        await f.dispatch({
          kind: "run_review",
          ...candidate,
          ...target(ws),
          agent: { agentId: replacement.resourceId, agentGeneration: replacement.generation },
          instructions: "Assess remaining findings",
        })
      ).status,
    ).toBe("succeeded");
    const evidence = f.journal.reviews.records(f.authority.runId).at(-1)!;
    expect(evidence.turnIdentity).toMatchObject({ agentId: previous.agentId, agentGeneration: 2 });
    expect(
      f.journal.agents.turn(f.authority.runId, evidence.turnIdentity!).prompt.reviewContext,
    ).toMatchObject({ findings: found });
    expect(f.journal.reviews.approval(f.authority.runId, candidate)).toBeNull();
    expect(f.journal.reviews.openFindings(f.authority.runId, candidate)).toEqual(found);
  });
  it("cannot retarget a reviewer to another candidate while replacing its conversation", async () => {
    const f = await fixture();
    const plan = await f.define();
    const first = await f.capture(plan);
    const old = await f.review(first, { verdict: "changes_requested", findings: [finding] });
    const original = f.journal.agents.instance(f.authority.runId, old.evidence.turnIdentity!);
    writeFileSync(join(f.workspace.path, "app.txt"), "another candidate\n");
    const next = await f.capture(plan);
    const ws = await f.copy(next);
    expect(
      await f.dispatch({
        kind: "replace_agent",
        ...target(ws),
        agentId: original.agentId,
        agentGeneration: original.agentGeneration,
        reason: "Different candidate",
        instructions: "Do not relabel the old review conversation",
      }),
    ).toMatchObject({ status: "rejected", code: "replacement_candidate_mismatch" });
    expect(f.journal.agents.instance(f.authority.runId, original)).toEqual(original);
    expect(f.journal.reviews.openFindings(f.authority.runId, next)).toHaveLength(1);
  });
});
