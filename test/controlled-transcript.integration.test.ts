import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlledTranscript } from "../src/adapters/controlled-transcript.js";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { SdkAgentSessionContractSchema } from "../src/domain/types.js";
import { fixtureAccounts } from "./fixtures/accounts.js";
import { transcriptFixture } from "./fixtures/codex-transcript.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(budget = 100 * 1024 * 1024) {
  const s = await transcriptFixture();
  const path = join(s.root, "journal.sqlite3");
  let store = new StateStore(path);
  cleanups.push(async () => {
    store.close();
    await rm(s.root, { recursive: true, force: true });
  });
  const initial = initialRun();
  initial.runtimeConfiguration = {
    commonDirectory: { path: join(s.root, ".git"), device: "1", inode: "1" },
    executable: process.execPath,
    trackerExecutable: process.execPath,
    runtimeRoot: join(s.root, "runtime"),
    workspaceRoot: join(s.root, "copies"),
    accounts: fixtureAccounts(s.root),
    turnTimeoutMs: 15_000,
    herdr: null,
  };
  const state = store.create(
    initial,
    RepositoryPolicySchema.parse({ schemaVersion: 1, budgets: { artifactBytes: budget } }),
  );
  const fixtureDatabase = new Database(path);
  fixtureDatabase.prepare("DELETE FROM tracker_roots WHERE run_id = ?").run(state.runId);
  fixtureDatabase.close();
  const lease = store.acquireLease(state.runId);
  const authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
  const version = () => store.orchestration.control(state.runId).controlVersion;
  const workspace = store.orchestration.agents.reserveWorkspace(
    authority,
    {
      root: join(s.root, "copies"),
      purpose: "implementation",
      sourceMode: "mutable",
      baselineRevision: "synthetic-baseline",
    },
    version(),
  );
  await mkdir(workspace.path, { recursive: true, mode: 0o700 });
  store.orchestration.agents.markWorkspaceReady(authority, workspace, "synthetic-fingerprint");
  const settings = { model: "gpt-6-astra", reasoningEffort: "high" };
  const agent = store.orchestration.agents.reserveAgent(
    authority,
    {
      ...workspace,
      role: "implementation",
      purpose: "implementation",
      taskId: "demo.1",
      candidateId: null,
      instructions: "Inspect diagnostic output",
      confinementProfile: "epicd-isolated",
      contract: SdkAgentSessionContractSchema.parse({
        backend: "codex",
        runtime: "sdk",
        requested: settings,
        effective: settings,
      }),
    },
    version(),
  );
  const turn = store.orchestration.agents.prepareTurn(
    authority,
    agent,
    randomUUID(),
    "Inspect diagnostic output",
    { type: "object" },
    version(),
  );
  const observer = (prompt = s.prompt) =>
    new ControlledTranscript(store.orchestration, authority, turn.identity, s.launch, prompt);
  const observations = () =>
    store.orchestration
      .observations(state.runId, 0, 1000)
      .filter((row) => row.source === "codex-transcript");
  const check = () => store.orchestration.assertAuthority(authority);
  return {
    ...s,
    authority,
    turn,
    observer,
    observations,
    check,
    get journal() {
      return store.orchestration;
    },
    reopen: () => {
      store.close();
      store = new StateStore(path);
    },
    expire: () => {
      store.releaseLease(state.runId, lease.ownerToken);
      store.acquireLease(state.runId);
    },
  };
}

