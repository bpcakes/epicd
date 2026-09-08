import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CODEX_PERMISSION_PROFILE,
  writeCodexConfinement,
} from "../../dist/adapters/codex-confinement.js";
import { runCommand } from "../../dist/util/command.js";
import { startConfinedCommand } from "../../dist/adapters/sandbox.js";

const ProbeSchema = z
  .object({
    tmpdir: z.string(),
    scratch: z.string().nullable(),
    localServer: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();

/** Fixed local-command probe, not an authenticated runtime/admission certificate.
 * Retain its private config and output on failure; no model, database or Herdr server starts.
 */
export async function probeBrowserExecution(executable: string) {
  const root = await mkdtemp("/var/tmp/epicd-browser-worker-preflight-");
  const spec = {
    executable,
    workspace: join(root, "source"),
    providerHome: join(root, "provider"),
    scratch: join(root, "scratch"),
    artifacts: join(root, "artifacts"),
    sourceMode: "workspace-write" as const,
  };
  process.stderr.write(`Browser worker prerequisite artifacts: ${root}\n`);
  for (const path of [spec.workspace, spec.providerHome, spec.scratch, spec.artifacts])
    await mkdir(path, { mode: 0o700 });
  const node = join(spec.workspace, "probe-node"),
    output = join(spec.artifacts, "result.json");
  await copyFile(process.execPath, node);
  await writeCodexConfinement(spec);
  const script = `
    const fs = require('node:fs'), net = require('node:net');
    const result = {tmpdir: process.env.TMPDIR, scratch: null, localServer: false, error: null};
    try {
      result.scratch = fs.mkdtempSync(process.env.TMPDIR + '/browser-prerequisite-');
      fs.rmdirSync(result.scratch);
    } catch (error) {
      result.error = error.code;
      console.log(JSON.stringify(result));
      process.exit(0);
    }
    const server = net.createServer();
    server.once('error', error => {
      result.error = error.code;
      console.log(JSON.stringify(result));
    });
    server.listen(0, '127.0.0.1', () => {
      result.localServer = true;
      server.close(() => console.log(JSON.stringify(result)));
    });
  `;
  try {
    await runCommand(
      executable,
      [
        "sandbox",
        "-P",
        CODEX_PERMISSION_PROFILE,
        "-C",
        spec.workspace,
        "--",
        "/bin/sh",
        "-c",
        'exec "$1" -e "$2" > "$3"',
        "epicd-browser-worker-prerequisite",
        node,
        script,
        output,
      ],
      {
        cwd: spec.workspace,
        env: {
          PATH: "/usr/bin:/bin",
          CODEX_HOME: spec.providerHome,
          HOME: spec.providerHome,
          TMPDIR: spec.scratch,
        },
        timeoutMs: 15000,
      },
    );
    // The CLI can return zero without forwarding command output. Require the actual
    // confined program's record, not the wrapper's exit status or a model's account.
    const worker = ProbeSchema.parse(JSON.parse(await readFile(output, "utf8")));
    const handle = await startConfinedCommand({
      workspace: spec.workspace,
      sourceMode: "read-only",
      command: "/workspace/probe-node",
      args: ["-e", script],
      timeoutMs: 15000,
    });
    const outcome = await handle.result;
    await writeFile(join(spec.artifacts, "kernel-result.json"), JSON.stringify(outcome), {
      mode: 0o600,
    });
    const kernel = ProbeSchema.parse(JSON.parse(outcome.stdout));
    return {
      root,
      executable,
      worker: {
        scratchAvailable:
          worker.tmpdir === spec.scratch &&
          worker.scratch?.startsWith(join(spec.scratch, "browser-prerequisite-")) === true,
        localServerAvailable: worker.localServer,
        error: worker.error,
      },
      kernel: {
        scratchAvailable:
          kernel.tmpdir === "/tmp" &&
          kernel.scratch?.startsWith("/tmp/browser-prerequisite-") === true,
        localServerAvailable: kernel.localServer,
        error: kernel.error,
        succeeded: outcome.status === "succeeded" && outcome.exitCode === 0,
        processTreeStopped: outcome.processTreeStopped,
      },
    };
  } catch (cause) {
    throw new Error(`Browser worker prerequisite probe could not finish; inspect ${root}`, {
      cause,
    });
  }
}

export function requireBrowserExecution(result: Awaited<ReturnType<typeof probeBrowserExecution>>) {
  if (
    result.worker.scratchAvailable &&
    !result.worker.localServerAvailable &&
    ["EPERM", "EACCES"].includes(result.worker.error ?? "") &&
    result.kernel.scratchAvailable &&
    result.kernel.localServerAvailable &&
    result.kernel.error === null &&
    result.kernel.succeeded &&
    result.kernel.processTreeStopped
  )
    return;
  throw new Error(
    `Browser incident prerequisite unmet: workers need private scratch and denied network listeners; ` +
      `the kernel executor needs private scratch and a local test server. ` +
      `worker=${JSON.stringify(result.worker)}, kernel=${JSON.stringify(result.kernel)}. ` +
      `No authenticated run was started. Inspect ${result.root}. ` +
      `Do not enable host networking or waive the incident assertions.`,
  );
}
