import { z } from "zod";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export const ACCOUNT_CLASSES = [
  "orchestrator",
  "implementation",
  "review",
  "verification",
  "final_review",
  "epic_repair",
  "specialist",
] as const;
export const AccountClassSchema = z.enum(ACCOUNT_CLASSES);
export type AccountClass = z.infer<typeof AccountClassSchema>;
const printable = /^[^\u0000-\u001f\u007f-\u009f]*$/;
export const AccountPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(printable)
  .refine((p) => p !== "/");
const PreferenceSchema = z.strictObject({
  codexHome: AccountPathSchema,
  label: z.string().max(80).regex(printable).optional(),
});
export const AccountPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  defaultCodexHome: AccountPathSchema.nullable().default(null),
  classes: z.partialRecord(AccountClassSchema, PreferenceSchema.nullable()).default({}),
});
export type AccountPreferences = z.infer<typeof AccountPreferencesSchema>;
export type AccountRole = "orchestrator" | "implementation" | "review";
export type AccountOrigin = "file" | "environment" | "cli" | "tui" | "default";
export type ResolvedAccount = {
  codexHome: string;
  label: string;
  origin: AccountOrigin;
  inheritedFrom: AccountClass | "default" | null;
};
export type AccountDraft = {
  mode: "homes";
  preferences: AccountPreferences;
  defaultAccount: ResolvedAccount;
  classes: Record<AccountClass, ResolvedAccount | null>;
};
export type AccountOverrides = {
  codexHome?: string;
  agentCodexHome?: string[];
};

export type AccountField = AccountClass | "default";
export class AccountDraftValidationError extends Error {
  constructor(readonly fields: Partial<Record<AccountField, string>>) {
    super(
      Object.entries(fields)
        .map(([field, message]) => `${field}: ${message}`)
        .join("; "),
    );
    this.name = "AccountDraftValidationError";
  }
}

/** Point an inherited source error at the preference the operator can actually edit. */
export function accountInputField(draft: AccountDraft, key: AccountClass): AccountField {
  if (draft.preferences.classes[key]) return key;
  if (key === "verification" || key === "final_review") return accountInputField(draft, "review");
  if (key === "epic_repair") return accountInputField(draft, "implementation");
  return "default";
}

