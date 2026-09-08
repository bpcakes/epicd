import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CODEX_PERMISSION_PROFILE,
  writeCodexConfinement,
} from "../../dist/adapters/codex-confinement.js";
import { runCommand } from "../../dist/util/command.js";

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
export async function probeBrowserWorker(executable: string) {
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
    const result = ProbeSchema.parse(JSON.parse(await readFile(output, "utf8")));
    return {
      root,
      executable,
      scratchAvailable:
        result.tmpdir === spec.scratch &&
        result.scratch?.startsWith(join(spec.scratch, "browser-prerequisite-")) === true,
      localServerAvailable: result.localServer,
      error: result.error,
    };
  } catch (cause) {
    throw new Error(`Browser worker prerequisite probe could not finish; inspect ${root}`, {
      cause,
    });
  }
}

export function requireBrowserWorker(result: Awaited<ReturnType<typeof probeBrowserWorker>>) {
  if (result.scratchAvailable && result.localServerAvailable && result.error === null) return;
  throw new Error(
    `Browser incident prerequisite unmet: ordinary confined workers need private temporary storage and a local test server; ` +
      `scratch=${result.scratchAvailable}, localServer=${result.localServerAvailable}, error=${result.error}. ` +
      `No authenticated run was started. Inspect ${result.root}. ` +
      `This scenario needs kernel-mediated worker validation before retrying; do not enable host networking or waive its incident assertions.`,
  );
}
