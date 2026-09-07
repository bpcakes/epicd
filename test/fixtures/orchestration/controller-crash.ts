import { startConfinedCommand } from "../../../src/adapters/sandbox.js";

const workspace = process.argv[2];
if (!workspace) throw new Error("Expected an owned temporary workspace");
const handle = await startConfinedCommand({
  workspace,
  sourceMode: "read-only",
  writablePaths: ["scratch"],
  immutablePaths: ["fixture-node", "source.js"],
  command: "/workspace/fixture-node",
  args: [
    "-e",
    `
    const { spawn } = require("node:child_process");
    const script = "const fs = require('node:fs'); setInterval(() => fs.appendFileSync('scratch/ticks', 'x'), 10)";
    spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" }).unref();
    setInterval(() => {}, 1000);
  `,
  ],
  timeoutMs: 10_000,
});
await handle.result;
