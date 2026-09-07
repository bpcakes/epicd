import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelGit } from "../src/adapters/kernel-git.js";
import {
  PublicationGit,
  publicationRefs,
  publicationKeepMessage,
} from "../src/adapters/publication-git.js";
import {
  PublicationRefIntentSchema,
  type PublicationRefIntent,
} from "../src/domain/publication.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (path: string, ...args: string[]) =>
  execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const bytes = (path: string, revision: string) =>
  execFileSync("git", ["-C", path, "cat-file", "commit", revision], {
    stdio: ["pipe", "pipe", "pipe"],
  });
const guard = async (signal: AbortSignal) => signal.throwIfAborted();
const signal = () => new AbortController().signal;

async function fixture(format: "sha1" | "sha256" = "sha1", linked = false) {
  const root = mkdtempSync("/var/tmp/epicd-publication-");
  roots.push(root);
  const user = join(root, "user");
  const source = join(root, "source");
  mkdirSync(user);
  git(user, "init", "--quiet", "--initial-branch=main", `--object-format=${format}`);
  git(user, "config", "user.name", "Fixture");
  git(user, "config", "user.email", "fixture@example.test");
  writeFileSync(join(user, "app"), "one\n");
  git(user, "add", "app");
  git(user, "commit", "--quiet", "-m", "one");
  const base = git(user, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--no-local", user, source);
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "app"), "two\n");
  git(source, "add", "app");
  git(source, "commit", "--quiet", "-m", "two");
  const revision = git(source, "rev-parse", "HEAD");
  const selected = linked ? join(root, "linked") : user;
  if (linked) git(user, "worktree", "add", "--quiet", "-b", "linked", selected);
  const transport = new PublicationGit();
  const repository = await transport.bind(selected);
  const sourceRepository = await transport.bind(source);
  const intent = PublicationRefIntentSchema.parse({
    schemaVersion: 1,
    publicationId: randomUUID(),
    runId: "fixture-run",
    repository,
    revision,
    expectedRef: null,
  });
  const pack = await transport.pack(sourceRepository, intent.publicationId, revision, base);
  const imported = () => transport.importPack(repository, pack.record, pack.bytes, guard, signal());
  return {
    root,
    user,
    source,
    selected,
    base,
    revision,
    repository,
    sourceRepository,
    transport,
    intent,
    pack,
    imported,
    refs: publicationRefs(intent),
    update: (intentOverride: PublicationRefIntent = intent) =>
      transport.updateRefs(intentOverride, guard, signal()),
  };
}

