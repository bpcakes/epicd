import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import {
  assertEpicBrowserSelection,
  epicBrowserItems,
  type EpicBrowserSnapshot,
} from "../src/epic-browser.js";
import type { DiscoveredEpic } from "../src/domain/epic-discovery.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { RunOperator } from "../src/operator-controls.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const epic = (id: string, parent?: string): DiscoveredEpic => ({
  id,
  title: `Epic ${id}`,
  priority: 2,
  status: "open",
  details: "available",
  parentIds: parent ? [parent] : [],
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-browser-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.db");
  const store = new StateStore(path);
  cleanup.push(() => store.close());
  const repoPath = join(root, "repo");
  const commonDirectory = { path: join(repoPath, ".git"), device: "1", inode: "2" };
  const epics = [epic("demo"), epic("unrelated-id", "demo"), epic("demo.lookalike")];
  const snapshot = (): EpicBrowserSnapshot => ({
    repoPath,
    commonDirectory,
    offset: 0,
    nextOffset: null,
    epics,
    items: epicBrowserItems(store, repoPath, commonDirectory, epics),
  });
  const create = () =>
    store.create(
      { ...initialRun(), repoPath, runtime: "herdr" },
      RepositoryPolicySchema.parse({ schemaVersion: 1 }),
    );
  return { path, store, snapshot, create };
}

it("lists fresh epics and uses tracker relationships rather than ID prefixes for nesting", () => {
  const f = fixture(),
    s = f.snapshot();
  expect(s.items.map((item) => [item.epic.id, item.parentIds, item.action.kind])).toEqual([
    ["demo", [], "start"],
    ["unrelated-id", ["demo"], "start"],
    ["demo.lookalike", [], "start"],
  ]);
  expect(f.store.list()).toEqual([]);
});

it("blocks only new starts for oversized epics and keeps saved-run capabilities available", () => {
  const f = fixture(),
    s = f.snapshot();
  const partial: DiscoveredEpic = { ...s.epics[0]!, details: "too_large", parentIds: null };
  const choices = () =>
    epicBrowserItems(f.store, s.repoPath, s.commonDirectory, [partial, ...s.epics.slice(1)]);
  expect(choices()[0]!.action).toMatchObject({
    kind: "unavailable",
    reason: expect.stringContaining("too large"),
  });
  expect(choices()[1]!.action.kind).toBe("start");
  const state = f.create();
  expect(choices()[0]!.action).toMatchObject({ kind: "resume", runId: state.runId });
  f.store.acquireLease(state.runId);
  expect(choices()[0]!.action).toMatchObject({ kind: "control", runId: state.runId });
});

it("asks for a narrower search before starting an epic whose detail budget was exhausted", () => {
  const f = fixture(),
    s = f.snapshot();
  const partial: DiscoveredEpic = {
    ...s.epics[0]!,
    title: null,
    details: "budget_exhausted",
    parentIds: null,
  };
  const [item] = epicBrowserItems(f.store, s.repoPath, s.commonDirectory, [partial]);
  expect(item!.action).toMatchObject({
    kind: "unavailable",
    reason: expect.stringContaining("Search for this epic's ID"),
  });
  expect(item!.notice).toContain("read budget");
  expect(() =>
    assertEpicBrowserSelection(f.store, { ...s, epics: [partial], items: [item!] }, item!),
  ).toThrow("Search for this epic's ID");
  expect(f.snapshot().items[0]!.action.kind).toBe("start");
  expect(f.store.list()).toEqual([]);
});

it("shows a stopped owning run with its recorded runtime and blocks other epics without mutating state", () => {
  const f = fixture(),
    state = f.create();
  f.store.orchestration.operatorControl(state.runId, 0, { kind: "pause" });
  const before = f.store.orchestration.control(state.runId),
    s = f.snapshot();
  expect(s.items[0]!.action).toEqual({
    kind: "resume",
    runId: state.runId,
    controlVersion: 1,
    status: "paused",
    runtime: "herdr",
    accounts: ["Accounts: no runtime configuration"],
  });
  expect(s.items[1]!.action).toMatchObject({
    kind: "unavailable",
    reason: expect.stringContaining(state.runId),
  });
  expect(f.store.orchestration.control(state.runId)).toEqual(before);
  expect(f.store.controllerLease(state.runId)).toBeNull();
});

it("offers the operator console for a live run and rejects a stale resume confirmation", () => {
  const f = fixture(),
    state = f.create(),
    previous = f.snapshot();
  const lease = f.store.acquireLease(state.runId);
  expect(f.snapshot().items[0]!.action).toMatchObject({ kind: "control", runId: state.runId });
  expect(() => assertEpicBrowserSelection(f.store, previous, previous.items[0]!)).toThrow(
    "Run status changed",
  );
  expect(f.store.controllerLease(state.runId)?.leaseId).toBe(lease.leaseId);
});

it("allows opening the same live console after normal settings and control updates", () => {
  const f = fixture(),
    state = f.create(),
    lease = f.store.acquireLease(state.runId);
  const before = f.snapshot();
  f.store.updateAgentSettingsWithLease(state.runId, lease.ownerToken, {
    ...state.agentSettings,
    review: { ...state.agentSettings.review, model: "new-review-model" },
  });
  expect(f.store.orchestration.control(state.runId).controlVersion).toBeGreaterThan(0);
  expect(() => assertEpicBrowserSelection(f.store, before, before.items[0]!)).not.toThrow();
  const current = f.store.orchestration.control(state.runId);
  f.store.orchestration.operatorControl(state.runId, current.controlVersion, { kind: "pause" });
  expect(() => assertEpicBrowserSelection(f.store, before, before.items[0]!)).not.toThrow();
  expect(f.store.controllerLease(state.runId)?.leaseId).toBe(lease.leaseId);
});

it("opens the console to answer a paused run's pending question before resuming", async () => {
  const f = fixture(),
    state = f.create(),
    lease = f.store.acquireLease(state.runId);
  const escalationId = f.store.orchestration.setEscalation(
    { runId: state.runId, ...lease },
    "Which scope?",
    "scope",
    [],
  );
  f.store.releaseLease(state.runId, lease.ownerToken);
  f.store.orchestration.operatorControl(
    state.runId,
    f.store.orchestration.control(state.runId).controlVersion,
    { kind: "pause" },
  );
  const before = f.store.orchestration.control(state.runId),
    snapshot = f.snapshot();
  expect(snapshot.items[0]!.action).toMatchObject({
    kind: "control",
    status: "paused",
    runId: state.runId,
  });
  assertEpicBrowserSelection(f.store, snapshot, snapshot.items[0]!);
  const operator = new RunOperator(f.store, state.runId);
  await operator.submit({
    kind: "respond",
    escalationId,
    controlVersion: before.controlVersion,
    message: "Use the declared scope",
  });
  await operator.settle();
  expect(f.store.orchestration.pendingEscalation(state.runId)).toBeNull();
  expect(f.store.orchestration.control(state.runId).status).toBe("active");
  expect(f.snapshot().items[0]!.action.kind).toBe("resume");
  expect(f.store.controllerLease(state.runId)).toBeNull();
});

it("rejects a stale new-run confirmation and a changed control version", () => {
  const f = fixture(),
    previous = f.snapshot(),
    state = f.create();
  expect(() => assertEpicBrowserSelection(f.store, previous, previous.items[0]!)).toThrow(
    "Run status changed",
  );
  const current = f.snapshot();
  f.store.orchestration.operatorControl(state.runId, 0, { kind: "pause" });
  expect(() => assertEpicBrowserSelection(f.store, current, current.items[0]!)).toThrow(
    "Run status changed",
  );
  expect(f.store.orchestration.control(state.runId).status).toBe("paused");
});

it("keeps the owning run selectable when its epic is no longer in the open list", () => {
  const f = fixture(),
    state = f.create(),
    s = f.snapshot();
  const items = epicBrowserItems(f.store, s.repoPath, s.commonDirectory, []);
  expect(items).toHaveLength(1);
  expect(items[0]!.epic.title).toBe(state.epicTitle);
  expect(items[0]!.epic).toMatchObject({ priority: null, status: null });
  expect(items[0]!.parentIds).toBeNull();
  expect(items[0]!.action).toMatchObject({ kind: "resume", runId: state.runId });
});

it.each([
  { status: "active", kind: "resume" },
  { status: "paused", kind: "resume" },
  { status: "awaiting_user", kind: "control" },
  { status: "paused_question", kind: "control" },
  { status: "live", kind: "control" },
  { status: "invalid", kind: "unavailable" },
])("keeps $status saved-run authority independent of tracker metadata", ({ status, kind }) => {
  const f = fixture(),
    state = f.create();
  if (["awaiting_user", "paused_question", "live"].includes(status)) {
    const lease = f.store.acquireLease(state.runId);
    if (status !== "live") {
      f.store.orchestration.setEscalation(
        { runId: state.runId, ...lease },
        "Which scope?",
        "scope",
        [],
      );
      f.store.releaseLease(state.runId, lease.ownerToken);
    }
  }
  if (status === "paused" || status === "paused_question")
    f.store.orchestration.operatorControl(
      state.runId,
      f.store.orchestration.control(state.runId).controlVersion,
      { kind: "pause" },
    );
  if (status === "invalid") {
    const db = new Database(f.path);
    try {
      db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{invalid", state.runId);
    } finally {
      db.close();
    }
  }
  const s = f.snapshot(),
    expected = s.items[0]!.action;
  expect(expected).toMatchObject({ kind, runId: state.runId });
  const control = f.store.orchestration.control(state.runId),
    lease = f.store.controllerLease(state.runId);
  const full = s.epics[0]!;
  const variants: DiscoveredEpic[][] = [
    [full],
    [{ ...full, details: "too_large", parentIds: null }],
    [{ ...full, title: null, details: "too_large", parentIds: null }],
    [{ ...full, title: null, details: "budget_exhausted", parentIds: null }],
    [],
  ];
  for (const epics of variants) {
    const items = epicBrowserItems(f.store, s.repoPath, s.commonDirectory, epics);
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toEqual(expected);
    const confirm = () => assertEpicBrowserSelection(f.store, { ...s, epics, items }, items[0]!);
    if (status === "invalid") expect(confirm).toThrow("invalid saved state");
    else expect(confirm).not.toThrow();
  }
  expect(f.store.orchestration.control(state.runId)).toEqual(control);
  expect(f.store.controllerLease(state.runId)).toEqual(lease);
});

it("preserves invalid saved state and refuses selection instead of creating a replacement run", () => {
  const f = fixture(),
    state = f.create();
  const db = new Database(f.path);
  cleanup.push(() => db.close());
  db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{invalid", state.runId);
  const s = f.snapshot();
  expect(s.items[0]!.action).toMatchObject({
    kind: "unavailable",
    reason: expect.stringContaining("invalid saved state"),
  });
  expect(() => assertEpicBrowserSelection(f.store, s, s.items[0]!)).toThrow("invalid saved state");
  expect(db.prepare("SELECT state_json FROM runs").get()).toEqual({ state_json: "{invalid" });
});
