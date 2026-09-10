import { lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  readCodexAccessCache,
  readCodexAccessCacheSync,
  readOwnerFile,
} from "./codex-credentials.js";
import {
  ACCOUNT_CLASSES,
  AccountPreferencesSchema,
  AccountSnapshotSchema,
  AccountDraftValidationError,
  accountInputField,
  resolveAccountDraft,
  type AccountDraft,
  type AccountOverrides,
  type AccountPreferences,
  type AccountSource,
  type AccountSnapshot,
} from "../domain/accounts.js";

export function defaultAccountsPath() {
  return join(
    process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config"),
    "epicd",
    "accounts.json",
  );
}
export async function loadAccountPreferences(
  path = defaultAccountsPath(),
  required = false,
): Promise<AccountPreferences> {
  try {
    const canonicalPath = join(await realpath(dirname(path)), basename(path));
    return AccountPreferencesSchema.parse(
      JSON.parse(await readOwnerFile(canonicalPath, 64 * 1024)),
    );
  } catch (error) {
    if (!required && error instanceof Error && "code" in error && error.code === "ENOENT")
      return AccountPreferencesSchema.parse({ schemaVersion: 1 });
    const detail =
      error instanceof SyntaxError
        ? "Malformed JSON."
        : error instanceof z.ZodError
          ? error.issues
              .map((issue) =>
                issue.code === "unrecognized_keys"
                  ? `Unknown settings: ${issue.keys.map((key) => JSON.stringify(key.slice(0, 80))).join(", ")}.`
                  : `Invalid setting ${issue.path.map(String).join(".") || "root"} (${issue.code}).`,
              )
              .join(" ") + ` Valid account classes: ${ACCOUNT_CLASSES.join(", ")}.`
          : error instanceof Error && "code" in error && error.code === "ENOENT"
            ? "File or parent directory does not exist."
            : error instanceof Error && "code" in error && error.code === "EACCES"
              ? "Permission denied; the current user must be able to read the file."
              : "Use an owned, non-symlink regular file with mode 0600, no hard links, and at most 64 KiB.";
    throw new Error(`Cannot read account preferences at ${path}: ${detail}`);
  }
}
export async function saveAccountPreferences(
  preferences: AccountPreferences,
  path = defaultAccountsPath(),
) {
  const bytes = JSON.stringify(AccountPreferencesSchema.parse(preferences), null, 2) + "\n";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(path));
  const info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Account preferences directory must be a real, owned directory with mode 0700");
  path = join(parent, basename(path));
  try {
    AccountPreferencesSchema.parse(JSON.parse(await readOwnerFile(path, 64 * 1024)));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export async function loadAccountDraft(
  overrides: AccountOverrides = {},
  configPath?: string,
  canonicalize = true,
): Promise<AccountDraft> {
  if (configPath !== undefined) configPath = resolve(configPath);
  const preferences = await loadAccountPreferences(
    configPath ?? defaultAccountsPath(),
    configPath !== undefined,
  );
  const draft = resolveAccountDraft({
    preferences,
    configPath: configPath ?? defaultAccountsPath(),
    cwd: process.cwd(),
    operatorHome: homedir(),
    ...(process.env.CODEX_HOME !== undefined ? { environmentHome: process.env.CODEX_HOME } : {}),
    overrides,
  });
  return canonicalize ? canonicalizeAccountDraft(draft) : draft;
}
export async function canonicalizeAccountDraft(input: AccountDraft): Promise<AccountDraft> {
  const draft = structuredClone(input);
  // Only effective homes must exist; an overridden, unused default need not.
  const canonicalHomes = new Map<string, string>();
  for (const key of ACCOUNT_CLASSES) {
    const value = draft.classes[key];
    if (!value) continue;
    const path = value.codexHome;
    let canonical = canonicalHomes.get(path);
    if (canonical === undefined) {
      try {
        canonical = await realpath(path);
      } catch {
        throw new AccountDraftValidationError({
          [accountInputField(draft, key)]:
            "Directory is missing or unreadable. Choose an existing Codex home.",
        });
      }
      canonicalHomes.set(path, canonical);
    }
    value.codexHome = canonical;
  }
  const canonicalDefault = canonicalHomes.get(draft.defaultAccount.codexHome);
  if (canonicalDefault !== undefined) {
    draft.defaultAccount.codexHome = canonicalDefault;
  }
  return draft;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function principalDigest(cache: Awaited<ReturnType<typeof readCodexAccessCache>>): string {
  try {
    const account = cache.tokens.account_id;
    const token = cache.tokens.id_token;
    if (!account || !token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      throw new Error();
    const claims: unknown = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    );
    if (!claims || typeof claims !== "object" || Array.isArray(claims) || !("sub" in claims))
      throw new Error();
    const sub = claims.sub;
    const valid = (s: unknown): s is string =>
      typeof s === "string" &&
      s.length > 0 &&
      s.length <= 512 &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(s);
    if (!valid(account) || !valid(sub)) throw new Error();
    const auth = (claims as Record<string, unknown>)["https://api.openai.com/auth"];
    if (
      auth &&
      typeof auth === "object" &&
      "chatgpt_account_id" in auth &&
      auth.chatgpt_account_id !== account
    )
      throw new Error();
    return digest(["epicd-principal-v1", account, sub]);
  } catch {
    throw new Error(
      "Unsupported Codex credential identity metadata; select a managed ChatGPT login",
    );
  }
}
async function sourceDirectory(path: string) {
  const info = await lstat(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.uid !== BigInt(process.getuid!()) ||
    (info.mode & 0o022n) !== 0n ||
    (await realpath(path)) !== path
  )
    throw new Error(
      "Codex account home must be a canonical owned directory without shared write access",
    );
  return { device: String(info.dev), inode: String(info.ino) };
}
function assertAccountContinuity(
  source: AccountSource,
  cache: Awaited<ReturnType<typeof readCodexAccessCache>>,
  identity: { device: string; inode: string },
) {
  if (
    identity.device !== source.device ||
    identity.inode !== source.inode ||
    principalDigest(cache) !== source.principalDigest ||
    source.bindingId !==
      digest([
        "epicd-account-binding-v1",
        source.principalDigest,
        source.codexHome,
        source.device,
        source.inode,
        source.authCachePath,
      ])
  )
    throw new Error(
      "The selected Codex account changed; start a new run to select a different account",
    );
}
export async function validateAccountSource(
  source: AccountSource,
  cache: Awaited<ReturnType<typeof readCodexAccessCache>>,
) {
  let identity: { device: string; inode: string };
  try {
    identity = await sourceDirectory(source.codexHome);
  } catch {
    throw new Error(
      "The selected Codex account home is unavailable or changed; select it in a new run",
    );
  }
  assertAccountContinuity(source, cache, identity);
}
export function validateAccountReservation(source: AccountSource) {
  const cache = readCodexAccessCacheSync(source.authCachePath);
  let identity: { device: string; inode: string };
  try {
    const info = lstatSync(source.codexHome, { bigint: true });
    if (
      !info.isDirectory() ||
      info.uid !== BigInt(process.getuid!()) ||
      (info.mode & 0o022n) !== 0n ||
      realpathSync(source.codexHome) !== source.codexHome
    )
      throw new Error();
    identity = { device: info.dev.toString(), inode: info.ino.toString() };
  } catch {
    throw new Error(
      "The selected Codex account home is unavailable or changed; select it in a new run",
    );
  }
  assertAccountContinuity(source, cache, identity);
}
export async function freezeAccountDraft(draft: AccountDraft) {
  const sources: AccountSource[] = [];
  const classes = {} as Record<(typeof ACCOUNT_CLASSES)[number], string | null>;
  for (const key of ACCOUNT_CLASSES) {
    try {
      const selected = draft.classes[key];
      if (!selected) {
        classes[key] = null;
        continue;
      }
      const authCachePath = join(selected.codexHome, "auth.json");
      let source = sources.find((source) => source.authCachePath === authCachePath);
      if (!source) {
        const codexHome = selected.codexHome;
        const identity = await sourceDirectory(codexHome);
        const cache = await readCodexAccessCache(authCachePath);
        const principal = principalDigest(cache);
        if (!cache.last_refresh)
          throw new Error("The managed Codex cache lacks refresh-time metadata");
        source = {
          bindingId: digest([
            "epicd-account-binding-v1",
            principal,
            codexHome,
            identity.device,
            identity.inode,
            authCachePath,
          ]),
          principalDigest: principal,
          codexHome,
          authCachePath,
          ...identity,
          label: selected.label.slice(0, 80),
        };
        await validateAccountSource(source, cache);
        sources.push(source);
      }
      classes[key] = source.bindingId;
    } catch (error) {
      throw new AccountDraftValidationError({
        [accountInputField(draft, key)]:
          error instanceof Error ? error.message : "Cannot read this account's credentials.",
      });
    }
  }
  const provenance = Object.fromEntries(
    ACCOUNT_CLASSES.map((key) => {
      const entry = draft.classes[key];
      return [
        key,
        {
          origin: entry?.origin ?? "default",
          inheritedFrom: entry?.inheritedFrom ?? null,
        },
      ];
    }),
  );
  return AccountSnapshotSchema.parse({
    schemaVersion: 1,
    mode: draft.mode,
    sources,
    classes,
    provenance,
  });
}

/** Local-only preflight. Creation still freezes and revalidates the selected sources. */
export async function validateAccountDraft(draft: AccountDraft): Promise<AccountDraft> {
  const canonical = await canonicalizeAccountDraft(draft);
  await freezeAccountDraft(canonical);
  return canonical;
}

export function pathsOverlap(a: string, b: string) {
  const within = (root: string, path: string) => {
    const r = relative(root, path);
    return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r));
  };
  return within(a, b) || within(b, a);
}
export function assertAccountStorage(snapshot: AccountSnapshot, forbidden: readonly string[]) {
  for (const source of snapshot.sources)
    for (const path of forbidden)
      if (pathsOverlap(source.codexHome, path) || pathsOverlap(source.authCachePath, path))
        throw new Error(
          "Codex account sources must be outside repository, state, and private runtime storage",
        );
}

