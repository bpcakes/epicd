import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { StateStore } from "../src/adapters/store.js";
import {
  PublicationGit,
  RUN_OWNERSHIP_REF,
  PUBLICATION_LOCK_REF,
} from "../src/adapters/publication-git.js";
import { RepositoryAdmission } from "../src/kernel/repository-admission.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import type { ControllerAuthority } from "../src/domain/orchestration.js";

const roots: string[] = [],
  stores: StateStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync("/var/tmp/epicd-repository-admission-");
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", `--object-format=${format}`);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "app.txt"), "baseline\n");
  git("add", "app.txt");
  git("commit", "-qm", "baseline");
  const baseline = git("rev-parse", "HEAD");
  let count = 0;
  async function make(selected = repo) {
    const store = new StateStore(join(root, `state-${count++}.sqlite3`));
    stores.push(store);
    const state = store.create(
      { ...initialRun(randomUUID()), repoPath: selected, epicBaseRevision: baseline },
      RepositoryPolicySchema.parse({ schemaVersion: 1 }),
    );
    const repository = await new PublicationGit().bind(selected);
    const driver = new PublicationGit("run");
    const lease = store.acquireLease(state.runId);
    let authority: ControllerAuthority = {
      runId: state.runId,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    let admission = new RepositoryAdmission(store, authority, repository, driver);
    return {
      store,
      state,
      repository,
      driver,
      get authority() {
        return authority;
      },
      get admission() {
        return admission;
      },
      record: () => store.orchestration.repositoryAdmission.record(state.runId),
      restart() {
        store.releaseLease(state.runId, authority.ownerToken);
        const next = store.acquireLease(state.runId);
        authority = { runId: state.runId, ownerToken: next.ownerToken, leaseId: next.leaseId };
        admission = new RepositoryAdmission(store, authority, repository, driver);
      },
    };
  }
  return { root, repo, git, baseline, make };
}
type Owner = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["make"]>>;
function terminalControl(s: Owner) {
  // Transport/cleanup tests inject only this guard. Actual verified completion is covered in scope-closure.
  const current = s.store.orchestration.control(s.state.runId);
  return vi
    .spyOn(s.store.orchestration, "control")
    .mockReturnValue({ ...current, status: "complete" });
}

