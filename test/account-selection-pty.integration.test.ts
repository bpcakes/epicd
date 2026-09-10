import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { accountBinding } from "../src/domain/accounts.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp("/var/tmp/epicd-account-pty-");
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".epicd"), { recursive: true });
  await mkdir(join(repo, ".beads"));
  await writeFile(join(repo, ".epicd/policy.json"), '{"schemaVersion":1}');
  await writeFile(join(repo, ".beads/beads.db"), "fixture only");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
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
  await writeFile(
    join(root, "codex"),
    '#!/bin/sh\ntest "$1" = --version || exit 91\nprintf "codex-cli 0.153.4\\n"\n',
    { mode: 0o700 },
  );
  const epic = {
    id: "demo",
    title: "Select accounts",
    issue_type: "epic",
    status: "open",
    dependencies: [],
    dependents: [],
  };
  await writeFile(
    join(root, "br"),
    `#!/usr/bin/python3
import json,sys
if sys.argv[1] == 'show': print(${JSON.stringify(JSON.stringify([epic]))})
elif sys.argv[1] == 'ready': print('[]')
else: sys.exit('Unexpected mutation')
`,
    { mode: 0o700 },
  );
  const homes = ["main", "build", "review"].map((name) => join(root, `.codex-${name}`));
  for (const [index, path] of homes.entries()) {
    await mkdir(path, { mode: 0o700 });
    await writeFile(
      join(path, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: "2026-09-01T00:00:00Z",
        tokens: {
          account_id: `account-${index}`,
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          id_token: `e30.${Buffer.from(JSON.stringify({ sub: `member-${index}` })).toString("base64url")}.c2ln`,
        },
      }),
      { mode: 0o600 },
    );
  }
  return { root, homes };
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function terminal(root: string, columns = 140, failStart = false) {
  const command = `stty rows 45 cols ${columns}; exec ${[process.execPath, resolve("test/fixtures/account-selection-caller.mjs"), root].map(quote).join(" ")}`;
  const child = spawn("/usr/bin/script", ["-q", "-e", "-E", "never", "-c", command, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: root,
      CODEX_HOME: join(root, ".codex-main"),
      XDG_CONFIG_HOME: join(root, ".config"),
      TERM: "xterm",
      FORCE_COLOR: "0",
      CI: "1",
      EPICD_FIXTURE_FAIL_START: failStart ? "1" : "0",
    },
  });
  const closed = once(child, "close");
  void closed.catch(() => {});
  child.stdin.on("error", () => {});
  let output = "";
  const record = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-200_000);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  return {
    send: (text: string) => child.stdin.write(text),
    forget: () => {
      output = "";
    },
    see: (text: string) => expect.poll(() => output, { timeout: 8000 }).toContain(text),
    closed,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    },
  };
}
describe.runIf(process.platform === "linux")("account selection in a real terminal", () => {
  it("selects three homes, saves defaults, and persists exactly the confirmed selections", async () => {
    const f = await fixture(),
      tty = await terminal(f.root);
    try {
      await tty.see("Accounts — demo");
      for (const [index, name] of ["main", "build", "review"].entries()) {
        tty.forget();
        tty.send("j");
        await tty.see(`› ${["orchestrator", "implementation", "review"][index]}`);
        tty.send("\r");
        await tty.see(`Choose home for ${["orchestrator", "implementation", "review"][index]}`);
        tty.send("e");
        await tty.see(`Edit ${["orchestrator", "implementation", "review"][index]} source home`);
        tty.send(`~/.codex-${name}`);
        await tty.see(`~/.codex-${name}▏`);
        tty.forget();
        tty.send("\r");
        await tty.see("s Review choices");
      }
      tty.send("d");
      await tty.see("Defaults saved");
      const preferences = JSON.parse(
        await readFile(join(f.root, ".config/epicd/accounts.json"), "utf8"),
      );
      expect([
        preferences.classes.orchestrator.codexHome,
        preferences.classes.implementation.codexHome,
        preferences.classes.review.codexHome,
      ]).toEqual(["~/.codex-main", "~/.codex-build", "~/.codex-review"]);
      const before = new StateStore(join(f.root, "state.sqlite3"));
      try {
        expect(before.list()).toEqual([]);
      } finally {
        before.close();
      }
      tty.forget();
      tty.send("s");
      await tty.see("START demo WITH THESE ACCOUNTS");
      await tty.see("Enter Start run");
      tty.send("\r");
      await tty.see("CREATED");
      await expect(tty.closed).resolves.toEqual([0, null]);
      await tty.see("RAW false");
      const store = new StateStore(join(f.root, "state.sqlite3"));
      try {
        expect(store.list()).toHaveLength(1);
        const state = store.list()[0]!;
        expect(state.stateSchemaVersion).toBe(4);
        const snapshot = state.runtimeConfiguration!.accounts!;
        expect([
          accountBinding(snapshot, "orchestrator", "coordination")?.source.codexHome,
          accountBinding(snapshot, "implementation", "implementation")?.source.codexHome,
          accountBinding(snapshot, "review", "review")?.source.codexHome,
        ]).toEqual(f.homes);
        expect(JSON.stringify(state)).not.toMatch(/synthetic-access|synthetic-refresh|id_token/);
      } finally {
        store.close();
      }
    } finally {
      await tty.stop();
    }
  });
  it("retains account edits after a failed start and creates only the successful retry", async () => {
    const f = await fixture();
    const tty = await terminal(f.root, 140, true);
    try {
      await tty.see("Accounts — demo");
      tty.send("j");
      await tty.see("› orchestrator");
      tty.send("j");
      await tty.see("› implementation");
      tty.send("j");
      await tty.see("› review");
      tty.send("\r");
      await tty.see("Choose home for review");
      tty.send("e");
      await tty.see("Edit review source home");
      tty.send("~/.codex-review");
      await tty.see("~/.codex-review▏");
      tty.forget();
      tty.send("\r");
      await tty.see("s Review choices");
      tty.send("s");
      await tty.see("START demo WITH THESE ACCOUNTS");
      await tty.see("Runtime: sdk");
      await tty.see(`Repository: ${join(f.root, "repo")}`);
      tty.forget();
      tty.send("\r");
      await tty.see("Fixture creation failed before persistence");
      await tty.see(f.homes[2]!);
      await tty.see("Unsaved changes");
      const before = new StateStore(join(f.root, "state.sqlite3"));
      try {
        expect(before.list()).toEqual([]);
      } finally {
        before.close();
      }
      tty.forget();
      tty.send("s");
      await tty.see("START demo WITH THESE ACCOUNTS");
      await tty.see("Enter Start run");
      tty.send("\r");
      await tty.see("CREATED");
      await expect(tty.closed).resolves.toEqual([0, null]);
      await tty.see("ATTEMPTS 2");
      await tty.see("RAW false");
      const after = new StateStore(join(f.root, "state.sqlite3"));
      try {
        expect(after.list()).toHaveLength(1);
        expect(
          accountBinding(after.list()[0]!.runtimeConfiguration!.accounts!, "review", "review")
            ?.source.codexHome,
        ).toBe(f.homes[2]);
      } finally {
        after.close();
      }
      await expect(readFile(join(f.root, ".config/epicd/accounts.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await tty.stop();
    }
  });
  it("cancels from a narrow terminal without creating a run or saving defaults", async () => {
    const f = await fixture(),
      tty = await terminal(f.root, 55);
    try {
      await tty.see("Accounts — demo");
      tty.send("j");
      await tty.see("› orchestrator");
      tty.send("\r");
      await tty.see("Choose home for orchestrator");
      tty.send("e");
      await tty.see("Edit orchestrator");
      tty.send("unsaved");
      tty.send("\u0003");
      await tty.see("CANCELLED");
      await expect(tty.closed).resolves.toEqual([0, null]);
      await tty.see("RAW false");
      const store = new StateStore(join(f.root, "state.sqlite3"));
      try {
        expect(store.list()).toEqual([]);
      } finally {
        store.close();
      }
      await expect(readFile(join(f.root, ".config/epicd/accounts.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await tty.stop();
    }
  });
});