/** Read, validate continuity and project the exact same bytes; never reopen after validation. */
export async function projectAccountAccessToken(
  authCachePath: string,
  providerHome: string,
  generation: string,
  source?: AccountSource,
  signal?: AbortSignal,
) {
  if (source && source.authCachePath !== authCachePath)
    throw new Error("Launch account cache differs from its frozen binding");
  const cache = await readCodexAccessCache(authCachePath);
  if (source) await validateAccountSource(source, cache);
  signal?.throwIfAborted();
  if (!cache.tokens.id_token || !cache.tokens.account_id || !cache.last_refresh)
    throw new Error("The managed Codex cache lacks identity or refresh-time metadata");
  const projection = {
    ...cache,
    auth_mode: "chatgpt",
    tokens: { ...cache.tokens, refresh_token: "" },
  };
  const target = join(providerHome, "auth.json"),
    temporary = `${target}.${generation}.tmp`;
  await writeFile(temporary, JSON.stringify(projection), { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

/** Local inventory only: no account process, login, or provider request. */
export async function discoverAccountHomes(
  draft: AccountDraft,
  operatorHome = homedir(),
): Promise<string[]> {
  const candidates = new Set<string>();
  try {
    for (const name of await readdir(operatorHome, { encoding: "buffer" })) {
      const value = name.toString("utf8");
      if (!name.equals(Buffer.from(value))) continue;
      if (value === ".codex" || value.startsWith(".codex-"))
        candidates.add(join(operatorHome, value));
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (process.env.CODEX_HOME) candidates.add(resolve(process.env.CODEX_HOME));
  if (draft.mode === "homes")
    for (const account of Object.values(draft.classes))
      if (account) candidates.add(account.codexHome);
  const homes = new Set<string>();
  for (const path of candidates) {
    try {
      const canonical = await realpath(path);
      if ((await lstat(canonical)).isDirectory() && !/[\u0000-\u001f\u007f-\u009f]/.test(canonical))
        homes.add(canonical);
    } catch {
      /* Missing/unreadable candidates remain editable paths, not selectable inventory. */
    }
  }
  return [...homes].sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
}