describe.runIf(process.platform === "linux")("physical repository run ownership", () => {
  it.each(["sha1", "sha256"] as const)(
    "excludes another state file on %s without changing user work or publication ownership",
    async (format) => {
      const f = await fixture(format),
        first = await f.make(),
        second = await f.make();
      writeFileSync(join(f.repo, "app.txt"), "user-owned change\n");
      const index = readFileSync(join(f.repo, ".git/index"));
      await first.admission.enter();
      expect(first.record()).toMatchObject({ phase: "owned", ioStopped: true });
      await expect(second.admission.enter()).rejects.toThrow("Another run owns");
      expect(second.record()?.phase).toBe("reserved");
      expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(first.record()!.revision);
      expect(f.git("for-each-ref", PUBLICATION_LOCK_REF)).toBe("");
      expect(f.git("rev-parse", "HEAD")).toBe(f.baseline);
      expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
      expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("user-owned change\n");
    },
  );

  it("admits only one of two concurrent controllers through linked checkouts", async () => {
    const f = await fixture(),
      linked = join(f.root, "linked");
    f.git("worktree", "add", "--quiet", "--detach", linked, "HEAD");
    const owners = [await f.make(), await f.make(linked)];
    const result = await Promise.allSettled(owners.map((owner) => owner.admission.enter()));
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const winner = owners[result.findIndex((item) => item.status === "fulfilled")]!;
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(winner.record()!.revision);
    expect(owners.every((owner) => owner.record()?.ioStopped)).toBe(true);
  });

  it("retains ownership during pause and lets only the same state/run resume", async () => {
    const f = await fixture(),
      first = await f.make(),
      second = await f.make();
    await first.admission.enter();
    const revision = first.record()!.revision;
    first.store.orchestration.changeStatus(first.authority, "paused");
    await expect(first.admission.release()).rejects.toThrow("retain repository ownership");
    first.restart();
    const acquire = vi.spyOn(first.driver, "acquireLock");
    await first.admission.enter();
    expect(acquire).not.toHaveBeenCalled();
    await expect(second.admission.enter()).rejects.toThrow("Another run owns");
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(revision);
  });

  it("settles a lost acquisition acknowledgement by observation without another write", async () => {
    const f = await fixture(),
      first = await f.make();
    const fault = vi
      .spyOn(first.store.orchestration.repositoryAdmission, "settle")
      .mockImplementation(() => {
        throw new Error("Lost acknowledgement");
      });
    await expect(first.admission.enter()).rejects.toThrow("Lost acknowledgement");
    fault.mockRestore();
    expect(first.record()).toMatchObject({ phase: "acquiring", ioStopped: true });
    first.restart();
    const acquire = vi.spyOn(first.driver, "acquireLock");
    await first.admission.enter();
    expect(acquire).not.toHaveBeenCalled();
    expect(first.record()?.phase).toBe("owned");
  });

  it("does not infer acquisition stop from a matching ref after controller replacement", async () => {
    const f = await fixture(),
      first = await f.make();
    const fault = vi
      .spyOn(first.store.orchestration.repositoryAdmission, "stopped")
      .mockImplementation(() => {
        throw new Error("Lost stop proof");
      });
    await expect(first.admission.enter()).rejects.toThrow("Lost stop proof");
    fault.mockRestore();
    first.restart();
    const acquire = vi.spyOn(first.driver, "acquireLock");
    await expect(first.admission.enter()).rejects.toThrow("no independent stop proof");
    expect(acquire).not.toHaveBeenCalled();
    expect(first.record()).toMatchObject({ phase: "acquiring", ioStopped: false });
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(first.record()!.revision);
  });

  it.each(["reserved", "io_started"])(
    "rolls back a failed %s audit before any ownership write",
    async (event) => {
      const f = await fixture(),
        first = await f.make();
      const original = first.store.orchestration.appendObservation.bind(first.store.orchestration);
      vi.spyOn(first.store.orchestration, "appendObservation").mockImplementation(
        (authority, input) => {
          if (input.kind === `repository_admission.${event}`) throw new Error("Audit unavailable");
          return original(authority, input);
        },
      );
      const acquire = vi.spyOn(first.driver, "acquireLock");
      await expect(first.admission.enter()).rejects.toThrow("Audit unavailable");
      expect(acquire).not.toHaveBeenCalled();
      expect(f.git("for-each-ref", RUN_OWNERSHIP_REF)).toBe("");
      expect(first.record()?.phase ?? null).toBe(event === "reserved" ? null : "reserved");
    },
  );

  it("refuses a copied state file even when it contains the same run and ownership bytes", async () => {
    const f = await fixture(),
      first = await f.make();
    await first.admission.enter();
    first.store.releaseLease(first.state.runId, first.authority.ownerToken);
    // Close to checkpoint SQLite before making the deliberate copy; never copy a live WAL incompletely.
    first.store.close();
    stores.splice(stores.indexOf(first.store), 1);
    const path = join(f.root, "copied.sqlite3");
    copyFileSync(first.store.path, path);
    const copied = new StateStore(path);
    stores.push(copied);
    const lease = copied.acquireLease(first.state.runId);
    const authority = {
      runId: first.state.runId,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    await expect(
      new RepositoryAdmission(copied, authority, first.repository).enter(),
    ).rejects.toThrow("another state file");
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(
      copied.orchestration.repositoryAdmission.record(first.state.runId)!.revision,
    );
  });

  it("releases only after terminal control and permits a later run without reusing ownership", async () => {
    const f = await fixture(),
      first = await f.make(),
      second = await f.make();
    await first.admission.enter();
    await expect(first.admission.release()).rejects.toThrow("retain repository ownership");
    const terminal = terminalControl(first);
    await first.admission.release();
    terminal.mockRestore();
    expect(first.record()).toMatchObject({ phase: "released", ioStopped: true });
    await second.admission.enter();
    expect(second.record()!.revision).not.toBe(first.record()!.revision);
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(second.record()!.revision);
  });

  it("cold-settles a lost release acknowledgement without another ref deletion", async () => {
    const f = await fixture(),
      first = await f.make();
    await first.admission.enter();
    terminalControl(first);
    const fault = vi
      .spyOn(first.store.orchestration.repositoryAdmission, "settle")
      .mockImplementation(() => {
        throw new Error("Lost release acknowledgement");
      });
    await expect(first.admission.release()).rejects.toThrow("Lost release acknowledgement");
    fault.mockRestore();
    first.restart();
    const release = vi.spyOn(first.driver, "releaseLock");
    await first.admission.enter();
    expect(first.record()?.phase).toBe("released");
    expect(release).not.toHaveBeenCalled();
    expect(f.git("for-each-ref", RUN_OWNERSHIP_REF)).toBe("");
  });

  it("preserves a replaced ownership ref and rejects further admission and cleanup", async () => {
    const f = await fixture(),
      first = await f.make();
    await first.admission.enter();
    const foreign = execFileSync("git", ["-C", f.repo, "hash-object", "-w", "--stdin"], {
      input: "external owner",
      encoding: "utf8",
    }).trim();
    f.git("update-ref", RUN_OWNERSHIP_REF, foreign);
    await expect(first.admission.assertOwned()).rejects.toThrow("ownership changed");
    expect(first.record()?.phase).toBe("conflict");
    terminalControl(first);
    await expect(first.admission.release()).rejects.toThrow("Unsettled");
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(foreign);
  });

  it("preserves unknown release I/O across restart even when the ref is already absent", async () => {
    const f = await fixture(),
      first = await f.make();
    await first.admission.enter();
    terminalControl(first);
    const fault = vi
      .spyOn(first.store.orchestration.repositoryAdmission, "stopped")
      .mockImplementation(() => {
        throw new Error("Release stop not recorded");
      });
    await expect(first.admission.release()).rejects.toThrow("Release stop not recorded");
    fault.mockRestore();
    first.restart();
    const release = vi.spyOn(first.driver, "releaseLock");
    await expect(first.admission.enter()).rejects.toThrow("cannot infer old I/O stop");
    expect(first.record()).toMatchObject({ phase: "releasing", ioStopped: false });
    expect(release).not.toHaveBeenCalled();
    expect(f.git("for-each-ref", RUN_OWNERSHIP_REF)).toBe("");
  });

  it("rejects altered persisted ownership identity and preserves its raw record during quarantine", async () => {
    const f = await fixture(),
      first = await f.make();
    await first.admission.enter();
    const retained = first.record()!,
      db = new Database(first.store.path);
    try {
      const changed = { ...retained, stateFile: { ...retained.stateFile, inode: "999999" } };
      db.prepare("UPDATE repository_admissions SET record_json = ? WHERE run_id = ?").run(
        JSON.stringify(changed),
        first.state.runId,
      );
      expect(() => first.record()).toThrow("exact run, state file");
      await expect(first.admission.enter()).rejects.toThrow("exact run, state file");
      first.store.releaseLease(first.state.runId, first.authority.ownerToken);
      db.prepare(
        "UPDATE runs SET state_json = json_set(state_json, '$.stateSchemaVersion', 1) WHERE run_id = ?",
      ).run(first.state.runId);
      first.store.quarantineInvalidRun(first.state.runId);
      const raw = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id = ? AND source_table = 'repository_admissions'",
        )
        .get(first.state.runId) as { row_json: string };
      expect(JSON.parse(JSON.parse(raw.row_json).record_json)).toEqual(changed);
      expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(retained.revision);
    } finally {
      db.close();
    }
  });

  it("does not follow a symbolic ownership ref into a user branch", async () => {
    const f = await fixture(),
      first = await f.make();
    f.git("symbolic-ref", RUN_OWNERSHIP_REF, f.git("symbolic-ref", "HEAD"));
    await expect(first.admission.enter()).rejects.toThrow("symbolic");
    expect(f.git("rev-parse", "HEAD")).toBe(f.baseline);
    expect(f.git("symbolic-ref", RUN_OWNERSHIP_REF)).toBe(f.git("symbolic-ref", "HEAD"));
    expect(first.record()?.phase).toBe("reserved");
  });

  it("fences the existing journal when the state path is replaced while its connection remains open", async () => {
    const f = await fixture(),
      first = await f.make();
    await first.admission.enter();
    const revision = first.record()!.revision;
    const retained = join(f.root, "retained-original.sqlite3");
    renameSync(first.store.path, retained);
    copyFileSync(retained, first.store.path);
    const replacement = readFileSync(first.store.path);
    expect(() => first.store.orchestration.assertAuthority(first.authority)).toThrow(
      "State file identity changed",
    );
    expect(() => first.store.acquireLease(first.state.runId)).toThrow(
      "State file identity changed",
    );
    await expect(first.admission.assertOwned()).rejects.toThrow("State file identity changed");
    expect(readFileSync(first.store.path)).toEqual(replacement);
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(revision);
  });
});