describe("durable transcript ingestion (diagnostic only)", () => {
  it("retains repeated quota snapshots without waking a waiting coordinator", async () => {
    const s = await fixture();
    const observer = s.observer();
    await observer.poll(s.session, s.check);
    const cursor = s.observations().at(-1)!.id;
    await s.append(s.rateLimits() + s.rateLimits());
    await observer.poll(s.session, s.check);
    expect(
      s.observations().filter((row) => row.kind === "runtime.transcript_rate_limits"),
    ).toHaveLength(2);
    expect(s.journal.observations(s.authority.runId, cursor, 1, true)).toEqual([]);
    await s.append(s.call() + s.output() + s.complete);
    await observer.finish(s.session, s.check);
    expect(
      s.journal.observations(s.authority.runId, cursor, 100, true).map((row) => row.kind),
    ).toEqual([
      "runtime.transcript_tool_call",
      "runtime.transcript_tool_result",
      "runtime.transcript_turn_finished",
    ]);
  });

  it("retains a zero-credit snapshot as diagnostics without changing the turn", async () => {
    const s = await fixture();
    await s.append(s.rateLimits() + s.complete);
    await s.observer().finish(s.session, s.check);
    const snapshot = s.observations().find((row) => row.kind === "runtime.transcript_rate_limits")!;
    expect(
      JSON.parse(
        s.journal.diagnostics.read(s.authority.runId, snapshot.artifactIds[0]!, 0, 65536).text,
      ),
    ).toMatchObject({
      sessionId: s.session,
      providerTurnId: s.providerTurn,
      limitId: "premium",
      credits: { hasCredits: false, unlimited: false, balance: "0" },
    });
    expect(s.journal.agents.turn(s.authority.runId, s.turn.identity)).toEqual(s.turn);
  });

  it.each(["model", "reasoning_effort", "both"])(
    "preserves quota provenance across a cold reopen after %s metadata arrives",
    async (missing) => {
      const s = await fixture();
      const db = new Database(s.statePath);
      try {
        db.prepare("UPDATE threads SET model = ?, reasoning_effort = ?").run(
          missing === "reasoning_effort" ? s.launch.model : null,
          missing === "model" ? s.launch.reasoningEffort : null,
        );
        await s.append(s.rateLimits());
        await s.observer().poll(s.session, s.check);
        const before = s.observations();
        const snapshot = before.find((row) => row.kind === "runtime.transcript_rate_limits")!;
        const retained = s.journal.diagnostics.retained(
          s.authority.runId,
          snapshot.artifactIds[0]!,
        );
        expect(JSON.parse(retained.text)).toMatchObject({ association: "advisory" });
        db.prepare("UPDATE threads SET model = ?, reasoning_effort = ?").run(
          s.launch.model,
          s.launch.reasoningEffort,
        );
        await s.append(s.rateLimits({ limit_id: "later" }) + s.call() + s.output() + s.complete);
        s.reopen();
        await s.observer().finish(s.session, s.check);
        expect(s.observations().slice(0, before.length)).toEqual(before);
        expect(s.journal.diagnostics.retained(s.authority.runId, snapshot.artifactIds[0]!)).toEqual(
          retained,
        );
        const snapshots = s
          .observations()
          .filter((row) => row.kind === "runtime.transcript_rate_limits");
        expect(snapshots).toHaveLength(2);
        expect(
          JSON.parse(
            s.journal.diagnostics.retained(s.authority.runId, snapshots[1]!.artifactIds[0]!).text,
          ),
        ).toMatchObject({
          association: "turn_scoped",
          model: s.launch.model,
          reasoningEffort: s.launch.reasoningEffort,
          limitId: "later",
        });
        expect(s.observations().at(-1)!.kind).toBe("runtime.transcript_turn_finished");
        const after = s.observations(),
          usage = s.journal.diagnostics.usage(s.authority.runId);
        s.reopen();
        await s.observer().finish(s.session, s.check);
        expect(s.observations()).toEqual(after);
        expect(s.journal.diagnostics.usage(s.authority.runId)).toEqual(usage);
      } finally {
        db.close();
      }
    },
  );

  it("preserves quota provenance when retrying a later journal failure", async () => {
    const s = await fixture();
    const db = new Database(s.statePath);
    try {
      db.prepare("UPDATE threads SET model = NULL, reasoning_effort = NULL").run();
      await s.append(s.rateLimits() + s.call() + s.output() + s.complete);
      const observer = s.observer();
      const original = s.journal.diagnostics.append.bind(s.journal.diagnostics);
      let calls = 0;
      const spy = vi.spyOn(s.journal.diagnostics, "append").mockImplementation((...args) => {
        if (++calls === 3) throw new Error("injected persistence failure");
        return original(...args);
      });
      await expect(observer.poll(s.session, s.check)).rejects.toThrow(
        "injected persistence failure",
      );
      const before = s.observations();
      expect(before).toHaveLength(2);
      db.prepare("UPDATE threads SET model = ?, reasoning_effort = ?").run(
        s.launch.model,
        s.launch.reasoningEffort,
      );
      spy.mockRestore();
      await observer.finish(s.session, s.check);
      expect(s.observations().slice(0, 2)).toEqual(before);
      expect(s.observations()).toHaveLength(5);
      expect(s.journal.diagnostics.usage(s.authority.runId).count).toBe(5);
    } finally {
      db.close();
    }
  });

  it.each([false, true])(
    "replays redacted quota diagnostics with a legacy wake flag of %s",
    async (legacyWake) => {
      const s = await fixture();
      const db = new Database(s.statePath);
      try {
        db.prepare("UPDATE threads SET model = NULL, reasoning_effort = NULL").run();
        await s.append(s.rateLimits({ limit_name: "token=never-retain-quota-secret" }));
        const append = s.journal.diagnostics.append.bind(s.journal.diagnostics);
        const spy = vi
          .spyOn(s.journal.diagnostics, "append")
          .mockImplementation((authority, input, text, truncated) =>
            append(
              authority,
              input.kind === "runtime.transcript_rate_limits"
                ? { ...input, wakesOrchestrator: legacyWake }
                : input,
              text,
              truncated,
            ),
          );
        await s.observer().poll(s.session, s.check);
        spy.mockRestore();
        const before = s.observations();
        const retained = s.journal.diagnostics.retained(
          s.authority.runId,
          before[1]!.artifactIds[0]!,
        );
        expect(retained.text).not.toContain("never-retain-quota-secret");
        db.prepare("UPDATE threads SET model = ?, reasoning_effort = ?").run(
          s.launch.model,
          s.launch.reasoningEffort,
        );
        await s.append(s.call() + s.output() + s.complete);
        s.reopen();
        await s.observer().finish(s.session, s.check);
        expect(s.observations().slice(0, 2)).toEqual(before);
        expect(s.observations()).toHaveLength(5);
        expect(
          s.journal.diagnostics.retained(s.authority.runId, before[1]!.artifactIds[0]!),
        ).toEqual(retained);
      } finally {
        db.close();
      }
    },
  );

  it("rejects changed quota bytes after private model metadata arrives", async () => {
    const s = await fixture();
    const db = new Database(s.statePath);
    try {
      db.prepare("UPDATE threads SET model = NULL").run();
      const initial = s.prefix + s.rateLimits({ access_token: "token-one" }) + s.complete;
      await writeFile(s.path, initial);
      await s.observer().finish(s.session, s.check);
      db.prepare("UPDATE threads SET model = ?").run(s.launch.model);
      await writeFile(s.path, initial.replace("token-one", "token-two"));
      s.reopen();
      await expect(s.observer().finish(s.session, s.check)).rejects.toThrow(
        "reused with different content",
      );
      expect(s.observations()).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("replays after a cold reopen without duplicate observations, charges or invented evidence", async () => {
    const s = await fixture();
    await s.append(s.call() + s.output() + s.complete);
    await s.observer().finish(s.session, s.check);
    const usage = s.journal.diagnostics.usage(s.authority.runId);
    const before = s.observations();
    expect(before).toHaveLength(4);
    s.reopen();
    await s.observer().finish(s.session, s.check);
    expect(s.observations()).toEqual(before);
    expect(s.journal.diagnostics.usage(s.authority.runId)).toEqual(usage);
    expect(s.journal.agents.turn(s.authority.runId, s.turn.identity)).toEqual(s.turn);
    expect(s.journal.delivery.summaries(s.authority.runId)).toMatchObject({
      candidates: [],
      validation: [],
    });
    const failure = before.find((row) => row.kind === "runtime.transcript_tool_result")!;
    const artifact = s.journal.diagnostics.read(
      s.authority.runId,
      failure.artifactIds[0]!,
      0,
      65536,
    );
    expect(artifact.text).toContain("peer authentication failed");
    expect(artifact.text).not.toContain("never-retain-password");
  });

  it("detects source rewrites even when the changed bytes would both be redacted", async () => {
    const s = await fixture();
    const first = s.prefix + s.call() + s.output("token=one") + s.complete;
    await writeFile(s.path, first);
    await s.observer().finish(s.session, s.check);
    await writeFile(s.path, first.replace("token=one", "token=two"));
    s.reopen();
    await expect(s.observer().finish(s.session, s.check)).rejects.toThrow(
      "reused with different content",
    );
    expect(s.observations()).toHaveLength(4);
  });

  it.each(["missing", "unmatched", "unfinished", "partial"])(
    "records an explicit %s observation gap without changing turn state",
    async (mode) => {
      const s = await fixture();
      if (mode === "missing") await rename(s.path, s.path + ".saved");
      if (mode === "partial") await s.append(s.call() + s.output() + s.complete + "{partial");
      const observer = s.observer(mode === "unmatched" ? s.prompt + "different" : s.prompt);
      await observer.finish(s.session, s.check);
      await observer.finish(s.session, s.check);
      const gaps = s.observations().filter((row) => row.kind === "runtime.observation_gap");
      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.summary).toContain("Retained diagnostics are incomplete");
      expect(s.journal.agents.turn(s.authority.runId, s.turn.identity)).toEqual(s.turn);
    },
  );

  it("publishes during an active watch, then joins it before final drain", async () => {
    const s = await fixture();
    const observer = s.observer(),
      failure = vi.fn();
    const stop = observer.watch(() => s.session, s.check, failure);
    try {
      await vi.waitFor(() => expect(s.observations()).toHaveLength(1), { timeout: 3000 });
      await s.append(s.call() + s.output());
      await vi.waitFor(() => expect(s.observations()).toHaveLength(3), { timeout: 3000 });
    } finally {
      await stop();
    }
    expect(failure).not.toHaveBeenCalled();
    await s.append(s.complete);
    await observer.finish(s.session, s.check);
    expect(s.observations()).toHaveLength(4);
    expect(s.journal.agents.turn(s.authority.runId, s.turn.identity).stopEvidence).toBeNull();
  });

  it("recovers parser state after a mid-batch journal failure without duplicating earlier records", async () => {
    const s = await fixture();
    await s.append(s.call() + s.output() + s.complete);
    const observer = s.observer();
    const original = s.journal.diagnostics.append.bind(s.journal.diagnostics);
    const spy = vi.spyOn(s.journal.diagnostics, "append");
    let calls = 0;
    spy.mockImplementation((...args) => {
      if (++calls === 3) throw new Error("injected persistence failure");
      return original(...args);
    });
    await expect(observer.poll(s.session, s.check)).rejects.toThrow("injected persistence failure");
    expect(s.observations()).toHaveLength(2);
    spy.mockRestore();
    await observer.finish(s.session, s.check);
    expect(s.observations()).toHaveLength(4);
    expect(s.journal.diagnostics.usage(s.authority.runId).count).toBe(4);
  });

  it("stops observation after authority loss and reports the failure to its transport", async () => {
    const s = await fixture();
    const observer = s.observer(),
      failure = vi.fn();
    const stop = observer.watch(() => s.session, s.check, failure);
    try {
      await vi.waitFor(() => expect(s.observations()).toHaveLength(1), { timeout: 3000 });
      s.expire();
      await s.append(s.call() + s.output());
      await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce(), { timeout: 3000 });
    } finally {
      await stop();
    }
    expect(s.observations()).toHaveLength(1);
    await expect(observer.finish(s.session, s.check)).rejects.toThrow();
  });

  it("makes diagnostic budget exhaustion explicit instead of silently dropping results", async () => {
    const s = await fixture(1);
    await expect(s.observer().finish(s.session, s.check)).rejects.toThrow("budget_exhausted");
    expect(s.journal.diagnostics.usage(s.authority.runId)).toMatchObject({
      count: 1,
      retainedBytes: 0,
    });
    expect(s.observations()[0]!.summary).toContain("budget_exhausted");
    expect(s.journal.agents.turn(s.authority.runId, s.turn.identity).stopEvidence).toBeNull();
  });
});
