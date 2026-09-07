import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KernelGit } from "../src/adapters/kernel-git.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-kernel-git-");
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "app"), "one\n");
  git("add", "app");
  git("commit", "--quiet", "-m", "one");
  const revision = git("rev-parse", "HEAD");
  const input = `start\noption no-deref\ncreate refs/heads/epicd/test ${revision}\noption no-deref\ncreate refs/epicd/receipts/test ${revision}\noption no-deref\nverify HEAD ${revision}\nprepare\n`;
  return { root, git, revision, input, kernel: new KernelGit(root) };
}

describe("prepared kernel Git transactions", () => {
  it("checks while both refs and HEAD are locked, then commits without touching the index", async () => {
    const f = fixture();
    const index = readFileSync(join(f.root, ".git/index"));
    const head = readFileSync(join(f.root, ".git/HEAD"));
    let checked = 0;
    const result = await f.kernel.text(["update-ref", "--stdin"], {
      input: f.input,
      beforeRefCommit: async (signal) => {
        signal.throwIfAborted();
        checked++;
        expect(existsSync(join(f.root, ".git/refs/heads/epicd/test.lock"))).toBe(true);
        expect(existsSync(join(f.root, ".git/refs/epicd/receipts/test.lock"))).toBe(true);
        expect(existsSync(join(f.root, ".git/HEAD.lock"))).toBe(true);
        expect(() => f.git("symbolic-ref", "HEAD", "refs/heads/other")).toThrow();
        expect(() => f.git("show-ref", "--verify", "refs/heads/epicd/test")).toThrow();
      },
    });
    expect(checked).toBe(1);
    expect(result).toBe("start: ok\nprepare: ok\ncommit: ok\n");
    expect(f.git("rev-parse", "refs/heads/epicd/test")).toBe(f.revision);
    expect(f.git("rev-parse", "refs/epicd/receipts/test")).toBe(f.revision);
    expect(readFileSync(join(f.root, ".git/index"))).toEqual(index);
    expect(readFileSync(join(f.root, ".git/HEAD"))).toEqual(head);
  });

  it("waits for failed guard I/O and leaves no ref update or locks", async () => {
    const f = fixture();
    let settled = false;
    await expect(
      f.kernel.text(["update-ref", "--stdin"], {
        input: f.input,
        beforeRefCommit: async () => {
          await f.kernel.text(["rev-parse", "HEAD"]);
          settled = true;
          throw new Error("authority changed");
        },
      }),
    ).rejects.toThrow("authority changed");
    expect(settled).toBe(true);
    expect(() => f.git("show-ref", "--verify", "refs/heads/epicd/test")).toThrow();
    expect(existsSync(join(f.root, ".git/HEAD.lock"))).toBe(false);
  });

  it("aborts an in-flight guard and settles it before reporting interruption", async () => {
    const f = fixture();
    const controller = new AbortController();
    let settled = false;
    await expect(
      f.kernel.text(["update-ref", "--stdin"], {
        input: f.input,
        signal: controller.signal,
        beforeRefCommit: async (signal) => {
          const stopped = new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                settled = true;
                resolve();
              },
              { once: true },
            ),
          );
          controller.abort();
          await stopped;
          signal.throwIfAborted();
        },
      }),
    ).rejects.toThrow("interrupted");
    expect(settled).toBe(true);
    expect(() => f.git("show-ref", "--verify", "refs/heads/epicd/test")).toThrow();
  });

  it("does not call the guard when an expected ref already exists", async () => {
    const f = fixture();
    f.git("update-ref", "refs/heads/epicd/test", f.revision);
    let checked = false;
    await expect(
      f.kernel.text(["update-ref", "--stdin"], {
        input: f.input,
        allowedExitCodes: [0, 128],
        beforeRefCommit: async () => {
          checked = true;
        },
      }),
    ).rejects.toThrow("not acknowledged");
    expect(checked).toBe(false);
    expect(() => f.git("show-ref", "--verify", "refs/epicd/receipts/test")).toThrow();
  });

  it("refuses an early commit or a non-transaction command before spawning Git", async () => {
    const f = fixture();
    for (const input of [f.input.replace("prepare\n", "commit\nprepare\n"), "prepare\n"])
      await expect(
        f.kernel.text(["update-ref", "--stdin"], {
          input,
          beforeRefCommit: async () => {},
        }),
      ).rejects.toThrow("single explicit");
    expect(() => f.git("show-ref", "--verify", "refs/heads/epicd/test")).toThrow();
  });
});
