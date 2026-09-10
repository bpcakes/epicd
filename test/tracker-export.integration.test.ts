import { fixtureAccounts } from "./fixtures/accounts.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { KernelBeads } from "../src/adapters/kernel-beads.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { reconcileTracker, registerTrackerCapabilities } from "../src/kernel/tracker.js";
import { NamespaceStopUnprovenError } from "../src/adapters/pid-namespace.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type {
  ControllerAuthority,
  KernelAction,
  OrchestratorDecision,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function fixture(realBr?: string) {
  const root = mkdtempSync("/var/tmp/epicd-tracker-export-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"),
    beads = join(repo, ".beads"),
    statePath = join(root, "state.db");
  mkdirSync(repo);
  let epicId = "demo",
    source: Database.Database | null = null;
  const executable = realBr ?? join(root, "br-fixture");
  if (realBr) {
    const home = join(root, "fixture-home");
    mkdirSync(home);
    const br = (args: string[]) => {
      const result = execFileSync(
        realBr,
        [...args, "--json", "--no-auto-import", "--no-auto-flush"],
        {
          cwd: repo,
          env: { PATH: process.env.PATH, HOME: home, RUST_LOG: "error" },
          encoding: "utf8",
          timeout: 30000,
        },
      );
      return args[0] === "init" ? null : JSON.parse(result);
    };
    br(["init", "--prefix", "demo"]);
    epicId = br([
      "create",
      "Delivery",
      "--type",
      "epic",
      "--description",
      "Deliver concrete behavior",
    ]).id;
    const child = br([
      "create",
      "Task",
      "--description",
      "Implement behavior",
      "--acceptance-criteria",
      "It works",
    ]).id;
    br(["dep", "add", child, epicId, "--type", "parent-child"]);
    br([
      "close",
      child,
      "--reason",
      "Fixture completed before export",
      "--session",
      "fixture-session",
    ]);
  } else {
    mkdirSync(beads);
    source = new Database(join(beads, "beads.db"));
    source.pragma("journal_mode = WAL");
    source.exec(
      "CREATE TABLE fixture_issues (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE fixture_export (value TEXT); INSERT INTO fixture_export VALUES ('dirty source');",
    );
    const issue = (id: string, parents: string[], type = "task") => ({
      id,
      title: id,
      description: "Required behavior",
      acceptance_criteria: "The behavior works",
      issue_type: type,
      status: "open",
      priority: 1,
      labels: [],
      assignee: null,
      parents,
    });
    for (const row of [
      issue("demo", [], "epic"),
      issue("work-a", ["demo"]),
      issue("unrelated", []),
    ])
      source.prepare("INSERT INTO fixture_issues VALUES (?, ?)").run(row.id, JSON.stringify(row));
    cleanups.push(() => source!.close());
    writeFileSync(
      executable,
      `#!/usr/bin/python3
import json, os, sys, sqlite3, hashlib
from pathlib import Path
directory, args = Path('/workspace/.beads'), sys.argv[1:]
db = sqlite3.connect(str(directory/'beads.db'))
data = [json.loads(x[0]) for x in db.execute('SELECT body FROM fixture_issues ORDER BY id')]
by_id = lambda id: next(x for x in data if x['id'] == id)
def edge(id): return {'id':id,'dependency_type':'parent-child','status':by_id(id)['status']}
def row(x): return {**x,'dependencies':[edge(id) for id in x['parents']],'dependents':[edge(y['id']) for y in data if x['id'] in y['parents']]}
if args[0] == 'show': print(json.dumps([row(by_id(id)) for id in args[1:args.index('--db')]]))
elif args[0] == 'ready': print(json.dumps([row(x) for x in data if x['parents'] == ['demo'] and x['status'] == 'open']))
elif args[0] == 'sync':
    assert '--flush-only' in args and '--error-policy' in args and 'strict' in args
    output = ''.join(json.dumps({**x,'dependencies':[{'issue_id':x['id'],'depends_on_id':id,'type':'parent-child'} for id in x['parents']]},separators=(',',':'))+'\\n' for x in data).encode()
    Path(os.environ['BEADS_JSONL']).write_bytes(output)
    db.execute("UPDATE fixture_export SET value = 'snapshot exported'"); db.commit()
    print(json.dumps({'exported_issues':len(data),'policy':'strict','success_rate':1,'errors':[],'content_hash':hashlib.sha256(output).hexdigest()}))
else: sys.exit('unexpected command')
`,
      { mode: 0o700 },
    );
  }
  writeFileSync(join(beads, "issues.jsonl"), "user-owned unflushed JSONL\n");
  writeFileSync(join(beads, "beads.base.jsonl"), "user-owned base\n");
  let store = new StateStore(statePath);
  cleanups.push(() => store.close());
  const run = initialRun(`export-${randomUUID()}`);
  run.repoPath = repo;
  run.epicId = epicId;
  run.runtimeConfiguration = {
    commonDirectory: { path: join(root, "unused-git"), device: "1", inode: "1" },
    executable: realpathSync(process.execPath),
    trackerExecutable: realpathSync(executable),
    runtimeRoot: join(root, "runtime"),
    workspaceRoot: join(root, "workspaces"),
    accounts: fixtureAccounts(),
    turnTimeoutMs: 30000,
    herdr: null,
  };
  store.create(run, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  let lease = store.acquireLease(run.runId);
  const authority = (): ControllerAuthority => ({
    runId: run.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  });
  const transport = new KernelBeads(realpathSync(executable));
  let kernel = new ActionKernel(store.orchestration),
    adapter = registerTrackerCapabilities(kernel, transport);
  const decision = (action: KernelAction): OrchestratorDecision => {
    const journal = store.orchestration;
    const ticket = journal.beginDecision(
      authority(),
      journal.latestObservationCursor(run.runId),
      journal.control(run.runId).controlVersion,
    );
    return {
      explanation: "Retain an exact tracker snapshot without rewriting user files",
      evidenceIds: [],
      request: {
        schemaVersion: 1,
        decisionId: ticket.decisionId,
        observationCursor: ticket.observationCursor,
        expectedControlVersion: ticket.expectedControlVersion,
        action,
      },
    };
  };
  const execute = async (decision: OrchestratorDecision) => {
    const result = await kernel.execute(decision, authority());
    return result.status === "running" ? (await kernel.operation(result.operationId))! : result;
  };
  const reserve = () => {
    const admitted = store.orchestration.acceptAction(
      authority(),
      decision({ kind: "export_tracker" }),
    );
    if (admitted.kind !== "accepted") throw new Error("Export admission failed");
    store.orchestration.startAction(authority(), admitted.action.actionId);
    return store.orchestration.tracker.reserve(authority(), admitted.action.actionId);
  };
  return {
    root,
    repo,
    beads,
    run,
    source,
    transport,
    decision,
    execute,
    reserve,
    dispatch: (action: KernelAction) => execute(decision(action)),
    get store() {
      return store;
    },
    get journal() {
      return store.orchestration;
    },
    get kernel() {
      return kernel;
    },
    get authority() {
      return authority();
    },
    get adapter() {
      return adapter;
    },
    latest: () =>
      store.orchestration.tracker
        .operations(run.runId)
        .findLast((entry) => entry.kind === "export")!,
    reopen: () => {
      store.releaseLease(run.runId, lease.ownerToken);
      store.close();
      store = new StateStore(statePath);
      lease = store.acquireLease(run.runId);
      kernel = new ActionKernel(store.orchestration);
      adapter = registerTrackerCapabilities(kernel, transport);
    },
  };
}

describe.skipIf(process.platform !== "linux")("isolated tracker export", () => {
  it("retains a WAL-aware full export without flushing the authoritative database or user JSONL", async () => {
    const f = fixture(),
      before = f.source!.prepare("SELECT * FROM fixture_issues ORDER BY id").all();
    expect((await f.dispatch({ kind: "export_tracker" })).status).toBe("succeeded");
    const record = f.latest(),
      text = f.journal.tracker.exportBytes(f.run.runId, record.trackerOperationId);
    expect(record).toMatchObject({
      kind: "export",
      outcome: "exported",
      ioStopped: true,
      mutationDispatched: false,
      export: {
        metadata: { sha256: hash(text), issueCount: 3, byteLength: Buffer.byteLength(text) },
      },
    });
    expect(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).id),
    ).toEqual(["demo", "unrelated", "work-a"]);
    expect(f.source!.prepare("SELECT * FROM fixture_issues ORDER BY id").all()).toEqual(before);
    expect(f.source!.prepare("SELECT value FROM fixture_export").pluck().get()).toBe(
      "dirty source",
    );
    expect(readFileSync(join(f.beads, "issues.jsonl"), "utf8")).toBe(
      "user-owned unflushed JSONL\n",
    );
    expect(readFileSync(join(f.beads, "beads.base.jsonl"), "utf8")).toBe("user-owned base\n");
  });

  it("returns the original export on replay even after the source changes", async () => {
    const f = fixture(),
      decision = f.decision({ kind: "export_tracker" });
    const result = await f.execute(decision),
      record = f.latest();
    f.source!.prepare("UPDATE fixture_export SET value = 'later user state'").run();
    expect(await f.execute(decision)).toEqual(result);
    expect(f.latest()).toEqual(record);
    expect(f.journal.tracker.operations(f.run.runId)).toHaveLength(1);
  });

  it.each(["scope", "relation", "instructions", "missing"])(
    "rejects a self-consistent export hash with altered %s data",
    async (variant) => {
      const f = fixture(),
        original = f.transport.exportSnapshot.bind(f.transport);
      vi.spyOn(f.transport, "exportSnapshot").mockImplementation(async (...args) => {
        const report = await original(...args);
        const path = join(args[0].directory.path, "issues.jsonl");
        let rows = readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (variant === "scope")
          rows.find((row) => row.id === "demo").description = "Unproven scope";
        else if (variant === "relation") rows.find((row) => row.id === "work-a").dependencies = [];
        else if (variant === "instructions")
          rows.find((row) => row.id === "demo").agent_context = {
            instructions: "Unproven agent guidance",
          };
        else rows = rows.filter((row) => row.id !== "demo");
        const bytes = rows.map((row) => JSON.stringify(row) + "\n").join("");
        writeFileSync(path, bytes);
        return { ...report, content_hash: hash(bytes), exported_issues: rows.length };
      });
      expect((await f.dispatch({ kind: "export_tracker" })).status).toBe("failed");
      expect(f.latest()).toMatchObject({ outcome: "failed", export: { metadata: null } });
      expect(readFileSync(join(f.beads, "issues.jsonl"), "utf8")).toBe(
        "user-owned unflushed JSONL\n",
      );
    },
  );

  it("rolls back retained bytes and their metadata if the audit write fails", async () => {
    const f = fixture(),
      original = f.journal.appendObservation.bind(f.journal);
    vi.spyOn(f.journal, "appendObservation").mockImplementation((authority, input) => {
      if (input.kind === "tracker.export_retained") throw new Error("Fixture audit failure");
      return original(authority, input);
    });
    expect((await f.dispatch({ kind: "export_tracker" })).status).toBe("failed");
    expect(f.latest().export!.metadata).toBeNull();
    const db = new Database(join(f.root, "state.db"), { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) FROM tracker_exports").pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("preserves a concurrent source edit and retains a stale export as a conflict", async () => {
    const f = fixture(),
      original = f.adapter.exporter.export.bind(f.adapter.exporter);
    vi.spyOn(f.adapter.exporter, "export").mockImplementation(async (...args) => {
      const result = await original(...args);
      const row = JSON.parse(
        f
          .source!.prepare("SELECT body FROM fixture_issues WHERE id='demo'")
          .pluck()
          .get() as string,
      );
      row.description = "New requirements during export";
      f.source!.prepare("UPDATE fixture_issues SET body=? WHERE id='demo'").run(
        JSON.stringify(row),
      );
      writeFileSync(join(f.beads, "issues.jsonl"), "new user edit\n");
      return result;
    });
    expect((await f.dispatch({ kind: "export_tracker" })).status).toBe("failed");
    expect(f.latest().outcome).toBe("conflict");
    expect(f.journal.tracker.exportBytes(f.run.runId, f.latest().trackerOperationId)).not.toContain(
      "New requirements during export",
    );
    expect(readFileSync(join(f.beads, "issues.jsonl"), "utf8")).toBe("new user edit\n");
  });

  it("cold-settles a lost action result from retained bytes without exporting again", async () => {
    const f = fixture(),
      intent = f.reserve();
    await f.adapter.execute(f.authority, intent.trackerOperationId, new AbortController().signal);
    const retained = f.journal.tracker.exportBytes(f.run.runId, intent.trackerOperationId);
    f.reopen();
    const exporter = vi.spyOn(f.adapter.exporter, "export");
    await reconcileTracker(f.kernel, f.adapter, f.authority, intent.trackerOperationId);
    expect(exporter).not.toHaveBeenCalled();
    expect(f.journal.action(f.run.runId, intent.actionId)?.status).toBe("succeeded");
    expect(f.journal.tracker.exportBytes(f.run.runId, intent.trackerOperationId)).toBe(retained);
  });

  it("cold-reconciles retained bytes after losing the live scope observation", async () => {
    const f = fixture(),
      intent = f.reserve();
    const graph = f.transport.graph.bind(f.transport);
    const observation = vi.spyOn(f.transport, "graph").mockImplementation(async (...args) => {
      if (args[0].repository.path === f.repo) throw new Error("Fixture lost the live observation");
      return graph(...args);
    });
    const finish = vi.spyOn(f.journal.tracker, "finish").mockImplementationOnce(() => {
      throw new Error("Fixture lost settlement after stop was recorded");
    });
    await expect(
      f.adapter.execute(f.authority, intent.trackerOperationId, new AbortController().signal),
    ).rejects.toThrow("lost settlement");
    expect(f.latest()).toMatchObject({ ioStopped: true, afterSnapshotId: null, outcome: null });
    const retained = f.journal.tracker.exportBytes(f.run.runId, intent.trackerOperationId);
    observation.mockRestore();
    finish.mockRestore();
    f.reopen();
    const exporter = vi.spyOn(f.adapter.exporter, "export");
    await reconcileTracker(f.kernel, f.adapter, f.authority, intent.trackerOperationId);
    expect(exporter).not.toHaveBeenCalled();
    expect(f.latest()).toMatchObject({ outcome: "exported", ioStopped: true });
    expect(f.journal.tracker.exportBytes(f.run.runId, intent.trackerOperationId)).toBe(retained);
  });

  it("honors cancellation before any snapshot filesystem work", async () => {
    const f = fixture(),
      intent = f.reserve(),
      abort = new AbortController();
    abort.abort(new Error("Fixture canceled export"));
    expect(
      (await f.adapter.execute(f.authority, intent.trackerOperationId, abort.signal)).outcome,
    ).toBe("failed");
    expect(f.latest()).toMatchObject({ ioStopped: true, export: { metadata: null } });
    expect(existsSync(intent.export!.directory)).toBe(false);
    expect(f.source!.prepare("SELECT value FROM fixture_export").pluck().get()).toBe(
      "dirty source",
    );
  });

  it("reconciles an unused export intent as failed without creating or deleting files", async () => {
    const f = fixture(),
      intent = f.reserve();
    f.reopen();
    await reconcileTracker(f.kernel, f.adapter, f.authority, intent.trackerOperationId);
    expect(f.latest()).toMatchObject({ outcome: "failed", ioStopped: true });
    expect(existsSync(intent.export!.directory)).toBe(false);
  });

  it("does not infer process stop from a private export directory or a new controller", async () => {
    const f = fixture();
    vi.spyOn(f.transport, "exportSnapshot").mockRejectedValueOnce(
      new NamespaceStopUnprovenError("Fixture lost its namespace monitor"),
    );
    expect((await f.dispatch({ kind: "export_tracker" })).status).toBe("indeterminate");
    const intent = f.latest();
    expect(intent).toMatchObject({ ioStopped: false, outcome: null });
    f.reopen();
    await expect(f.adapter.reconcile(f.authority, intent.trackerOperationId)).rejects.toThrow(
      "Independently prove",
    );
  });

  it("never reuses or truncates an existing export directory", async () => {
    const f = fixture(),
      intent = f.reserve();
    mkdirSync(intent.export!.directory, { recursive: true });
    const path = join(intent.export!.directory, "user-file");
    writeFileSync(path, "preserve me\n");
    expect(
      (
        await f.adapter.execute(
          f.authority,
          intent.trackerOperationId,
          new AbortController().signal,
        )
      ).outcome,
    ).toBe("failed");
    expect(readFileSync(path, "utf8")).toBe("preserve me\n");
  });

  it("detects corrupted retained bytes and preserves the raw export during quarantine", async () => {
    const f = fixture();
    expect((await f.dispatch({ kind: "export_tracker" })).status).toBe("succeeded");
    const record = f.latest();
    const db = new Database(join(f.root, "state.db"));
    try {
      db.prepare("UPDATE tracker_exports SET body='tampered' WHERE tracker_operation_id=?").run(
        record.trackerOperationId,
      );
      expect(() => f.journal.tracker.exportBytes(f.run.runId, record.trackerOperationId)).toThrow(
        "retained bytes changed",
      );
      db.prepare("UPDATE runs SET state_json='{}' WHERE run_id=?").run(f.run.runId);
      f.store.releaseLease(f.run.runId, f.authority.ownerToken);
      f.store.quarantineInvalidRun(f.run.runId);
      const raw = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id=? AND source_table='tracker_exports'",
        )
        .pluck()
        .get(f.run.runId) as string;
      expect(JSON.parse(raw)).toMatchObject({ body: "tampered" });
    } finally {
      db.close();
    }
  });

  it.runIf(!!process.env.EPICD_TEST_BR_PATH)(
    "exports installed Beads through the real confined snapshot path",
    async () => {
      const f = fixture(realpathSync(process.env.EPICD_TEST_BR_PATH!));
      expect(await f.dispatch({ kind: "export_tracker" })).toMatchObject({ status: "succeeded" });
      const record = f.latest(),
        bytes = f.journal.tracker.exportBytes(f.run.runId, record.trackerOperationId);
      expect(record.export!.metadata!.issueCount).toBe(2);
      expect(bytes).toContain(f.run.epicId);
      expect(readFileSync(join(f.beads, "issues.jsonl"), "utf8")).toBe(
        "user-owned unflushed JSONL\n",
      );
      expect(readFileSync(join(f.beads, "beads.base.jsonl"), "utf8")).toBe("user-owned base\n");
    },
    30000,
  );
});
