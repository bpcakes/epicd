import { frozenAccountSummary } from "./domain/accounts.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Tracer from "effect/Tracer";
import { KernelGit } from "./adapters/kernel-git.js";
import { KernelBeads } from "./adapters/kernel-beads.js";
import { PublicationGit } from "./adapters/publication-git.js";
import { resolveExecutableEffect } from "./adapters/runtime-discovery.js";
import { StateStore, runStateDecodeDetail, type StoredRunInspection } from "./adapters/store.js";
import type { CommonGitDirectory, IssueStatus, RuntimeKind } from "./domain/types.js";
import type { DiscoveredEpic, EpicPageRequest } from "./domain/epic-discovery.js";
import { redactSensitiveText } from "./util/redact.js";

export type EpicBrowserAction =
  | { kind: "start" }
  | {
      kind: "resume" | "control";
      runId: string;
      controlVersion: number;
      status: string;
      runtime: RuntimeKind;
      accounts?: string[];
    }
  | { kind: "unavailable"; reason: string; runId: string | null };
export type EpicBrowserItem = {
  epic: { id: string; title: string | null; priority: number | null; status: IssueStatus | null };
  parentIds: string[] | null;
  notice: string | null;
  action: EpicBrowserAction;
};
export type EpicBrowserSnapshot = {
  repoPath: string;
  commonDirectory: CommonGitDirectory;
  epics: DiscoveredEpic[];
  items: EpicBrowserItem[];
  offset: number;
  nextOffset: number | null;
};

const runIdentity = (entry: StoredRunInspection) => (entry.kind === "valid" ? entry.state : entry);

/** Saved-run capabilities depend on the journal, never on tracker payload availability. */
function savedRunAction(
  store: StateStore,
  saved: StoredRunInspection,
): Exclude<EpicBrowserAction, { kind: "start" }> {
  if (saved.kind === "invalid")
    return {
      kind: "unavailable",
      runId: saved.runId,
      reason: `Run ${saved.runId} has invalid saved state: ${runStateDecodeDetail(saved.error)}. Inspect it before starting work.`,
    };
  const control = store.orchestration.control(saved.state.runId);
  const lease = store.controllerLease(saved.state.runId);
  return {
    kind:
      lease?.alive ||
      control.status === "awaiting_user" ||
      store.orchestration.pendingEscalation(saved.state.runId)
        ? "control"
        : "resume",
    runId: saved.state.runId,
    controlVersion: control.controlVersion,
    status: control.status,
    runtime: saved.state.runtime,
    accounts: frozenAccountSummary(saved.state.runtimeConfiguration),
  };
}

/** Projects choices from current journal ownership without changing control state. */
export function epicBrowserItems(
  store: StateStore,
  repoPath: string,
  commonDirectory: CommonGitDirectory,
  epics: DiscoveredEpic[],
): EpicBrowserItem[] {
  const owner = store.inspectWorkflowOwner(repoPath, commonDirectory);
  const items: EpicBrowserItem[] = epics.map((epic) => {
    const saved = owner
      ? runIdentity(owner).epicId === epic.id
        ? owner
        : null
      : store.inspectRecoverable(repoPath, epic.id);
    const action: EpicBrowserAction = saved
      ? savedRunAction(store, saved)
      : owner
        ? {
            kind: "unavailable",
            runId: null,
            reason: `Run ${runIdentity(owner).runId} for ${runIdentity(owner).epicId} already owns this repository. Select that epic to continue.`,
          }
        : epic.details === "available"
          ? { kind: "start" }
          : {
              kind: "unavailable",
              runId: null,
              reason:
                epic.details === "budget_exhausted"
                  ? "This page reached its detail read budget. Search for this epic's ID to load it separately before starting a new run."
                  : "This epic's details are too large to load for a new run. Inspect this epic with br before starting it.",
            };
    return {
      epic: { id: epic.id, title: epic.title, priority: epic.priority, status: epic.status },
      parentIds: epic.parentIds,
      notice:
        epic.details === "budget_exhausted"
          ? "Tracker details and hierarchy were not loaded within this page's read budget."
          : epic.details === "too_large"
            ? "Tracker details and hierarchy could not be loaded."
            : null,
      action,
    };
  });
  // Saved identity is independent of the current tracker page; unknown fields stay unknown.
  if (owner && !items.some((item) => item.epic.id === runIdentity(owner).epicId)) {
    const identity = runIdentity(owner);
    items.unshift({
      epic: {
        id: identity.epicId,
        title: owner.kind === "valid" ? owner.state.epicTitle : null,
        priority: null,
        status: null,
      },
      parentIds: null,
      notice: "Saved run; tracker metadata is not on this page.",
      action: savedRunAction(store, owner),
    });
  }
  return items;
}

const browserStages = {
  resolve_repository: ["resolving the Git repository", "Check --repo points to a Git repository."],
  bind_repository: ["checking repository access", "Check repository access and retry."],
  resolve_tracker: ["locating Beads", "Check br is installed, or set --tracker-path."],
  read_tracker: ["reading Beads", "Check Beads is initialized for this repository and retry."],
  project_runs: ["reading saved runs", "Inspect the saved run state before retrying."],
} as const;
type BrowserStage = keyof typeof browserStages;

