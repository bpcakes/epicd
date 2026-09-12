import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { operatorFixture } from "./fixtures/operator.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function terminal(f: Awaited<ReturnType<typeof operatorFixture>>, runId = f.state.runId) {
  const command = `stty rows 48 cols 140; exec ${quote(process.execPath)} ${quote(resolve("dist/cli.js"))} control ${quote(runId)} --state ${quote(f.path)}`;
  const child = spawn("/usr/bin/script", ["-q", "-e", "-E", "never", "-c", command, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm", FORCE_COLOR: "0", CI: "" },
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
  const see = (text: string) => expect.poll(() => output, { timeout: 8000 }).toContain(text);
  return {
    see,
    send: (text: string) => child.stdin.write(text),
    closed,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    },
  };
}

describe.runIf(process.platform === "linux")(
  "compiled operator console in a real pseudo-terminal",
  () => {
    it("preserves a pre-render status failure as the original CLI diagnostic", async () => {
      const f = await operatorFixture(),
        tty = await terminal(f, "missing-run");
      try {
        await tty.see("epicd: Unknown epicd run missing-run");
        await expect(tty.closed).resolves.toEqual([1, null]);
      } finally {
        await tty.stop();
      }
    });

    it("opens and quits without attaching a controller or changing the run", async () => {
      const f = await operatorFixture(),
        before = f.operator.status(),
        tty = await terminal(f);
      try {
        await tty.see("Operator console");
        expect(f.operator.status()).toEqual(before);
        tty.send("q");
        await expect(tty.closed).resolves.toEqual([0, null]);
        expect(f.operator.status()).toEqual(before);
        expect(f.store.controllerLease(f.state.runId)).toBeNull();
      } finally {
        await tty.stop();
      }
    });

    it("records a confirmed exact-question response through the compiled CLI without granting or resuming", async () => {
      const f = await operatorFixture(),
        escalationId = f.question(),
        tty = await terminal(f);
      try {
        await tty.see("Operator console");
        tty.send("2");
        await tty.see("Response (instruction only");
        tty.send("Investigate the missing fixture");
        await tty.see("Investigate the missing fixture▏");
        tty.send("\r");
        await tty.see("Type confirm and Enter");
        expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
        tty.send("confirm");
        await tty.see("confirm▏");
        tty.send("\r");
        await tty.see("Response recorded as an instruction");
        expect(f.operator.status().escalation).toBeNull();
        expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
        expect(f.store.orchestration.fixtures.validation.grants(f.state.runId)).toEqual([]);
        expect(f.store.orchestration.agents.instances(f.state.runId)).toEqual([]);
        expect(f.store.controllerLease(f.state.runId)).toBeNull();
        tty.send("q");
        await expect(tty.closed).resolves.toEqual([0, null]);
      } finally {
        await tty.stop();
      }
    });

    it("discards an unconfirmed response on Ctrl+C without answering or pausing", async () => {
      const f = await operatorFixture(),
        escalationId = f.question(),
        before = f.operator.status(),
        tty = await terminal(f);
      try {
        await tty.see("Operator console");
        tty.send("2");
        await tty.see("Response (instruction only");
        tty.send("Unsubmitted instruction");
        await tty.see("Unsubmitted instruction");
        tty.send("\u0003");
        await expect(tty.closed).resolves.toEqual([0, null]);
        expect(f.operator.status()).toEqual(before);
        expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
        expect(f.store.controllerLease(f.state.runId)).toBeNull();
      } finally {
        await tty.stop();
      }
    });
  },
);