export function sameAccountPreferences(a: AccountPreferences, b: AccountPreferences): boolean {
  const normalized = (p: AccountPreferences) => [
    p.defaultCodexHome,
    ACCOUNT_CLASSES.map((key) => {
      const entry = p.classes[key];
      return entry ? [entry.codexHome, entry.label ?? ""] : null;
    }),
  ];
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

export function expandAccountPath(path: string, base: string, operatorHome: string): string {
  AccountPathSchema.parse(path);
  const expanded =
    path === "~"
      ? operatorHome
      : path.startsWith("~/")
        ? resolve(operatorHome, path.slice(2))
        : resolve(base, path);
  return AccountPathSchema.parse(expanded);
}

/** Preserve portable spelling, but rebase invocation-relative paths before saving beside a config. */
function preferencePath(path: string, cwd: string, operatorHome: string) {
  AccountPathSchema.parse(path);
  return isAbsolute(path) || path === "~" || path.startsWith("~/")
    ? path
    : expandAccountPath(path, cwd, operatorHome);
}

/** Pure resolution; filesystem canonicalization happens before displaying or freezing a draft. */
export function resolveAccountDraft(input: {
  preferences: AccountPreferences;
  configPath: string;
  cwd: string;
  operatorHome: string;
  environmentHome?: string;
  overrides?: AccountOverrides;
  origin?: "cli" | "tui";
}): AccountDraft {
  const overrides = input.overrides ?? {};
  const preferences = AccountPreferencesSchema.parse(input.preferences);
  const classes = { ...preferences.classes };
  const explicit = new Set<AccountClass>();
  for (const flag of overrides.agentCodexHome ?? []) {
    const separator = flag.indexOf("=");
    if (separator < 1) throw new Error("Expected --agent-codex-home class=path");
    const key = AccountClassSchema.parse(flag.slice(0, separator));
    if (explicit.has(key)) throw new Error(`Duplicate account selector: ${key}`);
    explicit.add(key);
    const path = flag.slice(separator + 1);
    classes[key] = path === "inherit" ? null : { codexHome: AccountPathSchema.parse(path) };
  }
  const selectedDefault =
    overrides.codexHome ?? preferences.defaultCodexHome ?? input.environmentHome ?? "~/.codex";
  const origin: AccountOrigin =
    overrides.codexHome !== undefined
      ? (input.origin ?? "cli")
      : preferences.defaultCodexHome !== null
        ? "file"
        : input.environmentHome !== undefined
          ? "environment"
          : "default";
  const make = (path: string, origin: AccountOrigin, label?: string): ResolvedAccount => {
    const codexHome = expandAccountPath(
      path,
      origin === "file" ? dirname(input.configPath) : input.cwd,
      input.operatorHome,
    );
    return { codexHome, origin, label: label || basename(codexHome), inheritedFrom: null };
  };
  const defaultAccount = make(selectedDefault, origin);
  const resolved = {} as Record<AccountClass, ResolvedAccount | null>;
  for (const key of ACCOUNT_CLASSES) {
    const entry = classes[key];
    if (entry)
      resolved[key] = make(
        entry.codexHome,
        explicit.has(key) ? (input.origin ?? "cli") : "file",
        entry.label,
      );
    else if (key === "specialist") resolved[key] = null;
    else {
      const parent =
        key === "verification" || key === "final_review"
          ? "review"
          : key === "epic_repair"
            ? "implementation"
            : "default";
      resolved[key] = {
        ...(parent === "default" ? defaultAccount : resolved[parent]!),
        inheritedFrom: parent,
      };
    }
  }
  return {
    mode: "homes",
    preferences: {
      schemaVersion: 1,
      defaultCodexHome:
        overrides.codexHome !== undefined
          ? preferencePath(overrides.codexHome, input.cwd, input.operatorHome)
          : preferences.defaultCodexHome,
      classes: Object.fromEntries(
        ACCOUNT_CLASSES.map((key) => {
          const entry = classes[key];
          return [
            key,
            entry
              ? {
                  ...entry,
                  codexHome: explicit.has(key)
                    ? preferencePath(entry.codexHome, input.cwd, input.operatorHome)
                    : entry.codexHome,
                }
              : null,
          ];
        }),
      ),
    },
    defaultAccount,
    classes: resolved,
  };
}

const CanonicalAccountPathSchema = AccountPathSchema.refine(
  (path) => isAbsolute(path) && resolve(path) === path,
);
export const AccountSourceSchema = z.strictObject({
  bindingId: z.string().regex(/^[a-f0-9]{64}$/),
  principalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  codexHome: CanonicalAccountPathSchema,
  authCachePath: CanonicalAccountPathSchema,
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
  label: z.string().max(80).regex(printable),
});
export const AccountBindingSchema = z.strictObject({
  accountClass: AccountClassSchema,
  source: AccountSourceSchema,
});
export type AccountSource = z.infer<typeof AccountSourceSchema>;
export type AccountBinding = z.infer<typeof AccountBindingSchema>;
export const AccountSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mode: z.literal("homes"),
    sources: z.array(AccountSourceSchema),
    classes: z.record(AccountClassSchema, z.string().nullable()),
    provenance: z.record(
      AccountClassSchema,
      z.strictObject({
        origin: z.enum(["file", "environment", "cli", "tui", "default"]),
        inheritedFrom: z.union([AccountClassSchema, z.literal("default")]).nullable(),
      }),
    ),
  })
  .superRefine((snapshot, context) => {
    const ids = new Set(snapshot.sources.map((source) => source.bindingId));
    if (ids.size !== snapshot.sources.length)
      context.addIssue({ code: "custom", message: "Account sources must have unique bindings" });
    for (const key of ACCOUNT_CLASSES) {
      const id = snapshot.classes[key];
      if ((id !== null && !ids.has(id)) || (key !== "specialist" && id === null))
        context.addIssue({
          code: "custom",
          path: ["classes", key],
          message: "Account class must reference its frozen source",
        });
    }
  });
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;
export function accountBinding(
  snapshot: AccountSnapshot,
  role: AccountRole,
  purpose: string,
): AccountBinding | undefined {
  const accountClass = AccountClassSchema.parse(
    purpose === "coordination" ? "orchestrator" : purpose,
  );
  const id =
    snapshot.classes[accountClass] ??
    (accountClass === "specialist" ? snapshot.classes[role] : null);
  if (id === null) {
    throw new Error(`Missing frozen account for ${accountClass}`);
  }
  const source = snapshot.sources.find((source) => source.bindingId === id);
  if (!source) throw new Error(`Missing frozen account source for ${accountClass}`);
  return { accountClass, source };
}

export function editAccountDraft(
  draft: AccountDraft,
  key: AccountClass | "default",
  path: string | null,
  context: { configPath: string; cwd: string; operatorHome: string; environmentHome?: string },
): AccountDraft {
  const preferences = structuredClone(draft.preferences);
  if (key === "default") preferences.defaultCodexHome = path;
  else
    preferences.classes[key] =
      path === null ? null : { codexHome: preferencePath(path, context.cwd, context.operatorHome) };
  if (key === "default" && path !== null)
    preferences.defaultCodexHome = preferencePath(path, context.cwd, context.operatorHome);
  const next = resolveAccountDraft({ ...context, preferences });
  next.defaultAccount.origin =
    key === "default" && path !== null
      ? "tui"
      : key === "default"
        ? next.defaultAccount.origin
        : draft.defaultAccount.origin;
  for (const accountClass of ACCOUNT_CLASSES) {
    const entry = next.classes[accountClass];
    if (!entry) continue;
    if (entry.inheritedFrom)
      entry.origin =
        entry.inheritedFrom === "default"
          ? next.defaultAccount.origin
          : next.classes[entry.inheritedFrom]!.origin;
    else
      entry.origin =
        key === accountClass ? "tui" : (draft.classes[accountClass]?.origin ?? entry.origin);
  }
  return next;
}

/** Operator-only paths; model-facing inspection receives just class and label. */
export function frozenAccountSummary(
  configuration: { accounts: AccountSnapshot } | null,
): string[] {
  if (!configuration) return ["Accounts: no runtime configuration"];
  const snapshot = configuration.accounts;
  if (!snapshot) return ["Accounts: no account selections recorded"];
  return ACCOUNT_CLASSES.map((key) => {
    const id = snapshot.classes[key];
    const source = snapshot.sources.find((source) => source.bindingId === id);
    return `${key}: ${source?.codexHome ?? "inherits assignment role"}`;
  });
}
