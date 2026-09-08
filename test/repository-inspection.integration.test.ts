import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { InspectionFiles } from "../src/adapters/inspection-files.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { SdkAgentSessionContractSchema } from "../src/domain/types.js";
import type {
  ControllerAuthority,
  KernelAction,
  OrchestratorDecision,
} from "../src/domain/orchestration.js";
import { ActionKernel } from "../src/kernel/actions.js";
import {
  registerInspectionCapabilities,
  reconcileRepositoryInspection,
} from "../src/kernel/inspection.js";
import { reconcileActions } from "../src/kernel/reconcile.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const io = vi.hoisted(() => ({
  beforeOpen: null as ((path: string) => void) | null,
  beforeLstat: null as ((path: string) => void) | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      io.beforeOpen?.(String(args[0]));
      return actual.open(...args);
    },
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      io.beforeLstat?.(String(args[0]));
      return actual.lstat(...args);
    },
  };
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  io.beforeOpen = null;
  io.beforeLstat = null;
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", path, ...args], {
    encoding: "utf8",
  }).trim();
}
async function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync("/var/tmp/epicd-inspection-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "--quiet", `--object-format=${format}`);
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  mkdirSync(join(source, "docs"));
  writeFileSync(
    join(source, "docs/E2E.md"),
    "Start browser tests\nUse the declared database\nRun npm test:e2e\n",
  );
  writeFileSync(join(source, "app.txt"), "before\nsecond\n");
  writeFileSync(join(source, "run.sh"), "exit 0\n");
  writeFileSync(join(source, "deleted.txt"), "remove me\n");
  symlinkSync("app.txt", join(source, "link"));
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "initial baseline");
  const previous = git(source, "rev-parse", "HEAD");
  writeFileSync(
    join(source, "docs/E2E.md"),
    "Start browser tests\nUse peer authentication\nRun npm test:e2e\n",
  );
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "describe authentication");
  const revision = git(source, "rev-parse", "HEAD");
  const store = new StateStore(join(root, "state.sqlite3"));
  cleanup.push(() => store.close());
  const initial = initialRun();
  initial.repoPath = source;
  const state = store.create(initial, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  const lease = store.acquireLease(state.runId);
  const authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const journal = store.orchestration;
  const manager = new WorkspaceManager(journal, join(root, "managed"));
  const workspace = await manager.create(authority, source, revision, "implementation");
  const kernel = new ActionKernel(journal);
  registerInspectionCapabilities(kernel, manager);
  const action = (
    changes: Partial<Extract<KernelAction, { kind: "inspect_repo" }>> = {},
  ): Extract<KernelAction, { kind: "inspect_repo" }> => ({
    kind: "inspect_repo",
    workspaceId: workspace.workspaceId,
    workspaceGeneration: workspace.workspaceGeneration,
    operation: "read",
    path: "docs/E2E.md",
    query: null,
    offset: 0,
    limit: 100,
    ...changes,
  });
  const decision = (request: KernelAction): OrchestratorDecision => {
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(authority.runId),
      journal.control(authority.runId).controlVersion,
    );
    return {
      explanation: "Inspect evidence to diagnose browser authentication",
      evidenceIds: [],
      request: {
        schemaVersion: 1,
        decisionId: ticket.decisionId,
        observationCursor: ticket.observationCursor,
        expectedControlVersion: ticket.expectedControlVersion,
        action: request,
      },
    };
  };
  const dispatch = async (request: KernelAction) => {
    const d = decision(request);
    const initial = await kernel.execute(d, authority);
    const result =
      initial.status === "running" ? await kernel.operation(initial.operationId)! : initial;
    return { decision: d, result };
  };
  const inspect = async (changes: Parameters<typeof action>[0] = {}) => {
    const { result } = await dispatch(action(changes));
    expect(result).toMatchObject({ status: "succeeded", result: { kind: "inspection" } });
    if (result.status !== "succeeded" || result.result.kind !== "inspection")
      throw new Error(JSON.stringify(result));
    return JSON.parse(result.result.text);
  };
  return {
    root,
    source,
    previous,
    revision,
    store,
    journal,
    authority,
    manager,
    workspace,
    kernel,
    action,
    decision,
    dispatch,
    inspect,
  };
}

