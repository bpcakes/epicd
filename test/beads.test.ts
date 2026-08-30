import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeadsClient } from "../src/adapters/beads.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.EPICD_TEST_LOG;
  delete process.env.EPICD_TEST_TYPE;
  delete process.env.EPICD_TEST_NOT_READY;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function installFakeBr(): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "epicd-gate-"));
  tempDirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "commands.log");
  const executable = join(bin, "br");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.EPICD_TEST_LOG, process.argv.slice(2).join(" ") + "\\n");
const cmd = process.argv[2];
const type = process.env.EPICD_TEST_TYPE || "task";
const issue = {id:"epic.1",title:"Concrete work",description:"Implement it",acceptance_criteria:"It works",status:"open",priority:1,issue_type:type,labels:[]};
if (cmd === "ready") console.log(JSON.stringify(process.env.EPICD_TEST_NOT_READY ? [] : [issue]));
else if (cmd === "list") console.log(JSON.stringify({issues:[issue]}));
else if (cmd === "show") console.log(JSON.stringify(issue));
else if (cmd === "update") console.log(JSON.stringify({...issue,status:"in_progress"}));
else if (cmd === "--version") console.log("br test");
else console.log("{}");
`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.EPICD_TEST_LOG = log;
  return { root, log };
}

describe.sequential("BeadsClient claim gate", () => {
  it("uses the shared list contract for all issues and open epics", async () => {
    const fixture = installFakeBr();
    const client = new BeadsClient(fixture.root);

    expect(await client.listAll()).toMatchObject([{ id: "epic.1", issue_type: "task" }]);
    expect(await client.listOpenEpics()).toMatchObject([{ id: "epic.1", issue_type: "task" }]);

    const commands = readFileSync(fixture.log, "utf8").trim().split("\n");
    expect(commands).toEqual([
      "list --all --limit 0 --json",
      "list --status=open --type=epic --limit 0 --json",
    ]);
  });

  it("executes ready, show, and only then the status mutation", async () => {
    const fixture = installFakeBr();
    await new BeadsClient(fixture.root).claim("epic", "epic.1", "run-1");
    const commands = readFileSync(fixture.log, "utf8").trim().split("\n");
    expect(commands[0]).toContain("ready --epic epic");
    expect(commands[1]).toBe("show epic.1 --json");
    expect(commands[2]).toContain("update epic.1 --status=in_progress");
    expect(commands[2]).not.toContain("--force");
  });

  it("refuses an epic container before mutation", async () => {
    const fixture = installFakeBr();
    process.env.EPICD_TEST_TYPE = "epic";
    await expect(new BeadsClient(fixture.root).claim("epic", "epic.1", "run-1")).rejects.toThrow(
      "epic container",
    );
    expect(readFileSync(fixture.log, "utf8")).not.toContain("update ");
  });

  it("refuses a candidate absent from the immediately preceding ready set", async () => {
    const fixture = installFakeBr();
    process.env.EPICD_TEST_NOT_READY = "1";
    await expect(new BeadsClient(fixture.root).claim("epic", "epic.1", "run-1")).rejects.toThrow(
      "absent from the immediately preceding br ready",
    );
    const log = readFileSync(fixture.log, "utf8");
    expect(log).not.toContain("show ");
    expect(log).not.toContain("update ");
  });
});