describe("publication Git transport (physical facts, not approval or durable dispatch)", () => {
  it.each(["sha1", "sha256"] as const)(
    "imports identical %s objects and publishes without changing dirty checkout/index/HEAD",
    async (format) => {
      const f = await fixture(format);
      writeFileSync(join(f.user, "app"), "user staged\n");
      git(f.user, "add", "app");
      writeFileSync(join(f.user, "app"), "user unstaged\n");
      writeFileSync(join(f.user, "untracked"), "user scratch\n");
      const index = readFileSync(join(f.user, ".git/index"));
      const head = readFileSync(join(f.user, ".git/HEAD"));
      const headLog = readFileSync(join(f.user, ".git/logs/HEAD"));
      await f.imported();
      expect(bytes(f.user, f.revision)).toEqual(bytes(f.source, f.revision));
      // Pack retention prevents the imported-but-not-yet-referenced commit from being collected.
      git(f.user, "gc", "--prune=now");
      expect(bytes(f.user, f.revision)).toEqual(bytes(f.source, f.revision));
      await f.update();
      expect(await f.transport.observeRefs(f.intent)).toMatchObject({
        outcome: "applied",
        branchRevision: f.revision,
        receiptRevision: f.revision,
      });
      expect(git(f.user, "rev-parse", "HEAD")).toBe(f.base);
      expect(readFileSync(join(f.user, ".git/index"))).toEqual(index);
      expect(readFileSync(join(f.user, ".git/HEAD"))).toEqual(head);
      expect(readFileSync(join(f.user, ".git/logs/HEAD"))).toEqual(headLog);
      expect(readFileSync(join(f.user, "app"), "utf8")).toBe("user unstaged\n");
      expect(readFileSync(join(f.user, "untracked"), "utf8")).toBe("user scratch\n");
      expect(
        readFileSync(join(f.user, `.git/objects/pack/pack-${f.pack.record.packHash}.keep`), "utf8"),
      ).toBe(`${publicationKeepMessage(f.pack.record)}\n`);
      await expect(f.update()).rejects.toThrow("write-once intent");
    },
  );

  it("uses a linked worktree's common metadata and locks every known HEAD", async () => {
    const f = await fixture("sha1", true);
    await f.imported();
    const selectedHead = readFileSync(join(f.repository.gitDirectory.path, "HEAD"));
    const selectedIndex = readFileSync(join(f.repository.gitDirectory.path, "index"));
    const selectedLog = readFileSync(join(f.repository.gitDirectory.path, "logs/HEAD"));
    let calls = 0;
    await f.transport.updateRefs(
      f.intent,
      async () => {
        if (++calls !== 2) return;
        expect(existsSync(join(f.user, ".git/HEAD.lock"))).toBe(true);
        expect(existsSync(join(f.repository.gitDirectory.path, "HEAD.lock"))).toBe(true);
        expect(() => git(f.selected, "symbolic-ref", "HEAD", f.refs.branch)).toThrow();
        expect(() => git(f.user, "update-ref", "refs/heads/main", f.revision)).toThrow();
      },
      signal(),
    );
    expect(calls).toBe(2);
    expect(git(f.selected, "rev-parse", f.refs.branch)).toBe(f.revision);
    expect(readFileSync(join(f.repository.gitDirectory.path, "HEAD"))).toEqual(selectedHead);
    expect(readFileSync(join(f.repository.gitDirectory.path, "index"))).toEqual(selectedIndex);
    expect(readFileSync(join(f.repository.gitDirectory.path, "logs/HEAD"))).toEqual(selectedLog);
  });

  it("uses a fixed kernel reflog identity and disables repository hooks", async () => {
    const f = await fixture();
    git(f.user, "config", "--unset", "user.name");
    git(f.user, "config", "--unset", "user.email");
    const hook = join(f.user, ".git/hooks/reference-transaction");
    writeFileSync(hook, '#!/bin/sh\nprintf touched > "' + join(f.root, "hook-ran") + '"\n', {
      mode: 0o700,
    });
    const repository = await f.transport.bind(f.user);
    await f.transport.importPack(repository, f.pack.record, f.pack.bytes, guard, signal());
    await f.update({ ...f.intent, repository });
    expect(existsSync(join(f.root, "hook-ran"))).toBe(false);
    expect(readFileSync(join(f.user, `.git/logs/${f.refs.branch}`), "utf8")).toContain(
      "Epicd <epicd@epicd.local>",
    );
  });

  it("handles a detached selected HEAD without moving it", async () => {
    const f = await fixture();
    await f.imported();
    git(f.user, "switch", "--quiet", "--detach", f.base);
    const before = readFileSync(join(f.user, ".git/HEAD"));
    await f.update();
    expect(readFileSync(join(f.user, ".git/HEAD"))).toEqual(before);
  });

  it("settles every nested HEAD lock on cancellation before the branch update", async () => {
    const f = await fixture("sha1", true);
    const second = join(f.root, "second-linked");
    git(f.user, "worktree", "add", "--quiet", "--detach", second, f.base);
    await f.imported();
    const controller = new AbortController();
    let calls = 0;
    await expect(
      f.transport.updateRefs(
        f.intent,
        async () => {
          if (++calls === 2) controller.abort();
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    for (const path of [
      join(f.user, ".git/HEAD.lock"),
      join(f.repository.gitDirectory.path, "HEAD.lock"),
      join(f.user, ".git/worktrees/second-linked/HEAD.lock"),
    ])
      expect(existsSync(path)).toBe(false);
    expect(await f.transport.observeRefs(f.intent)).toMatchObject({ outcome: "not_applied" });
  });

  it("rejects a new linked worktree before commit and preserves the user's newly created worktree", async () => {
    const f = await fixture();
    await f.imported();
    const added = join(f.root, "user-added");
    let calls = 0;
    await expect(
      f.transport.updateRefs(
        f.intent,
        async () => {
          if (++calls === 1) git(f.user, "worktree", "add", "--quiet", "--detach", added, f.base);
        },
        signal(),
      ),
    ).rejects.toThrow("topology changed");
    expect(existsSync(join(added, "app"))).toBe(true);
    expect(await f.transport.observeRefs(f.intent)).toMatchObject({ outcome: "not_applied" });
  });

  it("reports late worktree intervention without rolling back already written refs", async () => {
    const f = await fixture();
    await f.imported();
    const added = join(f.root, "late-user-worktree");
    const original = KernelGit.prototype.text;
    vi.spyOn(KernelGit.prototype, "text").mockImplementation(async function (
      this: KernelGit,
      args,
      options,
    ) {
      const result = await original.call(this, args, options);
      if (args[0] === "update-ref" && options?.input?.toString().includes(f.refs.receipt))
        git(f.user, "worktree", "add", "--quiet", added, "epicd/fixture-run");
      return result;
    });
    await expect(f.update()).rejects.toThrow("checked out");
    expect(await f.transport.observeRefs(f.intent)).toMatchObject({ outcome: "applied" });
    expect(git(added, "rev-parse", "HEAD")).toBe(f.revision);
    expect(git(f.user, "rev-parse", "HEAD")).toBe(f.base);
  });

  it("extends a previously owned run ref by exact CAS, including a packed old ref", async () => {
    const f = await fixture();
    await f.imported();
    await f.update();
    writeFileSync(join(f.source, "app"), "three\n");
    git(f.source, "commit", "--quiet", "-am", "three");
    const next = {
      ...f.intent,
      publicationId: randomUUID(),
      expectedRef: f.revision,
      revision: git(f.source, "rev-parse", "HEAD"),
    };
    const pack = await f.transport.pack(
      f.sourceRepository,
      next.publicationId,
      next.revision,
      f.revision,
    );
    await f.transport.importPack(f.repository, pack.record, pack.bytes, guard, signal());
    git(f.user, "pack-refs", "--all");
    await f.update(next);
    expect(await f.transport.observeRefs(next)).toMatchObject({ outcome: "applied" });
    expect(git(f.user, "rev-parse", f.refs.receipt)).toBe(f.revision);
  });

  it.each(["base", "target"] as const)(
    "rejects an unowned existing branch even when it matches the %s SHA",
    async (which) => {
      const f = await fixture();
      await f.imported();
      const value = which === "base" ? f.base : f.revision;
      git(f.user, "update-ref", f.refs.branch, value);
      await expect(f.update()).rejects.toThrow("write-once intent");
      expect(git(f.user, "rev-parse", f.refs.branch)).toBe(value);
      expect(await f.transport.observeRefs(f.intent)).toMatchObject({
        outcome: "conflict",
        receiptRevision: null,
      });
    },
  );

  it("refuses CAS drift, rewind and non-commit objects without changing the existing branch", async () => {
    const f = await fixture();
    await f.imported();
    await f.update();
    await expect(
      f.update({ ...f.intent, publicationId: randomUUID(), expectedRef: f.base }),
    ).rejects.toThrow("write-once");
    await expect(
      f.update({
        ...f.intent,
        publicationId: randomUUID(),
        expectedRef: f.revision,
        revision: f.base,
      }),
    ).rejects.toThrow();
    const tree = git(f.user, "rev-parse", `${f.revision}^{tree}`);
    await expect(
      f.update({
        ...f.intent,
        publicationId: randomUUID(),
        expectedRef: f.revision,
        revision: tree,
      }),
    ).rejects.toThrow("commit objects");
    expect(git(f.user, "rev-parse", f.refs.branch)).toBe(f.revision);
  });

  it.each([false, true])(
    "rejects a checked-out run branch (linked selection: %s)",
    async (linked) => {
      const f = await fixture("sha1", linked);
      await f.imported();
      git(f.user, "update-ref", f.refs.branch, f.base);
      git(f.user, "switch", "--quiet", "epicd/fixture-run");
      await expect(f.update({ ...f.intent, expectedRef: f.base })).rejects.toThrow("checked out");
      expect(git(f.user, "rev-parse", "HEAD")).toBe(f.base);
    },
  );

  it("rejects symbolic branches and receipts instead of following them to unrelated refs", async () => {
    const f = await fixture();
    await f.imported();
    git(f.user, "symbolic-ref", f.refs.branch, "refs/heads/main");
    await expect(f.update()).rejects.toThrow("symbolic branch or receipt");
    expect(git(f.user, "rev-parse", "main")).toBe(f.base);
    git(f.user, "symbolic-ref", "--delete", f.refs.branch);
    git(f.user, "symbolic-ref", f.refs.receipt, "refs/heads/main");
    await expect(f.update()).rejects.toThrow("symbolic branch or receipt");
    expect(git(f.user, "rev-parse", "main")).toBe(f.base);
  });

  it("catches symbolic redirection introduced after preflight under prepared locks", async () => {
    const f = await fixture();
    await f.imported();
    git(f.user, "update-ref", f.refs.branch, f.base);
    let calls = 0;
    await expect(
      f.transport.updateRefs(
        { ...f.intent, expectedRef: f.base },
        async () => {
          if (++calls === 1) git(f.user, "symbolic-ref", f.refs.branch, "refs/heads/main");
        },
        signal(),
      ),
    ).rejects.toThrow("symbolic branch or receipt");
    expect(calls).toBe(1);
    expect(git(f.user, "symbolic-ref", f.refs.branch)).toBe("refs/heads/main");
    expect(git(f.user, "rev-parse", "main")).toBe(f.base);
    expect(() => git(f.user, "rev-parse", "--verify", f.refs.receipt)).toThrow();
  });

  it("aborts after authority or configuration changes and retains imported objects", async () => {
    const f = await fixture();
    await f.imported();
    let calls = 0;
    await expect(
      f.transport.updateRefs(
        f.intent,
        async () => {
          if (++calls === 2) throw new Error("lease changed");
        },
        signal(),
      ),
    ).rejects.toThrow("lease changed");
    expect(await f.transport.observeRefs(f.intent)).toMatchObject({ outcome: "not_applied" });
    expect(bytes(f.user, f.revision)).toEqual(bytes(f.source, f.revision));
    calls = 0;
    await expect(
      f.transport.updateRefs(
        f.intent,
        async () => {
          if (++calls === 1) git(f.user, "config", "epicd.userChange", "preserve");
        },
        signal(),
      ),
    ).rejects.toThrow("identity or configuration changed");
    expect(() => git(f.user, "show-ref", "--verify", f.refs.branch)).toThrow();
    expect(git(f.user, "config", "epicd.userChange")).toBe("preserve");
  });

  it("refuses changed repository identity and symlink/hardlink metadata without following write aliases", async () => {
    const f = await fixture();
    await f.imported();
    const refs = join(f.user, ".git/refs/heads/epicd");
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, refs);
    await expect(f.update()).rejects.toThrow("alias");
    expect(readdirSync(outside)).toEqual([]);
    rmSync(refs);
    mkdirSync(refs);
    writeFileSync(join(outside, "ref"), `${f.base}\n`);
    linkSync(join(outside, "ref"), join(refs, "fixture-run"));
    await expect(f.update({ ...f.intent, expectedRef: f.base })).rejects.toThrow("alias");
    expect(readFileSync(join(outside, "ref"), "utf8")).toBe(`${f.base}\n`);
    renameSync(f.user, join(f.root, "previous-user"));
    git(f.root, "clone", "--quiet", "--no-local", f.source, f.user);
    await expect(f.update()).rejects.toThrow("identity or configuration changed");
  });

  it("rejects changed pack bytes, mismatched formats and other retention owners before importing", async () => {
    const f = await fixture();
    const altered = Buffer.from(f.pack.bytes);
    altered[12] = altered[12]! ^ 1;
    await expect(
      f.transport.importPack(f.repository, f.pack.record, altered, guard, signal()),
    ).rejects.toThrow("frozen import identity");
    const other = await fixture("sha256");
    await expect(
      f.transport.importPack(other.repository, f.pack.record, f.pack.bytes, guard, signal()),
    ).rejects.toThrow("formats differ");
    const keep = join(f.user, `.git/objects/pack/pack-${f.pack.record.packHash}.keep`);
    writeFileSync(keep, "user retention\n");
    await expect(f.imported()).rejects.toThrow("retention owner");
    expect(readFileSync(keep, "utf8")).toBe("user retention\n");
    expect(() => bytes(f.user, f.revision)).toThrow();
  });

  it("recognizes full, absent and both partial physical ref outcomes without replaying effects", async () => {
    const f = await fixture();
    await f.imported();
    expect(await f.transport.observeRefs(f.intent)).toMatchObject({ outcome: "not_applied" });
    git(f.user, "update-ref", f.refs.branch, f.revision);
    expect(await f.transport.observeRefs(f.intent)).toMatchObject({
      outcome: "conflict",
      receiptRevision: null,
    });
    git(f.user, "update-ref", "-d", f.refs.branch, f.revision);
    git(f.user, "update-ref", f.refs.receipt, f.revision);
    expect(await f.transport.observeRefs(f.intent)).toMatchObject({
      outcome: "conflict",
      branchRevision: null,
    });
    git(f.user, "update-ref", f.refs.branch, f.revision);
    expect(await f.transport.observeRefs(f.intent)).toMatchObject({ outcome: "applied" });
    expect(git(f.user, "rev-parse", "HEAD")).toBe(f.base);
  });

  it("rejects ref-expression injection and mixed-format IDs before any Git effect", async () => {
    const f = await fixture();
    for (const input of [
      { ...f.intent, runId: "other\ncreate refs/heads/main" },
      { ...f.intent, revision: "HEAD" },
      { ...f.intent, expectedRef: "a".repeat(64) },
    ])
      await expect(f.transport.updateRefs(input, guard, signal())).rejects.toThrow();
    expect(() => git(f.user, "show-ref", "--verify", f.refs.branch)).toThrow();
  });
});
