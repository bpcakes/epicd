import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelBeads } from "../src/adapters/kernel-beads.js";
import { NamespaceStopUnprovenError } from "../src/adapters/pid-namespace.js";
import { StateStore } from "../src/adapters/store.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerTrackerCapabilities } from "../src/kernel/tracker.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { TrackerGraphSchema } from "../src/domain/tracker.js";
import { SdkAgentSessionContractSchema } from "../src/domain/types.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import type {
  ControllerAuthority,
  KernelAction,
  OrchestratorDecision,
  ActionResult,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { fixtureAccounts } from "./fixtures/accounts.js";

const roots: string[] = [],
  stores: StateStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const success = (result: ActionResult) => {
  expect(result.status).toBe("succeeded");
  if (result.status !== "succeeded") throw new Error(JSON.stringify(result));
  return result.result;
};
const task = (id: string, parents: string[] = ["demo"], status = "open") => ({
  id,
  title: id,
  description: "Implement concrete behavior",
  acceptance_criteria: "Required behavior works",
  status,
  priority: 1,
  issue_type: "task",
  labels: [],
  assignee: null as string | null,
  parents,
  blockers: [] as string[],
});
function fixture(realBr?: string) {
  const root = mkdtempSync("/var/tmp/epicd-tracker-");
  roots.push(root);
  const repo = join(root, "repo"),
    storage = join(repo, ".beads");
  mkdirSync(repo);
  mkdirSync(storage);
  writeFileSync(join(repo, "user-file"), "user-owned\n");
  const dataPath = join(storage, "data.json"),
    logPath = join(storage, "commands.jsonl");
  const initial = [
    { ...task("demo", []), issue_type: "epic" },
    task("work-a"),
    { ...task("container"), issue_type: "epic" },
    task("deep-work", ["container"]),
    task("demo.impostor", []),
  ];
  writeFileSync(dataPath, JSON.stringify(initial));
  writeFileSync(join(storage, "beads.db"), "fake-CLI-only\n");
  const executable = realBr ?? join(root, "br-fixture");
  if (!realBr) {
    writeFileSync(
      executable,
      `#!/usr/bin/python3
import json, os, sys, signal, subprocess, time
from pathlib import Path
args, directory = sys.argv[1:], Path('/workspace/.beads')
with (directory/'commands.jsonl').open('a') as log: log.write(json.dumps(args)+'\\n')
data = json.loads((directory/'data.json').read_text())
mode = (directory/'mode').read_text() if (directory/'mode').exists() else ''
by_id = lambda id: next(x for x in data if x['id'] == id)
reachable = {'demo'}
for _ in data:
    for x in data:
        if any(p in reachable for p in x['parents']): reachable.add(x['id'])
def edge(id, kind): return {'id':id, 'dependency_type':kind, 'status':by_id(id)['status']}
def row(x): return {**x, 'dependencies':[edge(id,'parent-child') for id in x['parents']]+[edge(id,'blocks') for id in x['blockers']], 'dependents':[edge(y['id'],'parent-child') for y in data if x['id'] in y['parents']]}
def blocked(x): return any(by_id(id)['status'] != 'closed' for id in x['blockers'])
if mode == 'invalid': print('{}')
elif mode == 'oversized': print('x' * (5 * 1024 * 1024))
elif mode == 'hang':
    subprocess.Popen(['/usr/bin/python3','-c',"import time; time.sleep(1.2); open('/workspace/.beads/late','w').write('bad')"],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True: time.sleep(1)
elif mode == 'confinement':
    escaped = False
    try:
        Path(${JSON.stringify(join(repo, "user-file"))}).write_text('overwritten')
        escaped = True
    except OSError: pass
    (directory/'confinement-result').write_text(json.dumps({'escaped':escaped,'foreignEnv':os.environ.get('EPICD_TRAP')}))
    print('[]')
elif args[0] in ('list', 'search'):
    epics = sorted([x for x in data if x['issue_type'] == 'epic' and x['status'] != 'closed'], key=lambda x: (x['priority'], x['id']))
    if args[0] == 'search': epics = [x for x in epics if args[-1].lower() in (x['id']+' '+x['title']+' '+x['description']).lower()]
    offset, limit = int(args[args.index('--offset')+1]), int(args[args.index('--limit')+1])
    if mode == 'page-overflow': limit += 1
    selected = epics[offset:offset+limit]
    if mode == 'duplicate-page' and len(selected) > 1: selected[1] = selected[0]
    if '--fields' in args:
        print('id' if mode == 'summary-header' else 'id,priority,status,issue_type')
        if mode == 'summary-priority': selected[0]['priority'] = 5
        if mode == 'summary-status': selected[0]['status'] = 'invented'
        for x in selected: print(','.join(str(x[k]) for k in ['id','priority','status','issue_type']))
        sys.exit(0)
    issues = [{k:v for k,v in x.items() if k != 'parents'} for x in selected]
    if mode == 'large-details': issues = [{k:v for k,v in x.items() if k != 'inherited_context'} for x in issues]
    result = issues if mode == 'array-page' else {'issues':issues,'offset':offset+(1 if mode == 'wrong-offset' else 0),'limit':limit,'has_more':offset+limit < len(epics)}
    print(json.dumps(result))
elif args[0] == 'show':
    selected = [row(by_id(id)) for id in args[1:args.index('--db')]]
    if mode == 'duplicate-details' and len(selected) > 1: selected[1] = selected[0]
    if mode == 'missing-details': selected = selected[:-1]
    if mode == 'crowded-details':
        large = 'x' * (5 * 1024 * 1024)
        for x in selected:
            if x['id'] != 'epic-0059': x['inherited_context'] = large
        json.dump(selected, sys.stdout)
    else: print(json.dumps(selected))
elif args[0] == 'ready': print(json.dumps([row(x) for x in data if x['id'] != 'demo' and x['id'] in reachable and x['status'] == 'open' and not x['assignee'] and not blocked(x)]))
elif args[0] == 'update':
    x = by_id(args[1])
    if x['assignee'] or blocked(x): sys.exit('claim rejected')
    x['status'], x['assignee'] = 'in_progress', args[args.index('--actor')+1]
    (directory/'data.json').write_text(json.dumps(data))
    print(json.dumps([row(x)]))
else: sys.exit('unsupported')
`,
    );
    chmodSync(executable, 0o755);
  }
  let store = new StateStore(join(root, "state.db"));
  stores.push(store);
  const run = initialRun();
  run.repoPath = repo;
  run.runtimeConfiguration = {
    commonDirectory: { path: join(repo, ".git"), device: "1", inode: "1" },
    executable: process.execPath,
    trackerExecutable: executable,
    runtimeRoot: join(root, "runtime"),
    workspaceRoot: join(root, "workspaces"),
    accounts: fixtureAccounts(root),
    turnTimeoutMs: 15_000,
    herdr: null,
  };
  store.create(run, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  let lease = store.acquireLease(run.runId);
  const authority = (): ControllerAuthority => ({
    runId: run.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  });
  let kernel = new ActionKernel(store.orchestration);
  const transport = new KernelBeads(realpathSync(executable));
  let adapter = registerTrackerCapabilities(kernel, transport);
  const decision = (action: KernelAction): OrchestratorDecision => {
    const journal = store.orchestration;
    const ticket = journal.beginDecision(
      authority(),
      journal.latestObservationCursor(run.runId),
      journal.control(run.runId).controlVersion,
    );
    return {
      explanation: "Choose useful work from the observed epic graph",
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
  const dispatch = async (action: KernelAction) => {
    const result = await kernel.execute(decision(action), authority());
    return result.status === "running" ? (await kernel.operation(result.operationId))! : result;
  };
  return {
    root,
    repo,
    storage,
    run,
    transport,
    decision,
    dispatch,
    get store() {
      return store;
    },
    get journal() {
      return store.orchestration;
    },
    get authority() {
      return authority();
    },
    get kernel() {
      return kernel;
    },
    get adapter() {
      return adapter;
    },
    read: () => JSON.parse(readFileSync(dataPath, "utf8")) as typeof initial,
    write: (data: typeof initial) => writeFileSync(dataPath, JSON.stringify(data)),
    mode: (mode: string) => writeFileSync(join(storage, "mode"), mode),
    commands: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
    newLease() {
      store.releaseLease(run.runId, lease.ownerToken);
      lease = store.acquireLease(run.runId);
    },
    reopen() {
      store.close();
      store = new StateStore(join(root, "state.db"));
      stores.push(store);
      kernel = new ActionKernel(store.orchestration);
      adapter = registerTrackerCapabilities(kernel, transport);
    },
  };
}
const claim = (taskId = "work-a", transition: "claim" | "adopt" = "claim"): KernelAction => ({
  kind: "request_beads_transition",
  transition,
  taskId,
  revision: null,
});
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe.skipIf(process.platform !== "linux")(
  "durable tracker graph and ownership capabilities",
  () => {
    it("lists bounded metadata with real parent edges and no tracker mutation", async () => {
      const s = fixture();
      const before = readFileSync(join(s.storage, "data.json"), "utf8");
      const { epics, nextOffset } = await s.transport.listOpenEpics(
        await s.transport.bind(s.repo),
        new AbortController().signal,
      );
      expect(epics.map((epic) => epic.id)).toEqual(["container", "demo"]);
      expect(nextOffset).toBeNull();
      expect(epics[0]!.parentIds).toEqual(["demo"]);
      expect(epics[0]!.details).toBe("available");
      const commands = readFileSync(join(s.storage, "commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands.map((args) => args[0])).toEqual(["list", "show"]);
      expect(commands[0]).toEqual([
        "list",
        "--type",
        "epic",
        "--sort",
        "priority",
        "--limit",
        "51",
        "--offset",
        "0",
        "--db",
        "/workspace/.beads/beads.db",
        "--no-auto-import",
        "--no-auto-flush",
        "--format",
        "csv",
        "--fields",
        "id,priority,status,issue_type",
      ]);
      expect(readFileSync(join(s.storage, "data.json"), "utf8")).toBe(before);
    });

    it("loads bounded pages and searches beyond 1000 epics with only two commands per page", async () => {
      const s = fixture();
      const data = Array.from({ length: 1105 }, (_, index) => ({
        ...task(`epic-${String(index).padStart(4, "0")}`, []),
        issue_type: "epic",
      }));
      writeFileSync(join(s.storage, "data.json"), JSON.stringify(data));
      const binding = await s.transport.bind(s.repo),
        signal = new AbortController().signal;
      const checks = vi.spyOn(s.transport, "assertBinding");
      const first = await s.transport.listOpenEpics(binding, signal);
      expect(first.epics.map((epic) => epic.id)).toEqual(data.slice(0, 50).map((epic) => epic.id));
      expect(first.nextOffset).toBe(50);
      expect(checks).toHaveBeenCalledTimes(6);
      const next = await s.transport.listOpenEpics(binding, signal, { offset: first.nextOffset! });
      expect(next.epics.map((epic) => epic.id)).toEqual(data.slice(50, 100).map((epic) => epic.id));
      const last = await s.transport.listOpenEpics(binding, signal, { offset: 1100 });
      expect(last.epics.map((epic) => epic.id)).toEqual(data.slice(1100).map((epic) => epic.id));
      expect(last.nextOffset).toBeNull();
      const searched = await s.transport.listOpenEpics(binding, signal, { search: "epic-1104" });
      expect(searched.epics.map((epic) => epic.id)).toEqual(["epic-1104"]);
      const commands = readFileSync(join(s.storage, "commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands.map((args) => args[0])).toEqual([
        "list",
        "show",
        "list",
        "show",
        "list",
        "show",
        "search",
        "show",
      ]);
      expect(commands[6]!.slice(-2)).toEqual(["--", "epic-1104"]);
      expect(JSON.parse(readFileSync(join(s.storage, "data.json"), "utf8"))).toEqual(data);
    });

    it.each(["description", "inherited_context"])(
      "splits oversized browser reads (%s) while preserving every epic and the next page",
      async (field) => {
        const s = fixture();
        const data = Array.from({ length: 60 }, (_, index) => ({
          ...task(`epic-${String(index).padStart(4, "0")}`, []),
          issue_type: "epic",
          [field]: "x".repeat(100 * 1024),
        }));
        writeFileSync(join(s.storage, "data.json"), JSON.stringify(data));
        if (field === "inherited_context") writeFileSync(join(s.storage, "mode"), "large-details");
        const binding = await s.transport.bind(s.repo),
          signal = new AbortController().signal;
        const first = await s.transport.listOpenEpics(binding, signal);
        expect(first.epics.map((epic) => epic.id)).toEqual(
          data.slice(0, 50).map((epic) => epic.id),
        );
        expect(first.nextOffset).toBe(50);
        const last = await s.transport.listOpenEpics(binding, signal, {
          offset: first.nextOffset!,
        });
        expect(last.epics.map((epic) => epic.id)).toEqual(data.slice(50).map((epic) => epic.id));
        expect(last.nextOffset).toBeNull();
        const commands = readFileSync(join(s.storage, "commands.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        const shows = commands.filter((args) => args[0] === "show");
        expect(shows.map((args) => args.indexOf("--db") - 1)).toEqual([50, 25, 25, 10]);
        const lists = commands.filter((args) => args[0] === "list");
        expect(
          lists.map((args) => [
            args[args.indexOf("--offset") + 1],
            args[args.indexOf("--limit") + 1],
          ]),
        ).toEqual([
          ["0", "51"],
          ["50", "51"],
        ]);
        expect(JSON.parse(readFileSync(join(s.storage, "data.json"), "utf8"))).toEqual(data);
      },
    );

    it.each([
      { field: "description", position: 50, mode: "" },
      { field: "description", position: 0, mode: "" },
      { field: "inherited_context", position: 50, mode: "large-details" },
    ])(
      "isolates an oversized $field at position $position ($mode) without blocking later pages",
      async ({ field, position, mode }) => {
        const s = fixture();
        const data = Array.from({ length: 105 }, (_, index) => ({
          ...task(`epic-${String(index).padStart(4, "0")}`, []),
          issue_type: "epic",
          status: index === position ? "deferred" : "open",
          [field]: index === position ? "x".repeat(5 * 1024 * 1024) : "short",
        }));
        writeFileSync(join(s.storage, "data.json"), JSON.stringify(data));
        writeFileSync(join(s.storage, "mode"), mode);
        const binding = await s.transport.bind(s.repo),
          signal = new AbortController().signal;
        const pages = [];
        for (const offset of [0, 50, 100]) {
          const page = await s.transport.listOpenEpics(binding, signal, { offset });
          expect(page.epics.map((epic) => epic.id).sort()).toEqual(
            data.slice(offset, offset + 50).map((epic) => epic.id),
          );
          expect(
            page.epics.filter((epic) => epic.details === "too_large").map((epic) => epic.id),
          ).toEqual(offset === Math.floor(position / 50) * 50 ? [data[position]!.id] : []);
          expect(page.nextOffset).toBe(offset < 100 ? offset + 50 : null);
          pages.push(page);
        }
        expect(pages.flatMap((page) => page.epics).length).toBe(105);
        const searched = await s.transport.listOpenEpics(binding, signal, {
          search: data[position]!.id,
        });
        expect(searched.epics.map((epic) => epic.id)).toEqual([data[position]!.id]);
        expect(
          searched.epics.filter((epic) => epic.details === "too_large").map((epic) => epic.id),
        ).toEqual([data[position]!.id]);
        expect(searched.nextOffset).toBeNull();
        expect(searched.epics[0]).toEqual({
          id: data[position]!.id,
          title: null,
          priority: 1,
          status: "deferred",
          details: "too_large",
          parentIds: null,
        });
        const commands = readFileSync(join(s.storage, "commands.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        if (field === "description")
          expect(commands.some((args) => args.includes("--fields"))).toBe(true);
        // Page 1 reads only bounded lookahead metadata, never next-page details.
        if (position === 50 && mode === "")
          expect(commands.slice(0, 2).map((args) => args[0])).toEqual(["list", "show"]);
        expect(JSON.parse(readFileSync(join(s.storage, "data.json"), "utf8"))).toEqual(data);
      },
    );

    it("bounds detail recovery on crowded pages and permits an unread epic to load through search", async () => {
      const s = fixture();
      const data = Array.from({ length: 60 }, (_, index) => ({
        ...task(`epic-${String(index).padStart(4, "0")}`, []),
        issue_type: "epic",
        status: "deferred",
      }));
      writeFileSync(join(s.storage, "data.json"), JSON.stringify(data));
      s.mode("crowded-details");
      const binding = await s.transport.bind(s.repo),
        signal = new AbortController().signal;
      const commands = s.commands;
      for (const offset of [0, 50]) {
        const before = commands().length;
        const page = await s.transport.listOpenEpics(binding, signal, { offset });
        expect(page.epics.map((epic) => epic.id)).toEqual(
          data.slice(offset, offset + 50).map((epic) => epic.id),
        );
        expect(page.nextOffset).toBe(offset === 0 ? 50 : null);
        expect(page.epics.some((epic) => epic.details === "too_large")).toBe(true);
        expect(page.epics.some((epic) => epic.details === "budget_exhausted")).toBe(true);
        expect(page.epics.every((epic) => epic.priority === 1 && epic.status === "deferred")).toBe(
          true,
        );
        const reads = commands().slice(before);
        expect(reads).toHaveLength(17);
        expect(reads[0]).toContain("id,priority,status,issue_type");
        expect(reads.filter((args) => args[0] === "show")).toHaveLength(16);
        if (offset === 50)
          expect(page.epics.at(-1)).toMatchObject({
            id: "epic-0059",
            details: "budget_exhausted",
            parentIds: null,
          });
      }
      const before = commands().length;
      const selected = await s.transport.listOpenEpics(binding, signal, { search: "epic-0059" });
      expect(selected.epics).toEqual([
        {
          id: "epic-0059",
          title: "epic-0059",
          priority: 1,
          status: "deferred",
          details: "available",
          parentIds: [],
        },
      ]);
      expect(selected.nextOffset).toBeNull();
      expect(
        commands()
          .slice(before)
          .map((args) => args[0]),
      ).toEqual(["search", "show"]);
      expect(JSON.parse(readFileSync(join(s.storage, "data.json"), "utf8"))).toEqual(data);
    });

    it.each(["summary-header", "summary-priority", "summary-status"])(
      "rejects invalid bounded metadata (%s) instead of inventing defaults",
      async (mode) => {
        const s = fixture();
        writeFileSync(
          join(s.storage, "data.json"),
          JSON.stringify([
            { ...task("large", []), issue_type: "epic", description: "x".repeat(5 * 1024 * 1024) },
          ]),
        );
        s.mode(mode);
        const page = s.transport.listOpenEpics(
          await s.transport.bind(s.repo),
          new AbortController().signal,
        );
        if (mode === "summary-header")
          await expect(page).rejects.toThrow(
            "Tracker summary projection returned an invalid header",
          );
        else
          await expect(page).rejects.toMatchObject({
            issues: [
              expect.objectContaining({
                code: "invalid_value",
                path: [mode === "summary-priority" ? 1 : 2],
              }),
            ],
          });
      },
    );

    it.each([
      { mode: "duplicate-page", message: "unique epic identities" },
      { mode: "duplicate-details", message: "exactly the requested epics" },
      { mode: "missing-details", message: "exactly the requested epics" },
      { mode: "page-overflow", message: "requested 51 epic page entries" },
    ])(
      "rejects malformed browser pages ($mode) without returning partial choices",
      async ({ mode, message }) => {
        const s = fixture();
        writeFileSync(
          join(s.storage, "data.json"),
          JSON.stringify(
            Array.from({ length: 60 }, (_, i) => ({
              ...task(`epic-${i}`, []),
              issue_type: "epic",
            })),
          ),
        );
        writeFileSync(join(s.storage, "mode"), mode);
        await expect(
          s.transport.listOpenEpics(await s.transport.bind(s.repo), new AbortController().signal),
        ).rejects.toThrow(message);
      },
    );

    it("uses actual parent-child edges, includes nested work, and excludes a dotted-ID impostor", async () => {
      const s = fixture();
      success(await s.dispatch({ kind: "refresh_tracker" }));
      const snapshot = s.journal.tracker.snapshot(s.run.runId);
      expect(snapshot.graph.issues.map((x) => x.id)).toEqual([
        "demo",
        "work-a",
        "container",
        "deep-work",
      ]);
      expect(snapshot.graph.readyIds).toContain("deep-work");
      const result = success(
        await s.dispatch({
          kind: "inspect_tracker",
          snapshotId: snapshot.snapshotId,
          offset: 1,
          limit: 2,
        }),
      );
      expect(result.kind).toBe("inspection");
      if (result.kind !== "inspection") throw new Error("Expected inspection");
      expect(JSON.parse(result.text)).toMatchObject({
        nextOffset: 3,
        issues: [{ id: "work-a" }, { id: "container" }],
      });
      expect(buildOrchestratorContext(s.kernel, s.run.runId).tracker).toMatchObject({
        configured: true,
        issueCount: 4,
      });
      s.reopen();
      expect(s.journal.tracker.snapshot(s.run.runId)).toEqual(snapshot);
    });
    it.each(["claim", "adopt"] as const)(
      "executes a fresh %s and persists exact owner through restart",
      async (kind) => {
        const s = fixture();
        if (kind === "adopt") {
          const data = s.read();
          data[1]!.status = "in_progress";
          s.write(data);
        }
        success(await s.dispatch(claim("work-a", kind)));
        const record = s.journal.tracker.operations(s.run.runId)[0]!;
        expect(record).toMatchObject({
          outcome: "claimed",
          dispatched: true,
          mutationDispatched: true,
          ioStopped: true,
        });
        expect(s.read()[1]).toMatchObject({
          status: "in_progress",
          assignee: `epicd:${s.run.runId}`,
        });
        expect(() => s.journal.tracker.assertTaskOwned(s.run.runId, "work-a")).not.toThrow();
        const commands = s.commands();
        expect(commands.filter((x) => x[0] === "update")).toHaveLength(1);
        expect(
          commands.every((x) => x.includes("--no-auto-import") && x.includes("--no-auto-flush")),
        ).toBe(true);
        s.reopen();
        expect(s.journal.tracker.record(s.run.runId, record.trackerOperationId)).toEqual(record);
        expect(readFileSync(join(s.repo, "user-file"), "utf8")).toBe("user-owned\n");
      },
    );
    it.each(["demo.impostor", "demo", "container"])(
      "refuses out-of-scope/container target %s",
      async (id) => {
        const s = fixture();
        expect((await s.dispatch(claim(id))).status).toBe("failed");
        expect(s.commands().some((x) => x[0] === "update")).toBe(false);
      },
    );
    it("does not overwrite another owner or claim blocked work", async () => {
      const s = fixture();
      const data = s.read();
      data[1]!.assignee = "human";
      s.write(data);
      expect((await s.dispatch(claim())).status).toBe("failed");
      data[1]!.assignee = null;
      data[1]!.blockers = ["deep-work"];
      s.write(data);
      expect((await s.dispatch(claim())).status).toBe("failed");
      expect(s.commands().some((x) => x[0] === "update")).toBe(false);
    });
    it("preserves an ownership race reported by the atomic claim", async () => {
      const s = fixture();
      const original = s.transport.claim.bind(s.transport);
      vi.spyOn(s.transport, "claim").mockImplementation(async (...args) => {
        const data = s.read();
        data[1]!.assignee = "human";
        s.write(data);
        return original(...args);
      });
      expect((await s.dispatch(claim())).status).toBe("failed");
      expect(s.read()[1]?.assignee).toBe("human");
      expect(s.journal.tracker.operations(s.run.runId)[0]).toMatchObject({
        outcome: "conflict",
        ioStopped: true,
      });
    });
    it("recognizes a lost successful mutation result without repeating the claim", async () => {
      const s = fixture();
      const original = s.transport.claim.bind(s.transport);
      vi.spyOn(s.transport, "claim").mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("Lost response after stopped command");
      });
      const decision = s.decision(claim());
      const running = await s.kernel.execute(decision, s.authority);
      if (running.status !== "running") throw new Error("Not running");
      const result = await s.kernel.operation(running.operationId);
      expect(result?.status).toBe("succeeded");
      expect(await s.kernel.execute(decision, s.authority)).toEqual(result);
      expect(s.commands().filter((x) => x[0] === "update")).toHaveLength(1);
      expect(s.journal.tracker.operations(s.run.runId)[0]).toMatchObject({
        outcome: "claimed",
        failure: "Lost response after stopped command",
      });
    });
    it("preserves a claim but rejects work reparented outside the epic during mutation", async () => {
      const s = fixture();
      const original = s.transport.claim.bind(s.transport);
      vi.spyOn(s.transport, "claim").mockImplementationOnce(async (...args) => {
        await original(...args);
        const data = s.read();
        data[1]!.parents = [];
        s.write(data);
      });
      expect((await s.dispatch(claim())).status).toBe("failed");
      expect(s.journal.tracker.operations(s.run.runId)[0]?.outcome).toBe("conflict");
      expect(s.read()[1]?.assignee).toBe(`epicd:${s.run.runId}`);
      expect(() => s.journal.tracker.assertTaskOwned(s.run.runId, "work-a")).toThrow();
      expect(s.commands().filter((x) => x[0] === "update")).toHaveLength(1);
    });
    it.each(["refresh_tracker", "request_beads_transition"] as const)(
      "settles a never-dispatched %s intent without inventing I/O or a storage binding",
      async (kind) => {
        const s = fixture();
        vi.spyOn(s.adapter, "execute").mockRejectedValueOnce(
          new Error("Controller stopped before dispatch"),
        );
        expect((await s.dispatch(kind === "refresh_tracker" ? { kind } : claim())).status).toBe(
          "indeterminate",
        );
        const record = s.journal.tracker.pending(s.run.runId)!;
        expect(record.dispatched).toBe(false);
        s.newLease();
        s.reopen();
        success(
          await s.dispatch({
            kind: "reconcile_tracker_operation",
            trackerOperationId: record.trackerOperationId,
          }),
        );
        expect(s.journal.tracker.pending(s.run.runId)).toBeNull();
        expect(s.journal.action(s.run.runId, record.actionId)?.status).toBe("failed");
        expect(s.commands()).toEqual([]);
      },
    );
    it("excludes new mutations while tracker outcome is pending but permits inspection", async () => {
      const s = fixture();
      vi.spyOn(s.journal.tracker, "finish").mockImplementationOnce(() => {
        throw new Error("Lost settlement");
      });
      expect((await s.dispatch(claim())).status).toBe("indeterminate");
      expect(await s.dispatch({ kind: "refresh_tracker" })).toMatchObject({
        status: "rejected",
        code: "tracker_unsettled",
      });
      success(await s.dispatch({ kind: "inspect_run" }));
      expect(
        await s.dispatch({
          kind: "interrupt_action",
          actionId: "not-a-run-action",
          reason: "Check interruption admission while tracker work is pending",
        }),
      ).toMatchObject({ status: "rejected", code: "unknown_action" });
      expect(() => s.journal.tracker.assertTaskOwned(s.run.runId, "work-a")).toThrow("unsettled");
      expect(s.commands().filter((x) => x[0] === "update")).toHaveLength(1);
    });
    it("pages long descriptions at the exact stored snapshot and labels observed readiness", async () => {
      const s = fixture();
      const data = s.read();
      data[1]!.description = "Detailed work. ".repeat(2000);
      data[1]!.acceptance_criteria = "Required behavior. ".repeat(1500);
      s.write(data);
      success(await s.dispatch({ kind: "refresh_tracker" }));
      const snapshot = s.journal.tracker.snapshot(s.run.runId);
      const result = success(
        await s.dispatch({
          kind: "inspect_tracker",
          snapshotId: snapshot.snapshotId,
          offset: 1,
          limit: 1,
        }),
      );
      if (result.kind !== "inspection") throw new Error("Not inspection");
      const content = JSON.parse(result.text);
      expect(content.issues[0]).toMatchObject({
        observedReady: true,
        truncatedFields: ["description", "acceptanceCriteria"],
      });
      let full = "",
        offset: number | null = 0;
      while (offset !== null) {
        const page = success(
          await s.dispatch({
            kind: "read_tracker_issue",
            snapshotId: snapshot.snapshotId,
            taskId: "work-a",
            field: "description",
            offset,
            limit: 16000,
          }),
        );
        if (page.kind !== "inspection") throw new Error("Not inspection");
        const chunk = JSON.parse(page.text);
        expect(chunk.digest).toBe(snapshot.digest);
        expect(Buffer.byteLength(page.text)).toBeLessThan(64000);
        full += chunk.text;
        offset = chunk.nextOffset;
      }
      expect(full).toBe(data[1]!.description);
    });
    it("stops an oversized output and never accepts a partial graph", async () => {
      const s = fixture();
      s.mode("oversized");
      expect((await s.dispatch({ kind: "refresh_tracker" })).status).toBe("failed");
      expect(s.journal.tracker.operations(s.run.runId)[0]).toMatchObject({
        outcome: "failed",
        ioStopped: true,
        afterSnapshotId: null,
      });
      expect(s.journal.tracker.operations(s.run.runId)[0]?.failure).toContain("exceeds 4 MiB");
    });
    it("retains an exact work fingerprint across redaction and refuses changed claim content", async () => {
      const s = fixture();
      const data = s.read();
      data[1]!.description = "Connect with password=before-secret";
      s.write(data);
      const original = s.transport.claim.bind(s.transport);
      vi.spyOn(s.transport, "claim").mockImplementationOnce(async (...args) => {
        await original(...args);
        const changed = s.read();
        changed[1]!.description = "Connect with password=after-secret";
        s.write(changed);
      });
      expect((await s.dispatch(claim())).status).toBe("failed");
      const record = s.journal.tracker.operations(s.run.runId)[0]!;
      const before = s.journal.tracker.snapshot(s.run.runId, record.beforeSnapshotId!);
      const after = s.journal.tracker.snapshot(s.run.runId, record.afterSnapshotId!);
      expect(before.graph.issues[1]?.description).toBe(after.graph.issues[1]?.description);
      expect(before.graph.issues[1]?.workDigest).not.toBe(after.graph.issues[1]?.workDigest);
      expect(JSON.stringify([before, after])).not.toContain("before-secret");
      expect(JSON.stringify([before, after])).not.toContain("after-secret");
      expect(record.outcome).toBe("conflict");
    });
    it("gates agent assignment and follow-up on recorded task ownership", async () => {
      const s = fixture();
      success(await s.dispatch({ kind: "refresh_tracker" }));
      const agents = s.journal.agents;
      const version = () => s.journal.control(s.run.runId).controlVersion;
      const ws = agents.reserveWorkspace(
        s.authority,
        {
          root: join(s.root, "workspaces"),
          purpose: "implementation",
          sourceMode: "mutable",
          baselineRevision: "fixture-base",
        },
        version(),
      );
      mkdirSync(ws.path, { recursive: true });
      agents.markWorkspaceReady(s.authority, ws, "fixture-only");
      const settings = { model: "worker-model", reasoningEffort: "high" };
      const input = {
        ...ws,
        purpose: "implementation" as const,
        role: "implementation" as const,
        taskId: "work-a",
        candidateId: null,
        instructions: "Implement the assigned task",
        contract: SdkAgentSessionContractSchema.parse({
          backend: "codex",
          runtime: "sdk",
          requested: settings,
          effective: settings,
        }),
        confinementProfile: "fixture-only",
      };
      expect(() => agents.reserveAgent(s.authority, input, version())).toThrow("recorded claim");
      success(await s.dispatch(claim()));
      const agent = agents.reserveAgent(s.authority, input, version());
      const data = s.read();
      data[1]!.assignee = "human";
      s.write(data);
      success(await s.dispatch({ kind: "refresh_tracker" }));
      expect(() =>
        agents.prepareTurn(s.authority, agent, randomUUID(), "Continue", {}, version()),
      ).toThrow("recorded claim");
      expect(agents.turns(s.run.runId)).toEqual([]);
    });
    it("does not reuse a recorded claim after observed epic closure or work-definition change", async () => {
      const s = fixture();
      success(await s.dispatch(claim()));
      const data = s.read();
      data[0]!.status = "closed";
      s.write(data);
      success(await s.dispatch({ kind: "refresh_tracker" }));
      expect(() => s.journal.tracker.assertTaskOwned(s.run.runId, "work-a")).toThrow(
        "recorded claim",
      );
      data[0]!.status = "open";
      data[1]!.description = "Different required behavior";
      s.write(data);
      success(await s.dispatch({ kind: "refresh_tracker" }));
      expect(() => s.journal.tracker.assertTaskOwned(s.run.runId, "work-a")).toThrow(
        "recorded claim",
      );
      expect(s.read()[1]?.assignee).toBe(`epicd:${s.run.runId}`);
      expect(s.commands().filter((x) => x[0] === "update")).toHaveLength(1);
    });
    it("reconciles a known-stopped result on a replacement controller without replaying the effect", async () => {
      const s = fixture();
      vi.spyOn(s.journal.tracker, "finish").mockImplementationOnce(() => {
        throw new Error("Lost outcome persistence");
      });
      expect((await s.dispatch(claim())).status).toBe("indeterminate");
      const record = s.journal.tracker.pending(s.run.runId)!;
      expect(record.ioStopped).toBe(true);
      s.newLease();
      s.reopen();
      success(
        await s.dispatch({
          kind: "reconcile_tracker_operation",
          trackerOperationId: record.trackerOperationId,
        }),
      );
      expect(s.journal.tracker.record(s.run.runId, record.trackerOperationId).outcome).toBe(
        "claimed",
      );
      expect(s.commands().filter((x) => x[0] === "update")).toHaveLength(1);
      expect(s.journal.action(s.run.runId, record.actionId)?.status).toBe("succeeded");
    });
    it("rejects duplicate dispatch and never infers unknown old I/O stop from tracker state", async () => {
      const s = fixture();
      let release!: () => void,
        entered = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = s.transport.claim.bind(s.transport);
      vi.spyOn(s.transport, "claim").mockImplementation(async (...args) => {
        entered = true;
        await gate;
        return original(...args);
      });
      const result = s.dispatch(claim()).catch((error) => error as unknown);
      try {
        await waitFor(() => entered);
        const pending = s.journal.tracker.pending(s.run.runId)!;
        await expect(
          s.adapter.execute(s.authority, pending.trackerOperationId, new AbortController().signal),
        ).rejects.toThrow("write-once");
        expect(s.journal.tracker.pending(s.run.runId)?.ioStopped).toBe(false);
        s.newLease();
        await expect(s.adapter.reconcile(s.authority, pending.trackerOperationId)).rejects.toThrow(
          "Independently prove",
        );
      } finally {
        release();
      }
      expect(await result).toBeInstanceOf(Error);
      expect(s.commands().some((x) => x[0] === "update")).toBe(false);
    });
    it.each(["inspection", "claim", "reconciliation"] as const)(
      "retains an unknown namespace stop during %s without a second graph read or a fabricated I/O receipt",
      async (stage) => {
        const s = fixture();
        let pendingId: string | undefined;
        if (stage === "reconciliation") {
          vi.spyOn(s.journal.tracker, "finish").mockImplementationOnce(() => {
            throw new Error("Lost outcome persistence");
          });
          expect((await s.dispatch(claim())).status).toBe("indeterminate");
          const previous = s.journal.tracker.pending(s.run.runId)!;
          expect(previous.ioStopped).toBe(true);
          pendingId = previous.trackerOperationId;
        }
        const graph = vi.spyOn(s.transport, "graph");
        if (stage === "claim")
          vi.spyOn(s.transport, "claim").mockRejectedValueOnce(
            new NamespaceStopUnprovenError("Unknown fixture monitor stop"),
          );
        else
          graph.mockRejectedValueOnce(
            new NamespaceStopUnprovenError("Unknown fixture monitor stop"),
          );
        const result = await s.dispatch(
          stage === "reconciliation"
            ? { kind: "reconcile_tracker_operation", trackerOperationId: pendingId! }
            : stage === "claim"
              ? claim()
              : { kind: "refresh_tracker" },
        );
        expect(result.status).toBe("indeterminate");
        expect(graph).toHaveBeenCalledOnce();
        const pending = s.journal.tracker.pending(s.run.runId)!;
        expect(pending).toMatchObject({ ioStopped: false, outcome: null });
        s.newLease();
        s.reopen();
        expect(s.journal.tracker.pending(s.run.runId)?.ioStopped).toBe(false);
        await expect(s.adapter.reconcile(s.authority, pending.trackerOperationId)).rejects.toThrow(
          "Independently prove",
        );
      },
    );
    it("rejects malformed, cyclic, and internally inconsistent graph evidence", async () => {
      const s = fixture();
      s.mode("invalid");
      expect((await s.dispatch({ kind: "refresh_tracker" })).status).toBe("failed");
      s.mode("");
      success(await s.dispatch({ kind: "refresh_tracker" }));
      const graph = structuredClone(s.journal.tracker.snapshot(s.run.runId).graph);
      graph.issues[0]!.dependencies.push({ id: "work-a", type: "parent-child", status: "open" });
      graph.issues[1]!.dependents.push({ id: "demo", type: "parent-child", status: "open" });
      expect(TrackerGraphSchema.safeParse(graph).success).toBe(false);
      graph.issues[1]!.dependents = [];
      graph.readyIds.push("demo.impostor");
      expect(TrackerGraphSchema.safeParse(graph).success).toBe(false);
    });
    it("rejects storage/configuration changes and filesystem aliases", async () => {
      const s = fixture();
      success(await s.dispatch({ kind: "refresh_tracker" }));
      writeFileSync(join(s.storage, "config.yaml"), "actor: human\n");
      expect((await s.dispatch(claim())).status).toBe("failed");
      expect(s.commands().some((x) => x[0] === "update")).toBe(false);
      symlinkSync(join(s.repo, "user-file"), join(s.storage, "alias"));
      await expect(s.transport.bind(s.repo)).rejects.toThrow("symlink");
    });
    it("does not expose the host checkout or inherited environment to the tracker process", async () => {
      const s = fixture();
      s.mode("confinement");
      vi.stubEnv("EPICD_TRAP", "host-only-secret");
      try {
        expect((await s.dispatch({ kind: "refresh_tracker" })).status).toBe("failed");
        expect(JSON.parse(readFileSync(join(s.storage, "confinement-result"), "utf8"))).toEqual({
          escaped: false,
          foreignEnv: null,
        });
        expect(readFileSync(join(s.repo, "user-file"), "utf8")).toBe("user-owned\n");
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it("awaits process-tree stop after cancellation, including detached descendants", async () => {
      const s = fixture();
      s.mode("hang");
      const running = await s.kernel.execute(s.decision({ kind: "refresh_tracker" }), s.authority);
      if (running.status !== "running") throw new Error("Not running");
      await waitFor(() => s.commands().length > 0);
      s.kernel.interruptAll();
      await s.kernel.operation(running.operationId);
      await new Promise((resolve) => setTimeout(resolve, 1400));
      expect(existsSync(join(s.storage, "late"))).toBe(false);
      expect(s.journal.tracker.operations(s.run.runId)[0]?.ioStopped).toBe(true);
    });
    it("cannot use claim capability to close a task or supply a revision", async () => {
      const s = fixture();
      expect(
        (
          await s.dispatch({
            kind: "request_beads_transition",
            taskId: "work-a",
            transition: "close_task",
            revision: "verified",
          })
        ).status,
      ).toBe("rejected");
      expect(s.commands()).toEqual([]);
    });
    it("preserves raw current tracker records during quarantine", async () => {
      const s = fixture();
      const db = new Database(join(s.root, "state.db"));
      try {
        success(await s.dispatch(claim()));
        const rows = db.prepare("SELECT * FROM tracker_operations").all();
        db.prepare("UPDATE runs SET state_json = 'invalid' WHERE run_id = ?").run(s.run.runId);
        s.store.releaseLease(s.run.runId, s.authority.ownerToken);
        s.store.quarantineInvalidRun(s.run.runId);
        const preserved = db
          .prepare(
            "SELECT row_json FROM quarantined_orchestration WHERE source_table = 'tracker_operations'",
          )
          .all() as { row_json: string }[];
        expect(preserved.map((row) => JSON.parse(row.row_json))).toEqual(rows);
        expect(db.pragma("foreign_key_check")).toEqual([]);
      } finally {
        db.close();
      }
    });
  },
);

describe.skipIf(!process.env.EPICD_TEST_BR_PATH || process.platform !== "linux")(
  "installed Beads CLI with disposable storage",
  () => {
    it("preserves oversized epic metadata with the installed CLI's bounded projection", async () => {
      const root = mkdtempSync("/var/tmp/epicd-real-browser-");
      roots.push(root);
      const fixtureHome = join(root, "private-home");
      mkdirSync(fixtureHome);
      const executable = realpathSync(process.env.EPICD_TEST_BR_PATH!);
      const br = (args: string[]) =>
        execFileSync(executable, [...args, "--json"], {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: fixtureHome, RUST_LOG: "error" },
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 16 * 1024 * 1024,
        });
      br(["init", "--prefix", "demo"]);
      const body = join(root, "body.txt");
      writeFileSync(body, "x".repeat(5 * 1024 * 1024));
      const large = JSON.parse(
        br([
          "create",
          "Large epic",
          "--type",
          "epic",
          "--priority",
          "0",
          "--description-file",
          body,
        ]),
      ) as { id: string };
      const normal = JSON.parse(
        br(["create", "Normal epic", "--type", "epic", "--priority", "1"]),
      ) as { id: string };
      br(["update", large.id, "--status", "deferred"]);
      const transport = new KernelBeads(executable),
        binding = await transport.bind(root),
        signal = new AbortController().signal;
      const page = await transport.listOpenEpics(binding, signal);
      expect(page.epics.map((epic) => epic.id)).toEqual([large.id, normal.id]);
      expect(page.epics[0]).toEqual({
        id: large.id,
        title: null,
        priority: 0,
        status: "deferred",
        details: "too_large",
        parentIds: null,
      });
      expect(
        page.epics.filter((epic) => epic.details === "too_large").map((epic) => epic.id),
      ).toEqual([large.id]);
      expect(page.nextOffset).toBeNull();
      const searched = await transport.listOpenEpics(binding, signal, { search: large.id });
      expect(searched.epics.map((epic) => epic.id)).toEqual([large.id]);
      expect(searched.epics[0]).toEqual(page.epics[0]);
      expect(
        searched.epics.filter((epic) => epic.details === "too_large").map((epic) => epic.id),
      ).toEqual([large.id]);
      expect(searched.nextOffset).toBeNull();
    });

    it("pages the installed CLI's list and search without hydrating off-page records", async () => {
      const root = mkdtempSync("/var/tmp/epicd-real-pages-");
      roots.push(root);
      const fixtureHome = join(root, "private-home");
      mkdirSync(fixtureHome);
      const executable = realpathSync(process.env.EPICD_TEST_BR_PATH!);
      const br = (args: string[]) =>
        execFileSync(executable, [...args, "--json"], {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: fixtureHome, RUST_LOG: "error" },
          encoding: "utf8",
          timeout: 30000,
        });
      br(["init", "--prefix", "demo"]);
      const ids = Array.from(
        { length: 55 },
        (_, index) =>
          (
            JSON.parse(
              br(["create", `Paging epic ${index}`, "--type", "epic", "--priority", "1"]),
            ) as { id: string }
          ).id,
      );
      // Equal priorities sort by creation time descending, then identity. Compare
      // page membership separately from the browser's within-page display sort.
      const expected = ids.toReversed();
      const transport = new KernelBeads(executable),
        binding = await transport.bind(root),
        signal = new AbortController().signal;
      for (const search of ["", "Paging epic"]) {
        const first = await transport.listOpenEpics(binding, signal, { search });
        expect(first.nextOffset).toBe(50);
        expect(first.epics.map((epic) => epic.id).sort()).toEqual(expected.slice(0, 50).sort());
        const last = await transport.listOpenEpics(binding, signal, { offset: 50, search });
        expect(last.nextOffset).toBeNull();
        expect(last.epics.map((epic) => epic.id).sort()).toEqual(expected.slice(50).sort());
        expect(new Set([...first.epics, ...last.epics].map((epic) => epic.id)).size).toBe(55);
      }

      // A last-priority record with an invalid timestamp is a deterministic read
      // canary: SQLite can sort past it, but the CLI cannot hydrate it as an Issue.
      // Only this disposable fixture is corrupted, after checking both full pages.
      const canary = JSON.parse(
        br(["create", "Paging epic canary", "--type", "epic", "--priority", "4"]),
      ) as { id: string };
      const db = new Database(join(root, ".beads", "beads.db"));
      try {
        expect(
          db
            .prepare("UPDATE issues SET created_at = ? WHERE id = ?")
            .run("unread-off-page-canary", canary.id).changes,
        ).toBe(1);
      } finally {
        db.close();
      }
      for (const search of ["", "Paging epic"]) {
        // Negative control: this option moves LIMIT/OFFSET after hydration in br.
        // Require the specific decoder failure so a broken fixture cannot pass.
        expect(() =>
          execFileSync(
            executable,
            [
              search ? "search" : "list",
              "--type",
              "epic",
              "--deferred",
              "--sort",
              "priority",
              "--limit",
              "51",
              "--offset",
              "0",
              "--format",
              "csv",
              "--fields",
              "id,priority,status,issue_type",
              "--no-auto-import",
              "--no-auto-flush",
              ...(search ? ["--", search] : []),
            ],
            {
              cwd: root,
              env: { PATH: process.env.PATH, HOME: fixtureHome, RUST_LOG: "error" },
              encoding: "utf8",
              stdio: "pipe",
              timeout: 30000,
            },
          ),
        ).toThrow("unparseable datetime: unread-off-page-canary");
        const first = await transport.listOpenEpics(binding, signal, { search });
        expect(first.nextOffset).toBe(50);
        expect(first.epics.map((epic) => epic.id).sort()).toEqual(expected.slice(0, 50).sort());
      }
    });

    it("journals a real non-dotted child claim through the confined transport", async () => {
      const root = mkdtempSync("/var/tmp/epicd-real-beads-");
      roots.push(root);
      const fixtureHome = join(root, "private-home");
      mkdirSync(fixtureHome);
      const executable = realpathSync(process.env.EPICD_TEST_BR_PATH!);
      const br = (args: string[]) => {
        const output = execFileSync(executable, [...args, "--json"], {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: fixtureHome, RUST_LOG: "error" },
          encoding: "utf8",
          timeout: 30000,
        });
        return args[0] === "init" ? null : JSON.parse(output);
      };
      br(["init", "--prefix", "demo"]);
      const epic = br([
        "create",
        "Delivery",
        "--type",
        "epic",
        "--description",
        "Deliver behavior",
      ]);
      const child = br([
        "create",
        "Concrete work",
        "--description",
        "Implement behavior",
        "--acceptance-criteria",
        "Behavior works",
      ]);
      br(["dep", "add", child.id, epic.id, "--type", "parent-child"]);
      const transport = new KernelBeads(executable),
        binding = await transport.bind(root),
        signal = new AbortController().signal;
      const graph = await transport.graph(binding, epic.id, () => {}, signal);
      expect(graph.issues.map((x) => x.id)).toContain(child.id);
      expect(child.id.startsWith(epic.id + ".")).toBe(false);
      expect(graph.readyIds).toContain(child.id);
      const store = new StateStore(join(root, "epicd-state.db"));
      stores.push(store);
      const run = initialRun("real-fixture");
      run.repoPath = root;
      run.epicId = epic.id;
      store.create(run, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
      const lease = store.acquireLease(run.runId);
      const authority = { runId: run.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
      const kernel = new ActionKernel(store.orchestration);
      registerTrackerCapabilities(kernel, transport);
      const ticket = store.orchestration.beginDecision(
        authority,
        store.orchestration.latestObservationCursor(run.runId),
        store.orchestration.control(run.runId).controlVersion,
      );
      const running = await kernel.execute(
        {
          explanation: "Claim ready concrete work from the real tracker",
          evidenceIds: [],
          request: {
            schemaVersion: 1,
            decisionId: ticket.decisionId,
            observationCursor: ticket.observationCursor,
            expectedControlVersion: ticket.expectedControlVersion,
            action: claim(child.id),
          },
        },
        authority,
      );
      if (running.status !== "running") throw new Error(JSON.stringify(running));
      success((await kernel.operation(running.operationId))!);
      expect(store.orchestration.tracker.operations(run.runId)[0]).toMatchObject({
        outcome: "claimed",
        ioStopped: true,
      });
      expect(() => store.orchestration.tracker.assertTaskOwned(run.runId, child.id)).not.toThrow();
      const after = await transport.graph(binding, epic.id, () => {}, signal);
      expect(after.issues.find((x) => x.id === child.id)).toMatchObject({
        status: "in_progress",
        assignee: "epicd:real-fixture",
      });
      await expect(
        transport.claim(binding, child.id, "other-fixture", () => {}, signal),
      ).rejects.toThrow();
    }, 30000);
  },
);
