import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freezeAccountDraft } from "../src/adapters/accounts.js";
import {
  AccountPreferencesSchema,
  accountBinding,
  resolveAccountDraft,
} from "../src/domain/accounts.js";
import { resolveCodexModel } from "../src/adapters/codex-settings.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "epicd-account-model-"));
  cleanup.push(root);
  const source = join(root, "source"),
    discovery = join(root, "discovery");
  await mkdir(source, { mode: 0o700 });
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "member-build" })).toString("base64url")}.c2ln`;
  const credential = JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: "2026-09-01T00:00:00Z",
    tokens: {
      access_token: "build-access-sentinel",
      id_token: token,
      account_id: "build",
      refresh_token: "source-refresh-sentinel",
    },
  });
  await writeFile(join(source, "auth.json"), credential, { mode: 0o600 });
  await writeFile(join(source, "config.toml"), 'model = "wrong-source-config"\n', { mode: 0o600 });
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/python3
import json, os, sys, time
from pathlib import Path
home = Path(os.environ['CODEX_HOME'])
auth = json.loads((home/'auth.json').read_text())
assert auth['tokens']['refresh_token'] == ''
assert not Path(${JSON.stringify(source)}).exists()
assert 'SOURCE_SECRET_SENTINEL' not in os.environ
assert 'wrong-source-config' not in (home/'config.toml').read_text()
log = Path(os.environ['TMPDIR'])/'protocol.jsonl'
methods = []
for line in sys.stdin:
    request = json.loads(line)
    methods.append(request['method'])
    with log.open('a') as f: f.write(json.dumps({'method':request['method'], 'params':request.get('params')})+'\\n')
    if request['method'] == 'initialize':
        print(json.dumps({'id':request['id'], 'result':{}}), flush=True)
    elif request['method'] == 'initialized': pass
    elif request['method'] == 'model/list':
        if ${JSON.stringify(mode)} == 'timeout': time.sleep(60)
        if ${JSON.stringify(mode)} == 'oversize':
            print('x'*70000, flush=True)
        elif request['params'].get('cursor') is None:
            print(json.dumps({'id':request['id'], 'result':{'data':[], 'nextCursor':'page-2'}}), flush=True)
        else:
            assert methods == ['initialize', 'initialized', 'model/list', 'model/list']
            assert request['params']['cursor'] == 'page-2'
            print(json.dumps({'id':request['id'], 'result':{'data':[{'model':'selected-'+auth['tokens']['account_id'],'isDefault':True}], 'nextCursor':None}}), flush=True)
    else: sys.exit('Unexpected method '+request['method'])
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const draft = resolveAccountDraft({
    preferences: AccountPreferencesSchema.parse({ schemaVersion: 1 }),
    configPath: join(root, "accounts.json"),
    cwd: root,
    operatorHome: root,
    overrides: { codexHome: source },
  });
  const snapshot = await freezeAccountDraft(draft);
  return {
    root,
    source,
    discovery,
    executable,
    credential,
    binding: accountBinding(snapshot, "implementation", "implementation")!,
  };
}
describe.runIf(process.platform === "linux")("account-bound model discovery", () => {
  it("queries only model/list using the selected isolated credentials and removes all probe storage", async () => {
    const f = await fixture();
    vi.stubEnv("CODEX_HOME", "/wrong-ambient-home");
    vi.stubEnv("SOURCE_SECRET_SENTINEL", "must-not-inherit");
    const model = await resolveCodexModel("/wrong-repository", {
      executable: { executablePath: f.executable, args: [] },
      attempts: 1,
      accountDiscovery: { source: f.binding.source, root: f.discovery },
    });
    expect(model).toBe("selected-build");
    expect(await readdir(f.discovery)).toEqual([]);
    expect(await readFile(join(f.source, "auth.json"), "utf8")).toBe(f.credential);
  });
  it.each(["timeout", "oversize"])(
    "settles %s discovery without accepting a model",
    async (mode) => {
      const f = await fixture(mode);
      await expect(
        resolveCodexModel("/wrong-repository", {
          executable: { executablePath: f.executable, args: [] },
          attempts: 1,
          timeoutMs: mode === "timeout" ? 1500 : 5000,
          accountDiscovery: { source: f.binding.source, root: f.discovery },
        }),
      ).rejects.toThrow(mode === "timeout" ? /Timed out|exited with code 130/ : /line limit/);
      expect(await readdir(f.discovery)).toEqual([]);
      expect(await readFile(join(f.source, "auth.json"), "utf8")).toBe(f.credential);
    },
  );
});
