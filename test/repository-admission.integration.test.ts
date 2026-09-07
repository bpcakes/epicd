import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
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
import { runRepositoryIO } from "../dist/adapters/repository-io.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import type { ControllerAuthority } from "../src/domain/orchestration.js";
import {
  prepareRepositoryIO,
  readRepositoryIOStop,
  recoverRepositoryIO,
} from "../src/adapters/repository-io.js";

const roots: string[] = [],
  stores: StateStore[] = [];
const processCleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of processCleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function descendants(pid: number): Promise<{ pid: number; start: string }[]> {
  const raw = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
  const result: { pid: number; start: string }[] = [];
  for (const child of raw ? raw.split(/\s+/).map(Number) : []) {
    const stat = await readFile(`/proc/${child}/stat`, "utf8");
    result.push({ pid: child, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]! });
    result.push(...(await descendants(child)));
  }
  return result;
}
async function stopped(identity: { pid: number; start: string }) {
  try {
    const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[19] !== identity.start;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
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
    let admission = new RepositoryAdmission(store, authority, repository, driver, runRepositoryIO);
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
        admission = new RepositoryAdmission(store, authority, repository, driver, runRepositoryIO);
      },
    };
  }
  return { root, repo, git, baseline, make };
}
type Owner = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["make"]>>;
function terminalControl(s: Owner) {
  // Transport fixture only; real verified completion is covered in scope-closure.
  // Persist it so the independently loaded worker sees the same control state.
  const db = new Database(s.store.path);
  try {
    db.prepare("UPDATE orchestration_runs SET status = 'complete' WHERE run_id = ?").run(
      s.state.runId,
    );
  } finally {
    db.close();
  }
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
    const ioId = first.record()!.ioId;
    await first.admission.enter();
    expect(first.record()!.ioId).toBe(ioId);
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
    const ioId = first.record()!.ioId;
    await first.admission.enter();
    expect(first.record()!.ioId).toBe(ioId);
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
    unlinkSync(join(first.record()!.ioDirectory!.path, "stopped.json"));
    first.restart();
    const ioId = first.record()!.ioId;
    await expect(first.admission.enter()).rejects.toThrow("no independent stop proof");
    expect(first.record()!.ioId).toBe(ioId);
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
      await expect(first.admission.enter()).rejects.toThrow("Audit unavailable");
      expect(first.record()?.ioId ?? null).toBeNull();
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
    terminalControl(first);
    await first.admission.release();
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
    const ioId = first.record()!.ioId;
    await first.admission.enter();
    expect(first.record()?.phase).toBe("released");
    expect(first.record()!.ioId).toBe(ioId);
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
    unlinkSync(join(first.record()!.ioDirectory!.path, "stopped.json"));
    first.restart();
    const ioId = first.record()!.ioId;
    await expect(first.admission.enter()).rejects.toThrow("cannot infer old I/O stop");
    expect(first.record()).toMatchObject({ phase: "releasing", ioStopped: false });
    expect(first.record()!.ioId).toBe(ioId);
    expect(f.git("for-each-ref", RUN_OWNERSHIP_REF)).toBe("");
  });

  it.each(["acquiring", "releasing"] as const)(
    "recovers the retained %s stop receipt across lease replacement",
    async (phase) => {
      const f = await fixture(),
        first = await f.make();
      if (phase === "releasing") {
        await first.admission.enter();
        terminalControl(first);
      }
      const fault = vi
        .spyOn(first.store.orchestration.repositoryAdmission, "stopped")
        .mockImplementation(() => {
          throw new Error("Controller lost receipt acknowledgement");
        });
      await expect(
        phase === "acquiring" ? first.admission.enter() : first.admission.release(),
      ).rejects.toThrow("lost receipt acknowledgement");
      fault.mockRestore();
      const original = first.record()!;
      expect(original).toMatchObject({ phase, ioStopped: false, ioReceipt: null });
      const receipt = await readRepositoryIOStop(original);
      expect(receipt).toMatchObject({
        ioId: original.ioId,
        operation: phase,
        kind: "stopped",
        code: 0,
      });
      first.restart();
      await first.admission.enter();
      expect(first.record()).toMatchObject({
        phase: phase === "acquiring" ? "owned" : "released",
        ioStopped: true,
        ioId: original.ioId,
        ioReceipt: receipt,
      });
      expect(first.record()!.controllerLeaseId).not.toBe(first.authority.leaseId);
    },
  );

  it("rolls back the stop audit after its write and later recovers the same physical receipt", async () => {
    const f = await fixture(),
      first = await f.make();
    const original = first.store.orchestration.appendObservation.bind(first.store.orchestration);
    let sawWrite = false;
    const fault = vi
      .spyOn(first.store.orchestration, "appendObservation")
      .mockImplementation((authority, input) => {
        if (input.kind === "repository_admission.io_stopped") {
          sawWrite = first.record()?.ioStopped === true && first.record()?.ioReceipt?.code === 0;
          throw new Error("Stop audit unavailable");
        }
        return original(authority, input);
      });
    await expect(first.admission.enter()).rejects.toThrow("Stop audit unavailable");
    fault.mockRestore();
    expect(sawWrite).toBe(true);
    const intent = first.record()!;
    expect(intent).toMatchObject({ ioStopped: false, ioReceipt: null });
    first.restart();
    await first.admission.enter();
    expect(first.record()).toMatchObject({ phase: "owned", ioId: intent.ioId, ioStopped: true });
  });

  it("fences a stale worker before it can mutate Git and retains a separately proven stop", async () => {
    const f = await fixture(),
      first = await f.make();
    const hold = vi
      .spyOn(first.store.orchestration.repositoryAdmission, "begin")
      .mockImplementation(() => {
        throw new Error("hold");
      });
    await expect(first.admission.enter()).rejects.toThrow("hold");
    hold.mockRestore();
    const oldAuthority = first.authority;
    const intent = first.store.orchestration.repositoryAdmission.begin(
      first.authority,
      "acquiring",
      await prepareRepositoryIO(first.record()!),
    );
    first.restart();
    const receipt = await runRepositoryIO(intent, oldAuthority);
    expect(receipt).toMatchObject({ kind: "stopped", code: 1 });
    expect(f.git("for-each-ref", RUN_OWNERSHIP_REF)).toBe("");
    expect(() =>
      first.store.orchestration.repositoryAdmission.stopped(oldAuthority, receipt),
    ).toThrow();
    expect(first.record()?.ioStopped).toBe(false);
    first.store.orchestration.repositoryAdmission.stopped(first.authority, receipt);
    expect(first.record()?.ioStopped).toBe(true);
  });

  it("seals an unused dispatch and never overwrites that generation's receipt", async () => {
    const f = await fixture(),
      first = await f.make();
    const fault = vi
      .spyOn(first.store.orchestration.repositoryAdmission, "begin")
      .mockImplementation(() => {
        throw new Error("hold before admission");
      });
    await expect(first.admission.enter()).rejects.toThrow("hold before admission");
    fault.mockRestore();
    const directory = await prepareRepositoryIO(first.record()!);
    const intent = first.store.orchestration.repositoryAdmission.begin(
      first.authority,
      "acquiring",
      directory,
    );
    first.restart();
    const receipt = await recoverRepositoryIO(intent);
    expect(receipt).toMatchObject({ kind: "not_started", ioId: intent.ioId });
    expect(await recoverRepositoryIO(intent)).toEqual(receipt);
    expect(
      await runRepositoryIO(intent, {
        runId: intent.runId,
        leaseId: intent.controllerLeaseId,
        ownerToken: "obsolete-authority",
      }),
    ).toEqual(receipt);
    expect(f.git("for-each-ref", RUN_OWNERSHIP_REF)).toBe("");
    first.store.orchestration.repositoryAdmission.stopped(first.authority, receipt!);
    expect(first.record()).toMatchObject({ ioStopped: true, phase: "acquiring" });
  });

  it.each(["acquiring", "releasing"] as const)(
    "recovers %s after the actual controller dies before recording stop",
    async (phase) => {
      const f = await fixture(),
        first = await f.make();
      if (phase === "releasing") {
        await first.admission.enter();
        terminalControl(first);
      }
      writeFileSync(join(f.repo, "app.txt"), "concurrent user work\n");
      const index = readFileSync(join(f.repo, ".git/index"));
      first.store.releaseLease(first.state.runId, first.authority.ownerToken);
      const script = `
      import { StateStore } from ${JSON.stringify(new URL("../dist/adapters/store.js", import.meta.url).href)};
      import { PublicationGit } from ${JSON.stringify(new URL("../dist/adapters/publication-git.js", import.meta.url).href)};
      import { RepositoryAdmission } from ${JSON.stringify(new URL("../dist/kernel/repository-admission.js", import.meta.url).href)};
      const store = new StateStore(${JSON.stringify(first.store.path)}), runId = ${JSON.stringify(first.state.runId)};
      const lease = store.acquireLease(runId);
      const authority = { runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
      store.orchestration.repositoryAdmission.stopped = () => process.kill(process.pid, 'SIGKILL');
      await new RepositoryAdmission(store, authority, await new PublicationGit().bind(${JSON.stringify(f.repo)})).enter();
      process.exitCode = 99;
    `;
      const caller = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: "pipe",
      });
      const closed = once(caller, "close");
      processCleanups.push(async () => {
        caller.kill("SIGTERM");
        await closed;
      });
      caller.stdout.resume();
      let errors = "";
      caller.stderr.on("data", (data: Buffer) => {
        errors += data.toString();
      });
      expect(await closed, errors).toEqual([null, "SIGKILL"]);
      const original = first.record()!;
      expect(original).toMatchObject({ phase, ioStopped: false });
      expect(await readRepositoryIOStop(original)).toMatchObject({ code: 0, kind: "stopped" });
      first.restart();
      await first.admission.enter();
      expect(first.record()).toMatchObject({
        phase: phase === "acquiring" ? "owned" : "released",
        ioStopped: true,
        ioId: original.ioId,
      });
      expect(f.git("rev-parse", "HEAD")).toBe(f.baseline);
      expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
      expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("concurrent user work\n");
    },
  );

  it.each(["caller", "monitor"] as const)(
    "keeps independent stop proof honest when the %s dies with resistant descendants",
    async (killed) => {
      const f = await fixture(),
        first = await f.make();
      const hold = vi
        .spyOn(first.store.orchestration.repositoryAdmission, "begin")
        .mockImplementation(() => {
          throw new Error("hold");
        });
      await expect(first.admission.enter()).rejects.toThrow("hold");
      hold.mockRestore();
      const intent = first.store.orchestration.repositoryAdmission.begin(
        first.authority,
        "acquiring",
        await prepareRepositoryIO(first.record()!),
      );
      const heartbeat = join(f.root, "heartbeat"),
        worker = join(f.root, "worker.cjs");
      const descendant = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10);`;
      writeFileSync(
        worker,
        `
      new (require('node:net').Socket)({ fd: 3, readable: true, writable: false }).resume();
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, stdio: 'inherit' });
      process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
    `,
      );
      const supervisor = `import { superviseRepositoryIO } from ${JSON.stringify(new URL("../dist/adapters/repository-io.js", import.meta.url).href)}; await superviseRepositoryIO(${JSON.stringify(worker)});`;
      const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(supervisor)}], { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
      child.stdio[3].on('error', () => {});
      child.stdin.end(${JSON.stringify(JSON.stringify({ record: intent, authority: first.authority }))});
      console.log(child.pid);
      child.once('close', () => process.exit(0));
    `;
      const caller = spawn(process.execPath, ["-e", script], { stdio: "pipe" });
      const closed = once(caller, "close");
      let owned: { pid: number; start: string }[] = [];
      processCleanups.push(async () => {
        caller.kill("SIGTERM");
        await closed;
        await expect
          .poll(async () => (await Promise.all(owned.map(stopped))).every(Boolean), {
            timeout: 5000,
          })
          .toBe(true);
      });
      caller.stderr.resume();
      const [output] = await once(caller.stdout, "data");
      const supervisorPid = Number(String(output).trim());
      await expect
        .poll(() => existsSync(heartbeat) && readFileSync(heartbeat).length > 2, { timeout: 5000 })
        .toBe(true);
      owned = await descendants(caller.pid!);
      expect(owned.length).toBeGreaterThanOrEqual(5);
      expect(await Promise.all(owned.map(stopped))).not.toContain(true);
      if (killed === "caller") caller.kill("SIGKILL");
      else {
        const monitorPid = Number(
          (await readFile(`/proc/${supervisorPid}/task/${supervisorPid}/children`, "utf8")).trim(),
        );
        expect(owned.some((item) => item.pid === monitorPid)).toBe(true);
        process.kill(monitorPid, "SIGKILL");
      }
      await closed;
      if (killed === "caller") {
        await expect.poll(() => readRepositoryIOStop(intent), { timeout: 5000 }).not.toBeNull();
        expect(await readRepositoryIOStop(intent)).toMatchObject({
          kind: "stopped",
          interrupted: true,
        });
        first.restart();
        first.store.orchestration.repositoryAdmission.stopped(
          first.authority,
          (await readRepositoryIOStop(intent))!,
        );
        expect(first.record()?.ioStopped).toBe(true);
      } else {
        expect(await readRepositoryIOStop(intent)).toBeNull();
        expect(await recoverRepositoryIO(intent)).toBeNull();
        first.restart();
        await expect(first.admission.enter()).rejects.toThrow("no independent stop proof");
        expect(first.record()?.ioStopped).toBe(false);
      }
      await expect
        .poll(async () => (await Promise.all(owned.map(stopped))).every(Boolean), { timeout: 5000 })
        .toBe(true);
      expect(f.git("for-each-ref", RUN_OWNERSHIP_REF)).toBe("");
    },
  );

  it.each(["corrupt", "generation", "directory"])(
    "preserves %s stop evidence without adopting a matching ref",
    async (variant) => {
      const f = await fixture(),
        first = await f.make();
      const fault = vi
        .spyOn(first.store.orchestration.repositoryAdmission, "stopped")
        .mockImplementation(() => {
          throw new Error("lost ack");
        });
      await expect(first.admission.enter()).rejects.toThrow("lost ack");
      fault.mockRestore();
      const intent = first.record()!,
        directory = intent.ioDirectory!.path;
      if (variant === "directory") {
        renameSync(directory, `${directory}-retained`);
        mkdirSync(directory, { mode: 0o700 });
      } else {
        const receipt = JSON.parse(readFileSync(join(directory, "stopped.json"), "utf8"));
        writeFileSync(
          join(directory, "stopped.json"),
          variant === "corrupt" ? "{" : JSON.stringify({ ...receipt, ioId: randomUUID() }),
        );
      }
      first.restart();
      await expect(first.admission.enter()).rejects.toThrow();
      expect(first.record()).toEqual(intent);
      expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(intent.revision);
    },
  );

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
