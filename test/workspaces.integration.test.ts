import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { StateStore } from "../src/adapters/store.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { SdkAgentSessionContractSchema } from "../src/domain/types.js";
import type { ControllerAuthority } from "../src/domain/orchestration.js";
import type { WorkspaceRecord } from "../src/domain/agents.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { fixtureAccounts } from "./fixtures/accounts.js";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(repo: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo, ...args],
    { encoding: "utf8" },
  ).trim();
}
function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync(join(tmpdir(), "epicd-workspaces-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "--quiet", `--object-format=${format}`);
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "app.txt"), "base\n");
  writeFileSync(join(source, ".gitignore"), "ignored/\n");
  mkdirSync(join(source, ".beads"));
  writeFileSync(join(source, ".beads", "issues.jsonl"), "tracker baseline\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "baseline");
  const head = git(source, "rev-parse", "HEAD");
  const store = new StateStore(join(root, "state.sqlite3"));
  stores.push(store);
  const initial = initialRun();
  initial.repoPath = source;
  initial.runtimeConfiguration = {
    commonDirectory: { path: join(source, ".git"), device: "1", inode: "1" },
    executable: process.execPath,
    trackerExecutable: process.execPath,
    runtimeRoot: join(root, "runtime"),
    workspaceRoot: join(root, "managed"),
    accounts: fixtureAccounts(root),
    turnTimeoutMs: 15_000,
    herdr: null,
  };
  const state = store.create(initial, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  const fixtureDatabase = new Database(join(root, "state.sqlite3"));
  fixtureDatabase.prepare("DELETE FROM tracker_roots WHERE run_id = ?").run(state.runId);
  fixtureDatabase.close();
  const lease = store.acquireLease(state.runId);
  const authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const manager = new WorkspaceManager(store.orchestration, join(root, "managed"));
  return { root, source, head, store, authority, manager };
}

function reserveWriter(setup: ReturnType<typeof fixture>, workspace: WorkspaceRecord) {
  const settings = { model: "worker", reasoningEffort: "high" as const };
  return setup.store.orchestration.agents.reserveAgent(
    setup.authority,
    {
      ...workspace,
      role: "implementation",
      purpose: "implementation",
      taskId: "demo.1",
      candidateId: null,
      instructions: "Implement",
      confinementProfile: "fixture",
      contract: SdkAgentSessionContractSchema.parse({
        backend: "codex",
        runtime: "sdk",
        requested: settings,
        effective: settings,
      }),
    },
    setup.store.orchestration.control(setup.authority.runId).controlVersion,
  );
}

describe("managed independent Git workspaces", () => {
  it.each(["sha1", "sha256"] as const)(
    "copies an exact %s baseline without touching the user's dirty checkout, index, or branch",
    async (format) => {
      const setup = fixture(format);
      writeFileSync(join(setup.source, "app.txt"), "user staged change\n");
      git(setup.source, "add", "app.txt");
      writeFileSync(join(setup.source, "app.txt"), "user concurrent unstaged change\n");
      writeFileSync(join(setup.source, "user-note.txt"), "user-owned untracked\n");
      const index = readFileSync(join(setup.source, ".git", "index"));
      const headFile = readFileSync(join(setup.source, ".git", "HEAD"));
      const work = await setup.manager.create(
        setup.authority,
        setup.source,
        setup.head,
        "implementation",
      );
      expect(work.status).toBe("ready");
      expect(work.sourceMode).toBe("mutable");
      expect(readFileSync(join(work.path, "app.txt"), "utf8")).toBe("base\n");
      expect(existsSync(join(work.path, "user-note.txt"))).toBe(false);
      expect(git(work.path, "rev-parse", "HEAD")).toBe(setup.head);
      expect(git(work.path, "remote")).toBe("");
      expect(existsSync(join(work.path, ".git", "objects", "info", "alternates"))).toBe(false);
      const object = setup.head;
      const sourceObject = lstatSync(
        join(setup.source, ".git", "objects", object.slice(0, 2), object.slice(2)),
      );
      const copiedObject = lstatSync(
        join(work.path, ".git", "objects", object.slice(0, 2), object.slice(2)),
      );
      expect(copiedObject.nlink).toBe(1);
      expect(copiedObject.ino).not.toBe(sourceObject.ino);
      expect(readFileSync(join(setup.source, ".git", "index"))).toEqual(index);
      expect(readFileSync(join(setup.source, ".git", "HEAD"))).toEqual(headFile);
      expect(readFileSync(join(setup.source, "app.txt"), "utf8")).toBe(
        "user concurrent unstaged change\n",
      );
      expect(readFileSync(join(setup.source, "user-note.txt"), "utf8")).toBe(
        "user-owned untracked\n",
      );
    },
  );

  it("captures binary bytes, unusual names, symlinks, deletions, and executable modes with a separate index", async () => {
    const setup = fixture();
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    const index = readFileSync(join(work.path, ".git", "index"));
    rmSync(join(work.path, "app.txt"));
    const name = "new file\nwith tab\t☃.bin";
    const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
    writeFileSync(join(work.path, name), binary);
    writeFileSync(join(work.path, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(join(work.path, "run.sh"), 0o755);
    symlinkSync("run.sh", join(work.path, "run-link"));
    const rawTarget = Buffer.from([0x66, 0x6f, 0xff, 0x80]);
    symlinkSync(rawTarget, join(work.path, "raw-link"));
    mkdirSync(join(work.path, "ignored"));
    writeFileSync(join(work.path, "ignored", "build.out"), "not source");
    const snapshot = await setup.manager.capture(setup.authority, work, randomUUID());
    expect(snapshot.parentRevision).toBe(setup.head);
    expect(snapshot.manifest.find((entry) => entry.path === name)?.size).toBe(binary.length);
    expect(snapshot.manifest.find((entry) => entry.path === "run.sh")?.mode).toBe("100755");
    expect(snapshot.manifest.find((entry) => entry.path === "run-link")?.mode).toBe("120000");
    expect(
      snapshot.manifest.some(
        (entry) => entry.path === "app.txt" || entry.path.startsWith("ignored/"),
      ),
    ).toBe(false);
    expect(snapshot.fullTree).not.toBe(snapshot.applicationTree);
    expect(git(work.path, "rev-parse", "HEAD")).toBe(setup.head);
    expect(readFileSync(join(work.path, ".git", "index"))).toEqual(index);
    const review = await setup.manager.createSnapshotCopy(setup.authority, snapshot);
    expect(review.sourceMode).toBe("immutable");
    expect(review.baselineFingerprint).toBe(snapshot.fingerprint);
    expect(readFileSync(join(review.path, name))).toEqual(binary);
    expect(readlinkSync(join(review.path, "run-link"))).toBe("run.sh");
    expect(readlinkSync(join(review.path, "raw-link"), { encoding: "buffer" })).toEqual(rawTarget);
    expect(lstatSync(join(review.path, "run.sh")).mode & 0o111).not.toBe(0);
    expect(git(review.path, "rev-parse", "HEAD^{tree}")).toBe(snapshot.fullTree);
    expect(existsSync(join(review.path, "ignored", "build.out"))).toBe(false);
  });

  it("keeps captured candidates independent of subsequent implementation changes", async () => {
    const setup = fixture();
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    writeFileSync(join(work.path, "app.txt"), "candidate one\n");
    const id = randomUUID();
    const first = await setup.manager.capture(setup.authority, work, id);
    expect(await setup.manager.capture(setup.authority, work, id)).toEqual(first);
    writeFileSync(join(work.path, "app.txt"), "candidate two\n");
    await expect(setup.manager.capture(setup.authority, work, id)).rejects.toThrow(
      "different bytes",
    );
    const review = await setup.manager.createSnapshotCopy(setup.authority, first);
    expect(readFileSync(join(review.path, "app.txt"), "utf8")).toBe("candidate one\n");
    writeFileSync(join(review.path, "app.txt"), "diagnostic contamination\n");
    expect(readFileSync(join(work.path, "app.txt"), "utf8")).toBe("candidate two\n");
    expect(readFileSync(join(setup.source, "app.txt"), "utf8")).toBe("base\n");
  });

  it("copies a linked source worktree into an independent detached repository", async () => {
    const setup = fixture();
    const linked = join(setup.root, "linked-source");
    git(setup.source, "worktree", "add", "--quiet", "--detach", linked, setup.head);
    writeFileSync(join(linked, "app.txt"), "user's linked checkout change\n");
    const gitFile = readFileSync(join(linked, ".git"));
    const work = await setup.manager.create(setup.authority, linked, setup.head, "implementation");
    expect(lstatSync(join(work.path, ".git")).isDirectory()).toBe(true);
    expect(readFileSync(join(work.path, "app.txt"), "utf8")).toBe("base\n");
    expect(git(work.path, "rev-parse", "--git-common-dir")).toBe(".git");
    expect(readFileSync(join(linked, ".git"))).toEqual(gitFile);
    expect(readFileSync(join(linked, "app.txt"), "utf8")).toBe("user's linked checkout change\n");
  });

  it("refuses tracker changes, active writers, and metadata shared through hard links", async () => {
    const setup = fixture();
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    writeFileSync(join(work.path, ".beads", "issues.jsonl"), "agent tracker change");
    await expect(setup.manager.capture(setup.authority, work, randomUUID())).rejects.toThrow(
      "Only the kernel",
    );
    writeFileSync(join(work.path, ".beads", "issues.jsonl"), "tracker baseline\n");
    const linked = join(work.path, ".git", "linked-object");
    linkSync(join(setup.source, "app.txt"), linked);
    await expect(setup.manager.capture(setup.authority, work, randomUUID())).rejects.toThrow(
      "shared",
    );
    rmSync(linked);
    const settings = { model: "worker", reasoningEffort: "high" as const };
    const agent = setup.store.orchestration.agents.reserveAgent(
      setup.authority,
      {
        ...work,
        role: "implementation",
        purpose: "implementation",
        taskId: "demo.1",
        candidateId: null,
        instructions: "Implement",
        confinementProfile: "fixture",
        contract: SdkAgentSessionContractSchema.parse({
          backend: "codex",
          runtime: "sdk",
          requested: settings,
          effective: settings,
        }),
      },
      setup.store.orchestration.control(setup.authority.runId).controlVersion,
    );
    setup.store.orchestration.agents.prepareTurn(
      setup.authority,
      agent,
      randomUUID(),
      "Work",
      {},
      setup.store.orchestration.control(setup.authority.runId).controlVersion,
    );
    await expect(setup.manager.capture(setup.authority, work, randomUUID())).rejects.toThrow(
      "may still be writing",
    );
  });

  it("does not execute source hooks, fsmonitor commands, or clean/smudge filters", async () => {
    const setup = fixture();
    const marker = join(setup.root, "executed");
    const command = `touch ${marker}`;
    git(setup.source, "config", "core.fsmonitor", command);
    writeFileSync(join(setup.source, ".git", "hooks", "post-checkout"), `#!/bin/sh\n${command}\n`, {
      mode: 0o755,
    });
    git(setup.source, "config", "filter.host.clean", command);
    git(setup.source, "config", "filter.host.smudge", command);
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(work.path, ".gitattributes"), "app.txt filter=host\n");
    await expect(setup.manager.capture(setup.authority, work, randomUUID())).rejects.toThrow(
      "Materialization attribute",
    );
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(work.path, ".git", "config"), "utf8")).not.toContain(command);
  });

  it("rejects shared source object stores and submodule trees without leaving a ready checkout", async () => {
    const setup = fixture();
    writeFileSync(
      join(setup.source, ".git", "objects", "info", "alternates"),
      "/unowned/object/store\n",
    );
    await expect(
      setup.manager.create(setup.authority, setup.source, setup.head, "implementation"),
    ).rejects.toThrow("Unsupported repository metadata");
    rmSync(join(setup.source, ".git", "objects", "info", "alternates"));
    git(setup.source, "update-index", "--add", "--cacheinfo", `160000,${setup.head},nested`);
    git(setup.source, "commit", "--quiet", "-m", "submodule fixture");
    await expect(
      setup.manager.create(
        setup.authority,
        setup.source,
        git(setup.source, "rev-parse", "HEAD"),
        "implementation",
      ),
    ).rejects.toThrow("Submodules");
    expect(setup.store.orchestration.agents.instances(setup.authority.runId)).toEqual([]);
  });

  it("refuses symlink escapes, shared application files, and changed workspace paths", async () => {
    const setup = fixture();
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    symlinkSync(setup.source, join(work.path, "outside"));
    await expect(
      setup.manager.read(setup.authority, work, "outside/app.txt", 0, 100),
    ).rejects.toThrow("symbolic-link parent");
    await expect(
      setup.manager.read(setup.authority, work, "../source/app.txt", 0, 100),
    ).rejects.toThrow("escapes");
    await expect(setup.manager.read(setup.authority, work, ".git/config", 0, 100)).rejects.toThrow(
      "escapes",
    );
    linkSync(join(setup.source, "app.txt"), join(work.path, "linked.txt"));
    await expect(setup.manager.capture(setup.authority, work, randomUUID())).rejects.toThrow(
      "unshared regular files",
    );
    expect(readFileSync(join(setup.source, "app.txt"), "utf8")).toBe("base\n");
    rmSync(join(work.path, "linked.txt"));
    await expect(
      setup.manager.create(setup.authority, setup.source, "HEAD", "review"),
    ).rejects.toThrow("exact commit");
  });

  it("reconciles a complete matching copy, preserves dirty copies, and rejects stale authority", async () => {
    const setup = fixture();
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    expect(await setup.manager.inspectMaterialization(setup.authority, work)).toBe("ready");
    writeFileSync(join(work.path, "app.txt"), "unexpected user intervention\n");
    expect(await setup.manager.inspectMaterialization(setup.authority, work)).toBe("incomplete");
    expect(readFileSync(join(work.path, "app.txt"), "utf8")).toBe("unexpected user intervention\n");
    await expect(
      setup.manager.capture({ ...setup.authority, leaseId: "old" }, work, randomUUID()),
    ).rejects.toThrow("lease");
    const read = await setup.manager.read(setup.authority, work, "app.txt", 0, 10);
    expect(read).toEqual({ text: "unexpected", truncated: true });
    expect(readdirSync(join(setup.root, "managed", setup.authority.runId))).toContain(
      work.workspaceId,
    );
  });

  it("holds a durable exclusion throughout asynchronous capture and releases it only after I/O settles", async () => {
    const setup = fixture();
    const { agents } = setup.store.orchestration;
    const version = () => setup.store.orchestration.control(setup.authority.runId).controlVersion;
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    const agent = reserveWriter(setup, work);
    const capture = setup.manager.capture(setup.authority, work, randomUUID());
    const operation = agents.activeWorkspaceOperation(setup.authority.runId, work)!;
    expect(operation).toMatchObject({ kind: "capture", status: "running", stopEvidence: null });
    expect(() =>
      agents.prepareTurn(setup.authority, agent, randomUUID(), "Work", {}, version()),
    ).toThrow("exclusively owned workspace");
    await expect(setup.manager.capture(setup.authority, work, randomUUID())).rejects.toThrow(
      "may still be writing",
    );
    await capture;
    expect(agents.workspaceOperation(setup.authority.runId, operation.operationId)).toMatchObject({
      status: "succeeded",
      stopEvidence: expect.any(String),
    });
    expect(agents.activeWorkspaceOperation(setup.authority.runId, work)).toBeNull();
    expect(
      agents.prepareTurn(setup.authority, agent, randomUUID(), "Work", {}, version()).status,
    ).toBe("prepared");
  });

  it("preserves an uncertain I/O exclusion across reopen and controller lease replacement", async () => {
    const setup = fixture();
    const { agents } = setup.store.orchestration;
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    const operation = agents.beginWorkspaceOperation(
      setup.authority,
      work,
      "capture",
      setup.store.orchestration.control(setup.authority.runId).controlVersion,
    );
    expect(() => reserveWriter(setup, work)).toThrow("unoccupied workspace");
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    const reopened = new StateStore(join(setup.root, "state.sqlite3"));
    stores.push(reopened);
    const lease = reopened.acquireLease(setup.authority.runId);
    const newAuthority = {
      ...setup.authority,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    const manager = new WorkspaceManager(reopened.orchestration, join(setup.root, "managed"));
    expect(
      reopened.orchestration.agents.activeWorkspaceOperation(newAuthority.runId, work)?.operationId,
    ).toBe(operation.operationId);
    await expect(manager.capture(newAuthority, work, randomUUID())).rejects.toThrow(
      "may still be writing",
    );
    expect(() =>
      reopened.orchestration.agents.finishWorkspaceOperation(
        newAuthority,
        operation.operationId,
        "failed",
        "Lease expired",
      ),
    ).toThrow("independent stop reconciliation");
    expect(() =>
      agents.finishWorkspaceOperation(
        setup.authority,
        operation.operationId,
        "failed",
        "Stale controller",
      ),
    ).toThrow("lease");
    expect(readFileSync(join(work.path, "app.txt"), "utf8")).toBe("base\n");
  });

  it("does not adopt missing or contaminated reservations, including ignored files", async () => {
    const setup = fixture();
    const { agents } = setup.store.orchestration;
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    const database = new Database(join(setup.root, "state.sqlite3"));
    try {
      // Crash point: all bytes exist but the readiness transaction has not happened yet.
      database.prepare("UPDATE workspaces SET record_json = ? WHERE workspace_id = ?").run(
        JSON.stringify({
          ...work,
          status: "reserved",
          directory: null,
          baselineFingerprint: null,
        }),
        work.workspaceId,
      );
      mkdirSync(join(work.path, "ignored"));
      writeFileSync(join(work.path, "ignored", "unknown.txt"), "preserve this intervention");
      expect(await setup.manager.inspectMaterialization(setup.authority, work)).toBe("incomplete");
      expect(agents.workspace(setup.authority.runId, work).status).toBe("reserved");
      expect(readFileSync(join(work.path, "ignored", "unknown.txt"), "utf8")).toBe(
        "preserve this intervention",
      );
      rmSync(join(work.path, "ignored", "unknown.txt"));
      expect(await setup.manager.inspectMaterialization(setup.authority, work)).toBe("ready");
      expect(agents.workspace(setup.authority.runId, work).baselineFingerprint).toBe(
        work.baselineFingerprint,
      );
    } finally {
      database.close();
    }
    const missing = agents.reserveWorkspace(
      setup.authority,
      {
        root: join(setup.root, "managed"),
        purpose: "review",
        sourceMode: "immutable",
        baselineRevision: setup.head,
      },
      setup.store.orchestration.control(setup.authority.runId).controlVersion,
    );
    expect(await setup.manager.inspectMaterialization(setup.authority, missing)).toBe("incomplete");
    expect(existsSync(missing.path)).toBe(false);
    expect(agents.workspace(setup.authority.runId, missing).status).toBe("reserved");
  });

  it("checks private metadata before Git can read injected configuration, and releases settled failures", async () => {
    const setup = fixture();
    const work = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    const configPath = join(work.path, ".git", "config");
    const config = readFileSync(configPath);
    // Git would otherwise try to read the directory as an included configuration file.
    writeFileSync(configPath, `[include]\npath = ${setup.source}\n`);
    await expect(setup.manager.capture(setup.authority, work, randomUUID())).rejects.toMatchObject({
      code: "git_config_changed",
    });
    expect(
      setup.store.orchestration.agents.activeWorkspaceOperation(setup.authority.runId, work),
    ).toBeNull();
    writeFileSync(configPath, config);
    expect((await setup.manager.capture(setup.authority, work, randomUUID())).parentRevision).toBe(
      setup.head,
    );
  });
});
