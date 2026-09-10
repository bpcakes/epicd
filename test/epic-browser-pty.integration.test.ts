import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function fixture(count = 1, oversizedIndex?: number) {
  const root = mkdtempSync("/var/tmp/epicd-browser-pty-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo with spaces");
  mkdirSync(repo);
  execFileSync("/usr/bin/git", ["init", "-q", repo]);
  execFileSync("/usr/bin/git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-qm",
    "Fixture",
  ]);
  mkdirSync(join(repo, ".beads"));
  writeFileSync(join(repo, ".beads/beads.db"), "fixture transport only\n");
  writeFileSync(
    join(repo, ".beads/browser.json"),
    JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        id: index ? `epic-${String(index).padStart(4, "0")}` : "demo",
        title: index ? `Browser extra ${index}` : "Browser fixture epic",
        issue_type: "epic",
        status: "open",
        priority: 1,
        ...(index === oversizedIndex ? { description: "x".repeat(5 * 1024 * 1024) } : {}),
      })),
    ),
  );
  const tracker = join(root, "br");
  writeFileSync(
    tracker,
    `#!/usr/bin/python3
import json, sys
from pathlib import Path
args = sys.argv[1:]
if Path('/workspace/.beads/offline').exists(): sys.exit('temporary tracker fault')
with open('/workspace/.beads/browser.json') as data: epics = json.load(data)
if args[0] in ('list', 'search'):
    if args[0] == 'search': epics = [x for x in epics if args[-1].lower() in (x['id']+' '+x['title']).lower()]
    offset, limit = int(args[args.index('--offset')+1]), int(args[args.index('--limit')+1])
    if '--fields' in args:
        print('id,priority,status,issue_type')
        for x in epics[offset:offset+limit]: print(','.join(str(x[k]) for k in ['id','priority','status','issue_type']))
        sys.exit(0)
    epics = {'issues':epics[offset:offset+limit],'offset':offset,'limit':limit,'has_more':offset+limit < len(epics)}
elif args[0] == 'show': epics = [x for x in epics if x['id'] in args[1:args.index('--db')]]
else: sys.exit('Unexpected tracker mutation')
print(json.dumps(epics))
`,
    { mode: 0o700 },
  );
  const path = join(root, "state.db"),
    store = new StateStore(path);
  cleanup.push(() => store.close());
  const executable = join(root, "epicd");
  symlinkSync(resolve("dist/cli.js"), executable);
  return { repo, tracker, path, store, executable };
}
async function terminal(f: ReturnType<typeof fixture>) {
  const args = [
    process.execPath,
    f.executable,
    "--repo",
    f.repo,
    "--state",
    f.path,
    "--tracker-path",
    f.tracker,
  ];
  const command = `stty rows 48 cols 140; exec ${args.map(quote).join(" ")}`;
  const child = spawn("/usr/bin/script", ["-q", "-e", "-E", "never", "-c", command, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: resolve(f.repo, "../operator-home"),
      CODEX_HOME: resolve(f.repo, "../operator-home/.codex"),
      XDG_CONFIG_HOME: resolve(f.repo, "../operator-home/.config"),
      TERM: "xterm",
      FORCE_COLOR: "0",
      CI: "1",
    },
  });
  const closed = once(child, "close");
  void closed.catch(() => {});
  child.stdin.on("error", () => {});
  let output = "";
  const record = (bytes: Buffer) => {
    output = (output + String(bytes)).slice(-200_000);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  return {
    see: (text: string) => expect.poll(() => output, { timeout: 8000 }).toContain(text),
    send: (text: string) => child.stdin.write(text),
    forget: () => {
      output = "";
    },
    closed,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    },
  };
}

