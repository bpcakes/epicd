import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { ACCOUNT_CLASSES, AccountSnapshotSchema } from "../../src/domain/accounts.js";
import { principalDigest } from "../../src/adapters/accounts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real private files for synchronous controller/store fixtures; no operator credentials. */
export function fixtureAccounts(parent?: string) {
  const home = realpathSync(mkdtempSync(join(parent ?? tmpdir(), "epicd-fixture-account-")));
  if (!parent) roots.push(home);
  const authCachePath = join(home, "auth.json");
  const cache = {
    auth_mode: "chatgpt" as const,
    last_refresh: "2026-09-01T00:00:00Z",
    tokens: {
      access_token: "fixture-access",
      account_id: "fixture-account",
      id_token: `e30.${Buffer.from('{"sub":"fixture-member"}').toString("base64url")}.c2ln`,
    },
  };
  writeFileSync(authCachePath, JSON.stringify(cache), { mode: 0o600 });
  const identity = statSync(home, { bigint: true });
  const source = {
    codexHome: home,
    authCachePath,
    device: String(identity.dev),
    inode: String(identity.ino),
    principalDigest: principalDigest(cache),
    label: "Fixture account",
  };
  const bindingId = createHash("sha256")
    .update(
      JSON.stringify([
        "epicd-account-binding-v1",
        source.principalDigest,
        home,
        source.device,
        source.inode,
        authCachePath,
      ]),
    )
    .digest("hex");
  return AccountSnapshotSchema.parse({
    schemaVersion: 1,
    mode: "homes",
    sources: [{ ...source, bindingId }],
    classes: Object.fromEntries(ACCOUNT_CLASSES.map((key) => [key, bindingId])),
    provenance: Object.fromEntries(
      ACCOUNT_CLASSES.map((key) => [key, { origin: "cli", inheritedFrom: null }]),
    ),
  });
}