describe.skipIf(process.platform !== "linux")("kernel repository inspection", () => {
  function reserveReader(s: Awaited<ReturnType<typeof fixture>>) {
    const settings = { model: "worker", reasoningEffort: "high" as const };
    return s.journal.agents.reserveAgent(
      s.authority,
      {
        ...s.workspace,
        role: "implementation",
        purpose: "implementation",
        taskId: "demo.1",
        candidateId: null,
        instructions: "Inspect the repository",
        confinementProfile: "test",
        contract: SdkAgentSessionContractSchema.parse({
          runtime: "sdk",
          requested: settings,
          effective: settings,
        }),
      },
      s.journal.control(s.authority.runId).controlVersion,
    );
  }

  it("reads and diffs a stopped quarantined copy without reopening it for work", async () => {
    const s = await fixture(),
      agent = reserveReader(s);
    writeFileSync(join(s.workspace.path, "app.txt"), "unknown-writer delta\n");
    s.journal.agents.revokeAgent(s.authority, agent, "Unexpected source mutation");
    expect((await s.inspect({ path: "app.txt" })).rows).toEqual([
      { text: "unknown-writer delta\n" },
    ]);
    const diff = await s.inspect({ operation: "diff", path: "." });
    expect(diff.workspaceStatus).toBe("quarantined");
    expect(diff.rows.map((row: { path: string }) => row.path)).toEqual(["app.txt"]);
    expect(diff.evidenceWarning).toContain("does not establish its writer");
    expect((await s.inspect({ operation: "history", path: ".", limit: 1 })).rows[0].text).toContain(
      s.revision,
    );
    expect(s.journal.agents.workspace(s.authority.runId, s.workspace).status).toBe("quarantined");
    expect(() => reserveReader(s)).toThrow("Agent needs a ready, unoccupied workspace");
    await expect(s.manager.read(s.authority, s.workspace, "app.txt", 0, 100)).rejects.toThrow(
      "Workspace is not ready",
    );
    expect(readFileSync(join(s.workspace.path, "app.txt"), "utf8")).toBe("unknown-writer delta\n");
  });

  it.each(["turn", "io"] as const)(
    "refuses quarantined inspection while old %s stop remains unconfirmed",
    async (kind) => {
      const s = await fixture(),
        agent = reserveReader(s);
      if (kind === "turn")
        s.journal.agents.prepareTurn(
          s.authority,
          agent,
          randomUUID(),
          "Unsettled turn",
          {},
          s.journal.control(s.authority.runId).controlVersion,
        );
      else
        s.journal.agents.beginWorkspaceOperation(
          s.authority,
          s.workspace,
          "capture",
          s.journal.control(s.authority.runId).controlVersion,
        );
      s.journal.agents.revokeAgent(s.authority, agent, "Unsettled old work");
      const open = vi.spyOn(InspectionFiles, "open");
      expect((await s.dispatch(s.action())).result.status).toBe("rejected");
      expect(open).not.toHaveBeenCalled();
      expect(s.journal.agents.workspace(s.authority.runId, s.workspace).status).toBe("quarantined");
    },
  );

  it("reads E2E instructions during a writer turn without manufacturing evidence or changing user Git", async () => {
    const s = await fixture();
    const index = readFileSync(join(s.source, ".git/index"));
    const settings = { model: "worker", reasoningEffort: "high" as const };
    const agent = s.journal.agents.reserveAgent(
      s.authority,
      {
        ...s.workspace,
        role: "implementation",
        purpose: "implementation",
        taskId: "demo.1",
        candidateId: null,
        instructions: "Implement",
        confinementProfile: "test",
        contract: SdkAgentSessionContractSchema.parse({
          runtime: "sdk",
          requested: settings,
          effective: settings,
        }),
      },
      s.journal.control(s.authority.runId).controlVersion,
    );
    const turn = s.journal.agents.prepareTurn(
      s.authority,
      agent,
      randomUUID(),
      "Diagnose the browser failure",
      {},
      s.journal.control(s.authority.runId).controlVersion,
    );
    const page = await s.inspect({ offset: 20, limit: 23 });
    expect(page).toMatchObject({
      rows: [{ text: "Use peer authentication" }],
      nextOffset: 43,
      total: 61,
      offsetUnit: "redacted_utf16_characters",
    });
    expect(page.evidenceWarning).toContain("not validation or approval");
    expect(s.journal.agents.workspace(s.authority.runId, s.workspace).activeTurnId).toBe(
      turn.identity.turnId,
    );
    expect(s.journal.delivery.summaries(s.authority.runId)).toMatchObject({
      candidates: [],
      validation: [],
    });
    expect(readFileSync(join(s.source, ".git/index"))).toEqual(index);
    expect(git(s.source, "status", "--porcelain")).toBe("");
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.revision);
  });

  it("returns exact saved observations on replay and cold reopening, not new file contents", async () => {
    const s = await fixture();
    const { decision, result } = await s.dispatch(s.action());
    writeFileSync(join(s.workspace.path, "docs/E2E.md"), "changed after inspection\n");
    expect(await s.kernel.execute(decision, s.authority)).toEqual(result);
    const reopened = new StateStore(join(s.root, "state.sqlite3"));
    try {
      expect(reopened.orchestration.action(s.authority.runId, result.actionId)?.result).toEqual(
        result,
      );
    } finally {
      reopened.close();
    }
    expect((await s.inspect()).rows).toEqual([{ text: "changed after inspection\n" }]);
  });

  it("lists literal paths and searches redacted text with explicit pagination and omissions", async () => {
    const s = await fixture();
    writeFileSync(join(s.workspace.path, "binary.dat"), Buffer.from([0, 255, 1]));
    writeFileSync(join(s.workspace.path, ".env"), "password=hidden-credential\n");
    writeFileSync(
      join(s.workspace.path, "docs/config.json"),
      '{"password":"hidden-json", "safe": "authentication"}\n',
    );
    const first = await s.inspect({
      operation: "search",
      path: "docs",
      query: "authentication",
      limit: 1,
    });
    expect(first.rows).toHaveLength(1);
    expect(first.nextOffset).toBe(1);
    const second = await s.inspect({
      operation: "search",
      path: "docs",
      query: "authentication",
      offset: first.nextOffset,
      limit: 1,
    });
    expect(second.rows[0].text).toContain("[REDACTED]");
    expect(JSON.stringify(second)).not.toContain("hidden-json");
    expect(second.nextOffset).toBeNull();
    const all = await s.inspect({ operation: "search", path: ".", query: "not present" });
    expect(all).toMatchObject({
      rows: [],
      skippedBinary: 1,
      skippedCredentials: 1,
      nextOffset: null,
    });
    const listed = await s.inspect({ operation: "list", path: "." });
    expect(listed.rows).toContainEqual({ path: "link", kind: "symlink" });
    expect(
      listed.rows.some(
        (row: { path: string }) => row.path.startsWith(".git") || row.path.startsWith(".codex"),
      ),
    ).toBe(false);
  });

  it.each([
    "../source/app.txt",
    "/etc/passwd",
    "docs/../app.txt",
    ".git/config",
    ".codex/auth.json",
    "docs\\E2E.md",
    "docs//E2E.md",
    "docs/./E2E.md",
    ".env",
  ])("rejects unauthorized path %s", async (path) => {
    const s = await fixture();
    expect((await s.dispatch(s.action({ path }))).result.status).toBe("rejected");
  });

  it("refuses symlink parents, leaf links, shared files, and FIFOs without hanging or reading targets", async () => {
    const s = await fixture();
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "must-not-read");
    symlinkSync(outside, join(s.workspace.path, "escape"));
    symlinkSync(join(outside, "secret.txt"), join(s.workspace.path, "leaf"));
    linkSync(join(outside, "secret.txt"), join(s.workspace.path, "shared"));
    execFileSync("mkfifo", [join(s.workspace.path, "fifo")]);
    for (const path of ["escape/secret.txt", "leaf", "shared", "fifo"]) {
      const { result } = await s.dispatch(s.action({ path }));
      expect(["failed", "rejected"]).toContain(result.status);
      expect(JSON.stringify(result)).not.toContain("must-not-read");
    }
  });

  it("pins the parent directory across a pathname-to-symlink race", async () => {
    const s = await fixture();
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "E2E.md"), "must-not-read");
    let changed = false;
    io.beforeOpen = (path) => {
      if (path.match(/^\/proc\/self\/fd\/\d+\/E2E\.md$/)) {
        changed = true;
        renameSync(join(s.workspace.path, "docs"), join(s.workspace.path, "original-docs"));
        symlinkSync(outside, join(s.workspace.path, "docs"));
      }
    };
    const page = await s.inspect();
    io.beforeOpen = null;
    expect(changed).toBe(true);
    expect(page.rows[0].text).toContain("Start browser tests");
    expect(JSON.stringify(page)).not.toContain("must-not-read");
    expect(readFileSync(join(outside, "E2E.md"), "utf8")).toBe("must-not-read");
  });

  it.each(["sha1", "sha256"] as const)(
    "observes %s content, addition, deletion, mode and symlink changes without using the index",
    async (format) => {
      const s = await fixture(format);
      writeFileSync(join(s.workspace.path, "app.txt"), "staged\n");
      git(s.workspace.path, "add", "app.txt");
      writeFileSync(join(s.workspace.path, "app.txt"), "working\n");
      writeFileSync(join(s.workspace.path, "new.txt"), "added\n");
      rmSync(join(s.workspace.path, "deleted.txt"));
      chmodSync(join(s.workspace.path, "run.sh"), 0o755);
      rmSync(join(s.workspace.path, "link"));
      symlinkSync("new.txt", join(s.workspace.path, "link"));
      const index = readFileSync(join(s.workspace.path, ".git/index"));
      const summary = await s.inspect({ operation: "diff", path: "." });
      expect(summary.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "app.txt", change: "modified" }),
          expect.objectContaining({ path: "new.txt", change: "added" }),
          expect.objectContaining({ path: "deleted.txt", change: "deleted" }),
          expect.objectContaining({ path: "run.sh", beforeMode: "100644", observedMode: "100755" }),
          expect.objectContaining({ path: "link", change: "modified", observedMode: "120000" }),
        ]),
      );
      const diff = await s.inspect({ operation: "diff", path: "app.txt" });
      expect(diff.rows).toEqual([
        expect.objectContaining({ format: "before_after" }),
        { side: "before", line: 1, text: "before" },
        { side: "before", line: 2, text: "second" },
        { side: "after", line: 1, text: "working" },
      ]);
      expect(readFileSync(join(s.workspace.path, ".git/index"))).toEqual(index);
    },
  );

  it("anchors paged history to the recorded revision and treats pathspec syntax literally", async () => {
    const s = await fixture();
    git(s.workspace.path, "update-ref", "--no-deref", "HEAD", s.previous);
    const first = await s.inspect({ operation: "history", path: "docs/E2E.md", limit: 1 });
    expect(first.rows[0].text).toBe(`${s.revision} describe authentication`);
    expect(first.nextOffset).toBe(1);
    const second = await s.inspect({
      operation: "history",
      path: "docs/E2E.md",
      offset: 1,
      limit: 1,
    });
    expect(second.rows[0].text).toBe(`${s.previous} initial baseline`);
    expect(second.nextOffset).toBeNull();
    expect((await s.inspect({ operation: "history", path: ":(glob)**" })).rows).toEqual([]);
    expect(
      (await s.dispatch(s.action({ operation: "history", query: "--all" }))).result.status,
    ).toBe("rejected");
  });

  it("rejects metadata configuration injection before launching history", async () => {
    const s = await fixture();
    writeFileSync(join(s.workspace.path, ".git/config"), "[include]\npath=/etc/passwd\n");
    expect((await s.dispatch(s.action({ operation: "history", path: "." }))).result).toMatchObject({
      status: "rejected",
      code: "git_config_changed",
    });
  });

  it("stops the private metadata walk on cancellation without traversing its remaining entries", async () => {
    const s = await fixture();
    const metadataRoot = join(s.workspace.path, ".git");
    const metadataReads: string[] = [];
    io.beforeLstat = (path) => {
      if (path === metadataRoot || path.startsWith(`${metadataRoot}/`)) {
        metadataReads.push(path);
        s.kernel.interruptAll();
      }
    };
    expect((await s.dispatch(s.action({ operation: "history", path: "." }))).result.status).toBe(
      "cancelled",
    );
    expect(metadataReads).toEqual([metadataRoot]);
  });

  it("bounds escaped output, redacts before page selection, and reports long-line truncation", async () => {
    const s = await fixture();
    writeFileSync(
      join(s.workspace.path, "long.txt"),
      `password="first-secret\nsecond-secret"\n${Array.from({ length: 50 }, () => "\x01".repeat(6000)).join("\n")}\n`,
    );
    const page = await s.inspect({
      operation: "search",
      query: "\x01",
      path: "long.txt",
      offset: 1,
      limit: 1000,
    });
    expect(JSON.stringify(page)).not.toContain("second-secret");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64000);
    expect(page.rowTextTruncated).toBe(true);
    expect(page.nextOffset).toBeGreaterThan(1);
    const tail = await s.inspect({ path: "long.txt", offset: 12000, limit: 1000 });
    expect(tail.rows[0].text).toHaveLength(1000);
    expect(tail.nextOffset).toBe(13000);
    writeFileSync(join(s.workspace.path, "big.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    expect((await s.dispatch(s.action({ path: "big.txt" }))).result).toMatchObject({
      status: "rejected",
      code: "inspection_file_limit",
    });
  });

  it("rejects stale generations and cancels an in-flight observation without accepting its contents", async () => {
    const s = await fixture();
    expect((await s.dispatch(s.action({ workspaceGeneration: 999 }))).result.status).not.toBe(
      "succeeded",
    );
    const original = InspectionFiles.prototype.read;
    vi.spyOn(InspectionFiles.prototype, "read").mockImplementationOnce(async function (
      this: InspectionFiles,
      ...args
    ) {
      const bytes = await original.apply(this, args);
      s.kernel.interruptAll();
      return bytes;
    });
    expect((await s.dispatch(s.action())).result.status).toBe("cancelled");
  });

  it("settles a lost inspection result after controller replacement without rereading or fabricating old output", async () => {
    const s = await fixture();
    const read = vi.spyOn(InspectionFiles.prototype, "read");
    const persistence = vi.spyOn(s.journal, "settleAction").mockImplementationOnce(() => {
      throw new Error("lost result persistence");
    });
    const decision = s.decision(s.action());
    const initial = await s.kernel.execute(decision, s.authority);
    expect(initial.status).toBe("running");
    if (initial.status !== "running") throw new Error("Expected an asynchronous inspection");
    await expect(s.kernel.operation(initial.operationId)).rejects.toThrow(
      "lost result persistence",
    );
    persistence.mockRestore();
    s.store.releaseLease(s.authority.runId, s.authority.ownerToken);
    const recovered = new StateStore(join(s.root, "state.sqlite3"));
    try {
      const lease = recovered.acquireLease(s.authority.runId);
      const authority = {
        runId: s.authority.runId,
        leaseId: lease.leaseId,
        ownerToken: lease.ownerToken,
      };
      writeFileSync(
        join(s.workspace.path, "docs/E2E.md"),
        "new source is not the lost observation\n",
      );
      await reconcileActions(recovered.orchestration, authority, async (action) => {
        expect(action).toMatchObject({
          status: "indeterminate",
          result: { status: "indeterminate", actionId: initial.actionId },
        });
        return reconcileRepositoryInspection(action);
      });
      expect(recovered.orchestration.action(authority.runId, initial.actionId)).toMatchObject({
        status: "failed",
        result: { status: "failed" },
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(recovered.orchestration.control(authority.runId).status).toBe("active");
      const kernel = new ActionKernel(recovered.orchestration);
      registerInspectionCapabilities(
        kernel,
        new WorkspaceManager(recovered.orchestration, join(s.root, "managed")),
      );
      const ticket = recovered.orchestration.beginDecision(
        authority,
        recovered.orchestration.latestObservationCursor(authority.runId),
        recovered.orchestration.control(authority.runId).controlVersion,
      );
      const next = await kernel.execute(
        {
          ...decision,
          request: {
            ...decision.request,
            decisionId: ticket.decisionId,
            observationCursor: ticket.observationCursor,
            expectedControlVersion: ticket.expectedControlVersion,
          },
        },
        authority,
      );
      if (next.status !== "running") throw new Error(JSON.stringify(next));
      const observed = await kernel.operation(next.operationId);
      expect(observed).toMatchObject({ status: "succeeded" });
      expect(JSON.stringify(observed)).toContain("new source is not the lost observation");
      expect(read).toHaveBeenCalledTimes(2);
      recovered.releaseLease(authority.runId, authority.ownerToken);
    } finally {
      recovered.close();
    }
  });

  it("detects replacement of the workspace root while preserving both directories", async () => {
    const s = await fixture();
    const original = InspectionFiles.prototype.read;
    vi.spyOn(InspectionFiles.prototype, "read").mockImplementationOnce(async function (
      this: InspectionFiles,
      ...args
    ) {
      const bytes = await original.apply(this, args);
      renameSync(s.workspace.path, `${s.workspace.path}-preserved`);
      mkdirSync(s.workspace.path);
      return bytes;
    });
    expect((await s.dispatch(s.action())).result).toMatchObject({
      status: "rejected",
      code: "inspection_root_changed",
    });
    expect(readFileSync(join(`${s.workspace.path}-preserved`, "docs/E2E.md"), "utf8")).toContain(
      "peer authentication",
    );
  });

  it("shows a symlink value and binary change metadata without following the target", async () => {
    const s = await fixture();
    const outside = join(s.root, "secret.txt");
    writeFileSync(outside, "must-not-read");
    rmSync(join(s.workspace.path, "link"));
    symlinkSync(outside, join(s.workspace.path, "link"));
    const diff = await s.inspect({ operation: "diff", path: "link" });
    expect(diff.rows).toContainEqual({ side: "after", line: 1, text: outside });
    expect(diff.rows[0]).toMatchObject({ afterMode: "120000", symlinkTargetsFollowed: false });
    expect(JSON.stringify(diff)).not.toContain("must-not-read");
    writeFileSync(join(s.workspace.path, "app.txt"), Buffer.from([0, 1, 255]));
    expect((await s.inspect({ operation: "diff", path: "app.txt" })).rows[0].binary).toBe(true);
    expect((await s.dispatch(s.action({ path: "app.txt" }))).result).toMatchObject({
      status: "rejected",
      code: "inspection_binary",
    });
  });

  it("rejects oversized scans and directory depth instead of returning a misleading partial match set", async () => {
    const s = await fixture();
    mkdirSync(join(s.workspace.path, "large"));
    for (let i = 0; i < 9; i++)
      writeFileSync(join(s.workspace.path, "large", `${i}.txt`), Buffer.alloc(4 * 1024 * 1024, 65));
    expect(
      (await s.dispatch(s.action({ operation: "search", path: "large", query: "missing" }))).result,
    ).toMatchObject({ status: "rejected", code: "inspection_scan_limit" });
    let path = join(s.workspace.path, "deep");
    mkdirSync(path);
    for (let i = 0; i < 66; i++) {
      path = join(path, "d");
      mkdirSync(path);
    }
    expect((await s.dispatch(s.action({ operation: "list", path: "deep" }))).result).toMatchObject({
      status: "rejected",
      code: "inspection_depth_limit",
    });
  });

  it("keeps character pagination complete across Unicode and redacted secrets", async () => {
    const s = await fixture();
    writeFileSync(
      join(s.workspace.path, "unicode.txt"),
      'alpha 🐑\npassword="do-not-retain"\nend\n',
    );
    let offset = 0;
    let reconstructed = "";
    for (let count = 0; count < 30; count++) {
      const page = await s.inspect({ path: "unicode.txt", offset, limit: 5 });
      reconstructed += page.rows[0]?.text ?? "";
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(reconstructed).toBe("alpha 🐑\npassword=[REDACTED]\nend\n");
    const stored = JSON.stringify(s.journal.actions(s.authority.runId));
    expect(stored).not.toContain("do-not-retain");
    expect((await s.inspect({ path: "unicode.txt", offset: 1000 })).rows).toEqual([]);
  });
});
