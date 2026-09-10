import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AccountPreferencesSchema,
  accountBinding,
  resolveAccountDraft,
} from "../src/domain/accounts.js";
import {
  assertAccountStorage,
  canonicalizeAccountDraft,
  freezeAccountDraft,
  loadAccountPreferences,
  saveAccountPreferences,
  validateAccountDraft,
} from "../src/adapters/accounts.js";
import { prepareCodexAccessToken } from "../src/adapters/codex-launch.js";
import { CodexLaunchSchema } from "../src/domain/codex-launch.js";
import { randomUUID } from "node:crypto";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const r = await mkdtemp(join(tmpdir(), "epicd-accounts-"));
  roots.push(r);
  return r;
}
function resolveDraft(overrides = {}, preferences: unknown = { schemaVersion: 1 }) {
  return resolveAccountDraft({
    preferences: AccountPreferencesSchema.parse(preferences),
    configPath: "/settings/accounts.json",
    cwd: "/invoking",
    operatorHome: "/operator",
    environmentHome: "/environment",
    overrides,
  });
}
function homeDraft(overrides = {}, preferences: unknown = { schemaVersion: 1 }) {
  const draft = resolveDraft(overrides, preferences);
  if (draft.mode !== "homes") throw new Error("Expected home mode");
  return draft;
}
function credential(account: string, sub = "member", access = "access-sentinel") {
  return {
    auth_mode: "chatgpt",
    last_refresh: "2026-09-01T00:00:00Z",
    tokens: {
      access_token: access,
      refresh_token: "refresh-sentinel-never-project",
      account_id: account,
      id_token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.c2ln`,
    },
  };
}
async function fakeHome(parent: string, name: string) {
  const home = join(parent, name);
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, "auth.json"), JSON.stringify(credential(name)), { mode: 0o600 });
  return home;
}

describe("account preference resolution", () => {
  it("inherits environment defaults and preserves specialist role inheritance", () => {
    const draft = homeDraft();
    expect(draft.classes.orchestrator).toMatchObject({
      codexHome: "/environment",
      origin: "environment",
      inheritedFrom: "default",
    });
    expect(draft.classes.verification).toMatchObject({
      codexHome: "/environment",
      inheritedFrom: "review",
    });
    expect(draft.classes.epic_repair?.inheritedFrom).toBe("implementation");
    expect(draft.classes.specialist).toBeNull();
  });
  it("uses configuration and invocation path bases without shell interpolation", () => {
    const draft = homeDraft(
      { agentCodexHome: ["review=./review = $literal `value`", "specialist=~/special"] },
      {
        schemaVersion: 1,
        defaultCodexHome: "saved",
        classes: { implementation: { codexHome: "../build" } },
      },
    );
    expect(draft.classes.orchestrator?.codexHome).toBe("/settings/saved");
    expect(draft.classes.implementation?.codexHome).toBe("/build");
    expect(draft.classes.review?.codexHome).toBe("/invoking/review = $literal `value`");
    expect(draft.classes.final_review?.codexHome).toBe(draft.classes.review?.codexHome);
    expect(draft.classes.specialist?.codexHome).toBe("/operator/special");
  });
  it("preserves environment inheritance and saved path spelling while rebasing CLI relative paths", () => {
    const draft = homeDraft(
      { agentCodexHome: ["implementation=./build", "specialist=~/special"] },
      { schemaVersion: 1, classes: { review: { codexHome: "../review" } } },
    );
    expect(draft.preferences.defaultCodexHome).toBeNull();
    expect(draft.preferences.classes.review?.codexHome).toBe("../review");
    expect(draft.preferences.classes.implementation?.codexHome).toBe("/invoking/build");
    expect(draft.preferences.classes.specialist?.codexHome).toBe("~/special");
    expect(draft.classes.review?.codexHome).toBe("/review");
  });
  it("clears explicit classes back to inheritance and supports a literal inherit directory", () => {
    const draft = homeDraft(
      { codexHome: "/default", agentCodexHome: ["review=inherit", "implementation=./inherit"] },
      { schemaVersion: 1, classes: { review: { codexHome: "/old" } } },
    );
    expect(draft.classes.review?.codexHome).toBe("/default");
    expect(draft.classes.implementation?.codexHome).toBe("/invoking/inherit");
  });
  it.each([
    "review=",
    "typo=/valid",
    "review",
    "review=/bad\npath",
    "review=/",
    "review=/a\u001bb",
  ])("rejects invalid selector %j", (flag) => {
    expect(() => homeDraft({ agentCodexHome: [flag] })).toThrow();
  });
  it("rejects unknown saved classes and duplicate flags", () => {
    expect(() =>
      homeDraft({}, { schemaVersion: 1, classes: { implementor: { codexHome: "/a" } } }),
    ).toThrow();
    expect(() => homeDraft({ agentCodexHome: ["review=/a", "review=/b"] })).toThrow(/Duplicate/);
  });
});
describe("private account configuration", () => {
  it("loads and saves beneath symlinked ancestors while refusing a symlinked final file", async () => {
    const parent = await root();
    const target = join(parent, "dotfiles");
    await mkdir(target, { mode: 0o700 });
    const alias = join(parent, ".config");
    await symlink(target, alias);
    const path = join(alias, "epicd", "accounts.json");
    const preferences = AccountPreferencesSchema.parse({
      schemaVersion: 1,
      defaultCodexHome: "~/main",
    });
    await saveAccountPreferences(preferences, path);
    expect(await loadAccountPreferences(path, true)).toEqual(preferences);
    expect(await readFile(join(target, "epicd", "accounts.json"), "utf8")).toContain("~/main");
    const custom = join(alias, "custom.json");
    await saveAccountPreferences(preferences, custom);
    expect(await loadAccountPreferences(custom, true)).toEqual(preferences);
    await rename(path, join(alias, "epicd", "real.json"));
    await symlink("real.json", path);
    await expect(loadAccountPreferences(path, true)).rejects.toThrow(/non-symlink/);
    await expect(saveAccountPreferences(preferences, path)).rejects.toThrow();
  });
  it("distinguishes malformed JSON, unknown classes and insecure permissions without leaking values", async () => {
    const path = join(await root(), "accounts.json");
    await writeFile(path, '{"secret":"private-value",', { mode: 0o600 });
    await expect(loadAccountPreferences(path)).rejects.toThrow(/Malformed JSON/);
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        classes: { implementor: { codexHome: "/private-value" } },
      }),
    );
    const error = await loadAccountPreferences(path).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("implementor");
    expect(String(error)).toContain("implementation, review");
    expect(String(error)).not.toContain("private-value");
    await writeFile(path, '{"schemaVersion":1}');
    await chmod(path, 0o644);
    await expect(loadAccountPreferences(path)).rejects.toThrow(/mode 0600/);
  });
  it("treats a missing default as empty but rejects explicit missing and malformed files", async () => {
    const path = join(await root(), "accounts.json");
    expect(await loadAccountPreferences(path)).toEqual({
      schemaVersion: 1,
      defaultCodexHome: null,
      classes: {},
    });
    await expect(loadAccountPreferences(path, true)).rejects.toThrow(/Cannot read/);
    await writeFile(path, "invalid", { mode: 0o600 });
    await expect(loadAccountPreferences(path)).rejects.toThrow(/Cannot read/);
  });
  it("atomically replaces an owned config with mode 0600 and preserves other files", async () => {
    const parent = await root(),
      path = join(parent, "settings", "accounts.json");
    const preferences = AccountPreferencesSchema.parse({
      schemaVersion: 1,
      defaultCodexHome: "~/work",
    });
    await saveAccountPreferences(preferences, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(parent, "settings"))).mode & 0o777).toBe(0o700);
    await writeFile(join(parent, "sentinel"), "keep");
    preferences.classes.review = { codexHome: "/review", label: "Review" };
    await saveAccountPreferences(preferences, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(preferences);
    expect(await readFile(join(parent, "sentinel"), "utf8")).toBe("keep");
  });
  it("rejects symlink and shared configuration without overwriting targets", async () => {
    const parent = await root(),
      target = join(parent, "target"),
      path = join(parent, "accounts.json");
    await writeFile(target, "sentinel", { mode: 0o600 });
    await symlink(target, path);
    await expect(
      saveAccountPreferences(AccountPreferencesSchema.parse({ schemaVersion: 1 }), path),
    ).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("sentinel");
    await rm(path);
    await writeFile(path, '{"schemaVersion":1}', { mode: 0o644 });
    await expect(loadAccountPreferences(path)).rejects.toThrow();
    await chmod(path, 0o600);
    expect((await loadAccountPreferences(path)).schemaVersion).toBe(1);
  });
});
describe("frozen credential sources", () => {
  it("pins all effective accounts and routes purposes including both specialist roles", async () => {
    const parent = await root(),
      a = await fakeHome(parent, "a"),
      b = await fakeHome(parent, "b"),
      c = await fakeHome(parent, "c");
    const snapshot = await freezeAccountDraft(
      homeDraft({ codexHome: a, agentCodexHome: [`implementation=${b}`, `review=${c}`] }),
    );
    expect(snapshot.sources).toHaveLength(3);
    for (const [role, purpose, expected] of [
      ["orchestrator", "coordination", a],
      ["implementation", "epic_repair", b],
      ["review", "verification", c],
      ["review", "final_review", c],
      ["review", "specialist", c],
      ["implementation", "specialist", b],
    ] as const)
      expect(accountBinding(snapshot, role, purpose)?.source.codexHome).toBe(expected);
    expect(JSON.stringify(snapshot)).not.toMatch(/access-sentinel|refresh-sentinel|eyJhbG/);
    expect(() => assertAccountStorage(snapshot, [join(c, "workspace")])).toThrow(/outside/);
  });
  it("keeps a canonical alias pinned and projects rotation while rejecting another principal", async () => {
    const parent = await root(),
      a = await fakeHome(parent, "a"),
      b = await fakeHome(parent, "b"),
      alias = join(parent, "alias");
    await symlink(a, alias);
    const draft = await canonicalizeAccountDraft(homeDraft({ codexHome: alias }));
    const snapshot = await freezeAccountDraft(draft),
      binding = accountBinding(snapshot, "implementation", "implementation")!;
    await rm(alias);
    await symlink(b, alias);
    const providerHome = join(parent, "provider");
    await mkdir(providerHome, { mode: 0o700 });
    const launch = CodexLaunchSchema.parse({
      generation: randomUUID(),
      confinement: {
        executable: "/usr/bin/true",
        workspace: "/private/workspace",
        providerHome,
        scratch: "/private/scratch",
        artifacts: "/private/artifacts",
        sourceMode: "workspace-write",
      },
      model: "worker",
      reasoningEffort: "high",
      authCachePath: binding.source.authCachePath,
      accountBinding: binding,
      controlDirectory: "/private/control",
      reviewPacket: null,
    });
    const next = join(a, "replacement");
    await writeFile(next, JSON.stringify(credential("a", "member", "rotated-access")), {
      mode: 0o600,
    });
    await rename(next, join(a, "auth.json"));
    await prepareCodexAccessToken(launch);
    const projected = JSON.parse(await readFile(join(providerHome, "auth.json"), "utf8"));
    expect(projected.tokens.access_token).toBe("rotated-access");
    expect(projected.tokens.refresh_token).toBe("");
    expect(projected.last_refresh).toBe("2026-09-01T00:00:00Z");
    await writeFile(join(a, "auth.json"), JSON.stringify(credential("a", "other-member")), {
      mode: 0o600,
    });
    await expect(prepareCodexAccessToken(launch)).rejects.toThrow(/account changed/);
    expect(await readFile(join(providerHome, "auth.json"), "utf8")).not.toContain("other-member");
  });
  it("rejects unsupported identity metadata", async () => {
    const parent = await root(),
      home = await fakeHome(parent, "a");
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "token", id_token: "not-a-jwt", account_id: "a" } }),
      { mode: 0o600 },
    );
    await expect(freezeAccountDraft(homeDraft({ codexHome: home }))).rejects.toThrow(
      /identity metadata/,
    );
  });
});

it("reports local account validation failures against the editable source field", async () => {
  const parent = await root();
  const main = await fakeHome(parent, "main");
  const review = await fakeHome(parent, "review");
  const missing = homeDraft({
    codexHome: main,
    agentCodexHome: [`review=${join(parent, "missing")}`],
  });
  await expect(validateAccountDraft(missing)).rejects.toMatchObject({
    fields: { review: expect.stringContaining("Directory is missing or unreadable") },
  });
  await writeFile(
    join(review, "auth.json"),
    JSON.stringify({ tokens: { access_token: "private-sentinel" } }),
    { mode: 0o600 },
  );
  const invalid = homeDraft({ codexHome: main, agentCodexHome: [`review=${review}`] });
  const error = await validateAccountDraft(invalid).catch((error) => error);
  expect(error.fields.review).toContain("Unsupported Codex credential identity metadata");
  expect(error.message).not.toContain("private-sentinel");
  const valid = await validateAccountDraft(homeDraft({ codexHome: main }));
  expect(valid.mode).toBe("homes");
});
