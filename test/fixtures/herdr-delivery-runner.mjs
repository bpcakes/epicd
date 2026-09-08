import { spawn } from "node:child_process";
import { openSync, closeSync, writeFileSync, renameSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// Ordinary test process inside an actual owned Herdr pane. No agent/runtime proxy.
const [repository, artifacts, sessionName, workspaceId] = process.argv.slice(2);
if (process.env.HERDR_ENV !== "1" || !isAbsolute(repository) || !isAbsolute(artifacts))
  throw new Error("Native delivery runner requires an actual Herdr caller and explicit paths");
const log = openSync(join(artifacts, "delivery.log"), "wx", 0o600);
const child = spawn(
  process.execPath,
  [
    join(repository, "node_modules/vitest/vitest.mjs"),
    "run",
    "test/model-led-delivery.integration.test.ts",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${join(artifacts, "delivery.json")}`,
  ],
  {
    cwd: repository,
    env: {
      ...process.env,
      EPICD_LIVE_DELIVERY: "1",
      EPICD_LIVE_DELIVERY_RUNTIME: "herdr",
      EPICD_EXPECT_HERDR_SESSION: sessionName,
      EPICD_EXPECT_HERDR_WORKSPACE: workspaceId,
    },
    stdio: ["ignore", log, log],
  },
);
child.once("error", (error) => process.stderr.write(`Delivery runner failed: ${error.message}\n`));
child.once("close", (code, signal) => {
  closeSync(log);
  writeFileSync(
    join(artifacts, "exit.json.pending"),
    JSON.stringify({ code, signal, pid: child.pid ?? null }),
    { flag: "wx", mode: 0o600 },
  );
  renameSync(join(artifacts, "exit.json.pending"), join(artifacts, "exit.json"));
  process.exitCode = code === 0 && signal === null ? 0 : 1;
});
