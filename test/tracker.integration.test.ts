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
elif args[0] == 'show': print(json.dumps([row(by_id(id)) for id in args[1:args.index('--db')]]))
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
  store.createAdaptive(run, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
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
      store.createAdaptive(run, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
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