export class EpicBrowserLoadFailed extends Data.TaggedError("EpicBrowserLoadFailed")<{
  readonly stage: BrowserStage;
  readonly cause: unknown;
  readonly message: string;
}> {
  constructor(options: { stage: BrowserStage; cause: unknown }) {
    const [activity, advice] = browserStages[options.stage];
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super({
      ...options,
      message: `Could not load epics while ${activity}: ${redactSensitiveText(detail)}. ${advice}`,
    });
  }
}
export type EpicBrowserOptions = { repo: string; trackerPath?: string } & EpicPageRequest;

/** Optional CLI diagnostics expose only known stage names, durations and outcomes. */
export function browserTimingTracer(report: (line: string) => void): Tracer.Tracer {
  const names = new Set([
    "epic.browser.load",
    ...Object.keys(browserStages).map((stage) => `epic.browser.${stage}`),
  ]);
  return Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (at, exit) => {
        end(at, exit);
        if (!names.has(options.name)) return;
        const duration = (Number(at - options.startTime) / 1_000_000).toFixed(1);
        try {
          report(`[epicd] ${options.name} ${duration}ms ${Exit.isFailure(exit) ? "failed" : "ok"}`);
        } catch {
          // Diagnostic output cannot change discovery or resource-settlement outcomes.
        }
      };
      return span;
    },
  });
}

function read<A>(
  stage: EpicBrowserLoadFailed["stage"],
  signal: AbortSignal,
  run: () => Promise<A>,
) {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: () => {
        signal.throwIfAborted();
        return run();
      },
      catch: (cause) => new EpicBrowserLoadFailed({ stage, cause }),
    }),
  ).pipe(Effect.withSpan(`epic.browser.${stage}`));
}

/** Lazy reads only. Legacy adapters retain cancellation, physical stop, and deadline ownership. */
export function loadEpicBrowserEffect(
  store: StateStore,
  options: EpicBrowserOptions,
  signal: AbortSignal,
): Effect.Effect<EpicBrowserSnapshot, EpicBrowserLoadFailed> {
  return Effect.gen(function* () {
    const input = yield* read("resolve_repository", signal, () => realpath(resolve(options.repo)));
    const top = yield* read("resolve_repository", signal, () =>
      new KernelGit(input).text(["rev-parse", "--show-toplevel"], { signal }),
    );
    const repoPath = yield* read("resolve_repository", signal, () => realpath(top.trim()));
    const repository = yield* read("bind_repository", signal, () =>
      new PublicationGit().bind(repoPath, signal),
    );
    const executable = yield* Effect.mapError(
      Effect.uninterruptible(resolveExecutableEffect(options.trackerPath ?? "br")),
      ({ cause }) => new EpicBrowserLoadFailed({ stage: "resolve_tracker", cause }),
    ).pipe(Effect.withSpan("epic.browser.resolve_tracker"));
    const tracker = new KernelBeads(executable);
    const binding = yield* read("read_tracker", signal, () => tracker.bind(repoPath));
    const page = yield* read("read_tracker", signal, () =>
      tracker.listOpenEpics(binding, signal, options),
    );
    const items = yield* Effect.try({
      try: () => {
        signal.throwIfAborted();
        return epicBrowserItems(store, repoPath, repository.commonDirectory, page.epics);
      },
      catch: (cause) => new EpicBrowserLoadFailed({ stage: "project_runs", cause }),
    }).pipe(Effect.withSpan("epic.browser.project_runs"));
    yield* Effect.annotateCurrentSpan({
      "page.epics": page.epics.length,
      "page.has_next": page.nextOffset !== null,
      "page.details_unavailable": page.epics.filter((epic) => epic.details !== "available").length,
    });
    return {
      repoPath,
      commonDirectory: repository.commonDirectory,
      epics: page.epics,
      offset: page.offset,
      nextOffset: page.nextOffset,
      items,
    };
  }).pipe(
    Effect.withSpan("epic.browser.load", {
      attributes: {
        "page.offset": options.offset ?? 0,
        "search.active": Boolean(options.search?.trim()),
      },
    }),
  );
}

/** One Promise boundary, preserving the original rejection and awaiting the adapter's settlement. */
export async function loadEpicBrowser(
  store: StateStore,
  options: EpicBrowserOptions,
  signal: AbortSignal,
): Promise<EpicBrowserSnapshot> {
  const result = await Effect.runPromise(
    Effect.result(loadEpicBrowserEffect(store, options, signal)),
  );
  if (Result.isFailure(result)) throw result.failure.cause;
  return result.success;
}

/** Confirmation belongs to one observed choice; never silently turn start into resume or attach. */
export function assertEpicBrowserSelection(
  store: StateStore,
  snapshot: EpicBrowserSnapshot,
  selected: EpicBrowserItem,
) {
  const current = epicBrowserItems(
    store,
    snapshot.repoPath,
    snapshot.commonDirectory,
    snapshot.epics,
  ).find((item) => item.epic.id === selected.epic.id);
  if (current?.action.kind === "unavailable") throw new Error(current.action.reason);
  const before = selected.action,
    after = current?.action;
  // Opening a console is read-only. Its commands obtain their own fresh control versions.
  const unchanged =
    before.kind === "control"
      ? (after?.kind === "control" || after?.kind === "resume") && after.runId === before.runId
      : before.kind === "resume"
        ? after?.kind === "resume" &&
          after.runId === before.runId &&
          after.controlVersion === before.controlVersion &&
          after.status === before.status &&
          after.runtime === before.runtime
        : before.kind === "start" && after?.kind === "start";
  if (!unchanged)
    throw new Error("Run status changed. Review the refreshed epic list before confirming again.");
}