describe.runIf(process.platform === "linux")("compiled epic browser in a real terminal", () => {
  it("shows an oversized epic as unavailable while keeping other choices accessible", async () => {
    const f = fixture(2, 0),
      tty = await terminal(f);
    try {
      await tty.see("Browser extra 1");
      await tty.see("Epic demo (title unavailable)");
      await tty.see("❯ P1 Epic demo");
      tty.send("\r");
      await tty.see("too large to load");
      tty.send("q");
      await expect(tty.closed).resolves.toEqual([0, null]);
      expect(f.store.list()).toEqual([]);
    } finally {
      await tty.stop();
    }
  });

  it("retains the previous page during a tracker fault and reloads before continuing", async () => {
    const f = fixture(60),
      tty = await terminal(f);
    try {
      await tty.see("Page 1");
      writeFileSync(join(f.repo, ".beads/offline"), "offline");
      tty.send("]");
      await tty.see("Could not load epics");
      await tty.see("Showing the previous page");
      rmSync(join(f.repo, ".beads/offline"));
      tty.forget();
      tty.send("r");
      await tty.see("Page 1");
      tty.send("]");
      await tty.see("Page 2");
      tty.send("q");
      await expect(tty.closed).resolves.toEqual([0, null]);
      expect(f.store.list()).toEqual([]);
    } finally {
      await tty.stop();
    }
  });

  it("pages a large tracker and searches across unloaded pages without starting work", async () => {
    const f = fixture(1105),
      tty = await terminal(f);
    try {
      await tty.see("Page 1");
      tty.send("]");
      await tty.see("Page 2");
      await tty.see("Browser extra 50");
      tty.send("/");
      await tty.see("Search: ▏");
      tty.send("epic-1104");
      await tty.see("epic-1104▏");
      tty.send("\r");
      await tty.see("Browser extra 1104");
      tty.send("q");
      await expect(tty.closed).resolves.toEqual([0, null]);
      expect(f.store.list()).toEqual([]);
    } finally {
      await tty.stop();
    }
  });

  it("opens account configuration from the browser and returns without starting work", async () => {
    const f = fixture(),
      tty = await terminal(f);
    try {
      await tty.see("Browser fixture epic");
      expect(f.store.list()).toEqual([]);
      tty.send("\r");
      await tty.see("Accounts — demo");
      await tty.see("s Review choices");
      expect(f.store.list()).toEqual([]);
      tty.forget();
      tty.send("b");
      await tty.see("choose an epic");
      tty.send("q");
      await expect(tty.closed).resolves.toEqual([0, null]);
      expect(f.store.list()).toEqual([]);
    } finally {
      await tty.stop();
    }
  });

  it("exits the browser on Ctrl+C from account setup without starting a run", async () => {
    const f = fixture(),
      tty = await terminal(f);
    try {
      await tty.see("Browser fixture epic");
      tty.send("\r");
      await tty.see("Accounts — demo");
      await tty.see("Runtime: sdk");
      tty.send("\u0003");
      await expect(tty.closed).resolves.toEqual([0, null]);
      expect(f.store.list()).toEqual([]);
    } finally {
      await tty.stop();
    }
  });
  it("opens the confirmed live run's operator console without changing its lease or control", async () => {
    const f = fixture();
    const state = f.store.create(
      { ...initialRun(), repoPath: f.repo },
      RepositoryPolicySchema.parse({ schemaVersion: 1 }),
    );
    const lease = f.store.acquireLease(state.runId),
      before = f.store.orchestration.control(state.runId);
    const tty = await terminal(f);
    try {
      await tty.see("Browser fixture epic");
      tty.send("\r");
      await tty.see("OPEN OPERATOR CONSOLE");
      tty.send("\r");
      await tty.see("Operator console");
      tty.send("q");
      await expect(tty.closed).resolves.toEqual([0, null]);
      expect(f.store.controllerLease(state.runId)?.leaseId).toBe(lease.leaseId);
      expect(f.store.orchestration.control(state.runId)).toEqual(before);
    } finally {
      await tty.stop();
    }
  });
});
