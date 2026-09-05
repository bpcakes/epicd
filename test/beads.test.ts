import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeadsClient } from "../src/adapters/beads.js";
import { CommandError } from "../src/util/command.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.EPICD_TEST_LOG;
  delete process.env.EPICD_TEST_TYPE;
  delete process.env.EPICD_TEST_NOT_READY;
  delete process.env.EPICD_TEST_MALFORMED_LIST;
  delete process.env.EPICD_TEST_STATUS;
  delete process.env.EPICD_TEST_ASSIGNEE;
  delete process.env.EPICD_TEST_QUERY_RESPONSE;
  delete process.env.EPICD_TEST_QUERY_FAILURE;
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
if (process.env.EPICD_TEST_QUERY_FAILURE === cmd) { console.error("query unavailable"); process.exit(7); }
if (["list", "ready", "blocked"].includes(cmd) && process.env.EPICD_TEST_QUERY_RESPONSE !== undefined) {
  console.log(process.env.EPICD_TEST_QUERY_RESPONSE);
  process.exit(0);
}
const type = process.env.EPICD_TEST_TYPE || "task";
const issue = {id:"epic.1",title:"Concrete work",description:"Implement it",acceptance_criteria:"It works",status:process.env.EPICD_TEST_STATUS || "open",priority:1,issue_type:type,labels:[],assignee:process.env.EPICD_TEST_ASSIGNEE || null};
if (cmd === "ready") console.log(JSON.stringify(process.env.EPICD_TEST_NOT_READY ? [] : [issue]));
else if (cmd === "blocked") console.log(JSON.stringify([]));
else if (cmd === "list") console.log(JSON.stringify(process.env.EPICD_TEST_MALFORMED_LIST ? {} : {issues:[issue]}));
else if (cmd === "show") console.log(JSON.stringify(issue));
else if (cmd === "update") { const actorIndex = process.argv.indexOf("--actor"); console.log(JSON.stringify({...issue,status:"in_progress",assignee:actorIndex >= 0 ? process.argv[actorIndex + 1] : issue.assignee})); }
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

  it("rejects a malformed list envelope instead of treating it as empty", async () => {
    const fixture = installFakeBr();
    process.env.EPICD_TEST_MALFORMED_LIST = "1";

    await expect(new BeadsClient(fixture.root).listAll()).rejects.toThrow();
  });

  it("executes ready, show, and only then an atomic claim", async () => {
    const fixture = installFakeBr();
    await new BeadsClient(fixture.root).claim("epic", "epic.1", "run-1");
    const commands = readFileSync(fixture.log, "utf8").trim().split("\n");
    expect(commands[0]).toContain("ready --epic epic");
    expect(commands[1]).toBe("show epic.1 --json");
    expect(commands[2]).toContain("update epic.1 --claim --actor epicd:run-1");
    expect(commands[2]).not.toContain("--force");
  });

  it("atomically adopts unassigned in-progress work", async () => {
    const fixture = installFakeBr();
    process.env.EPICD_TEST_STATUS = "in_progress";
    await new BeadsClient(fixture.root).adoptUnownedInProgress("epic", "epic.1", "run-2");

    const commands = readFileSync(fixture.log, "utf8").trim().split("\n");
    expect(commands).toEqual([
      "show epic.1 --json",
      expect.stringContaining("update epic.1 --claim --actor epicd:run-2"),
      "show epic.1 --json",
    ]);
  });

  it("refuses to adopt in-progress work owned by someone else", async () => {
    const fixture = installFakeBr();
    process.env.EPICD_TEST_STATUS = "in_progress";
    process.env.EPICD_TEST_ASSIGNEE = "other-agent";

    await expect(
      new BeadsClient(fixture.root).adoptUnownedInProgress("epic", "epic.1", "run-2"),
    ).rejects.toThrow("owner other-agent");
    expect(readFileSync(fixture.log, "utf8")).not.toContain("update ");
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

const collectionQueries = [
  {
    name: "all issues",
    query: (client: BeadsClient) => client.listAll(),
    args: ["list", "--all", "--limit", "0", "--json"],
  },
  {
    name: "open epics",
    query: (client: BeadsClient) => client.listOpenEpics(),
    args: ["list", "--status=open", "--type=epic", "--limit", "0", "--json"],
  },
  {
    name: "ready",
    query: (client: BeadsClient) => client.ready(),
    args: ["ready", "--limit", "0", "--json"],
  },
  {
    name: "epic ready",
    query: (client: BeadsClient) => client.ready("epic"),
    args: ["ready", "--epic", "epic", "--limit", "0", "--json"],
  },
  {
    name: "blocked",
    query: (client: BeadsClient) => client.blocked(),
    args: ["blocked", "--limit", "0", "--json"],
  },
];

describe.each(collectionQueries)("BeadsClient $name collection", ({ query, args }) => {
  it.each(["array", "envelope"])(
    "accepts the %s response and requests the complete collection",
    async (shape) => {
      const fixture = installFakeBr();
      const issue = { id: "epic.1", title: "Work", issue_type: "task", status: "open" };
      process.env.EPICD_TEST_QUERY_RESPONSE = JSON.stringify(
        shape === "array" ? [issue] : { issues: [issue] },
      );

      expect(await query(new BeadsClient(fixture.root))).toMatchObject([issue]);
      expect(readFileSync(fixture.log, "utf8")).toBe(`${args.join(" ")}\n`);
    },
  );

  it.each(["{}", '{"issues":{}}', '[{"id":"epic.1","status":"unsupported"}]', "not json"])(
    "rejects malformed collection %s",
    async (response) => {
      const fixture = installFakeBr();
      process.env.EPICD_TEST_QUERY_RESPONSE = response;

      await expect(query(new BeadsClient(fixture.root))).rejects.toThrow();
    },
  );

  it("propagates command failure without retrying or treating it as empty", async () => {
    const fixture = installFakeBr();
    process.env.EPICD_TEST_QUERY_FAILURE = args[0];
    const result = query(new BeadsClient(fixture.root));

    await expect(result).rejects.toBeInstanceOf(CommandError);
    await expect(result).rejects.toMatchObject({
      result: { args, exitCode: 7, stderr: "query unavailable\n" },
    });
    expect(readFileSync(fixture.log, "utf8")).toBe(`${args.join(" ")}\n`);
  });
});
