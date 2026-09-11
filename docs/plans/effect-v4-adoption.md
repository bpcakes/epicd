# Effect v4: first adoption steps

Investigated 2026-09-09 on `feature/always-engaged-orchestrator`, at HEAD
`2ec237f`, including the existing uncommitted workspace-inspection and recovery
changes. The initial pilot and subsequent slices are implemented; see the
current status and historical implementation records below.

## Current status — 2026-09-10

Baseline verified against `33eef1e2094193b2731c11d2849ab1747f6ec6d1`;
the account-session and preference-save follow-up below is implemented on top of it:

| Area                                        | Status                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Doctor                                      | Implemented: lazy typed checks with the existing Promise rejection contract.                                                |
| Shared runtime discovery                    | Implemented: composable Effects and Promise adapters for existing callers.                                                  |
| Epic browser discovery                      | Implemented: typed stages, bounded tracker pages, and optional safe timing traces.                                          |
| Repository policy and run creation          | Implemented: scoped temporary files, read-only policy preflight, and sequential creation.                                   |
| Epic picker and browser loop                | Implemented: scoped Ink and signal-handler lifetimes; controller launch remains Promise-based.                              |
| Account editor session                      | Implemented in the follow-up: Deferred selection, scoped Ink/listeners, and explicit pending-operation drain.               |
| Account preferences saving                  | Implemented in the follow-up: scoped handles and temporary-file cleanup, typed failures, and interruption-safe publication. |
| Receipt reader                              | Evaluated; retain its existing `try/finally`. Reconsider only when a composed read operation needs the scope.               |
| Controller concurrency and durable recovery | Deferred; require a separate proposal preserving original stop proof and settlement.                                        |

The initial investigation, Steps 1 and 2, and dated implementation records below
preserve the reasoning and validation history. They are not instructions to repeat
completed work. The receipt-reader evaluation is also complete. Controller
concurrency and durable recovery remain deferred beyond the recorded slices.

## Version and compatibility

- The repository pins `effect@4.0.0-rc.112` in `package.json` and the lockfile.
  The 2026-09-09 investigation observed `rc = 4.0.0-rc.112`,
  `beta = 4.0.0-beta.107`, and `latest = 3.22.2`. The 2026-09-10 audit observed
  `rc = 4.0.0-rc.113`; that registry change does not change this repository's pin.
  Any dependency upgrade is a separate change requiring validation.
- Effect v4 is a release candidate. Its current requirements are TypeScript 5.9+,
  strict checking, and generally Node 18+. This repository already uses
  TypeScript 5.9.3, strict NodeNext/ES2023, and Node 22.12+.
  [Official requirements](https://github.com/Effect-TS/effect/blob/main/README.md)
- Use the [v4 documentation](https://effect.website/docs/v4/)
  and [RC API reference](https://effect.website/docs/v4/api/effect/Effect).
  These URLs select v4 but follow newer RC releases; the API reference displayed
  `4.0.0-rc.113` at the 2026-09-10 audit. Check APIs against the installed
  `node_modules/effect` types/source for the repository's exact pin, and typecheck
  examples locally. Older examples can also use incompatible APIs. Services use `Context.Service`;
  typed failure recovery includes `Effect.catchTag`; success/failure values use
  `Effect.result` and `Result`.
  [Context API](https://effect.website/docs/v4/api/effect/Context)
- Use static module imports such as `import * as Effect from "effect/Effect"`
  throughout the migration. Focused imports avoid evaluating unrelated modules
  through the root barrel. Consider lazy loading only if measured CLI startup
  warrants it.
- The adoption currently uses only the `effect` dependency. Ordinary Vitest can await its programs.
  Add `@effect/vitest` or platform integrations only for an actual later need,
  with versions matching the core package. CLI, process, and SQL integrations
  include `effect/unstable/*` modules with different stability commitments.
  [Package organization](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)

Registry checks: `npm view effect dist-tags --json` and
`npm view effect@rc version engines peerDependencies --json`. These inspect the
moving registry tags. Use `npm ls effect --depth=0` to check the installed version.
The original isolated installation check used `4.0.0-rc.112`.

## Initial adoption assessment — historical

| Area             | Evidence in this tree                                                                                                                               | Adoption decision                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Doctor           | `src/doctor.ts` sequences executable selection, version verification, and optional Herdr discovery; the CLI awaits one Promise and prints JSON.     | First pilot: small, useful failure boundaries and no journal mutations.                   |
| Shared discovery | `src/bootstrap.ts` also calls these helpers during creation and handoff.                                                                            | Reuse the existing helpers from doctor; avoid spreading Effect into startup in the pilot. |
| File lifetime    | `readCommandStop` in `src/adapters/command-lifetime.ts` opens private I/O, reads and validates one receipt, and closes the descriptor in `finally`. | Possible second slice for scoped resource ownership, after current edits settle.          |
| Controller       | `src/controller.ts` orders interruption, draining, escalation, repository release, and lease release.                                               | Valuable eventual target, but a much larger behavioral change.                            |
| Orchestrator     | `src/orchestrator/loop.ts` coordinates polling, health checks, decision attempts, and concurrent actions.                                           | Later structured-concurrency work must retain journal identities and retry admission.     |
| Schemas/storage  | Zod describes domain records and decisions; `src/adapters/store.ts` uses synchronous SQLite transactions.                                           | Preserve schemas, serialized records, and transaction boundaries during initial adoption. |

At investigation time, the working tree contained extensive edits in command lifetime, inspection,
publication, disposal, and recovery. Doctor is outside those edits. There are
bootstrap/discovery tests, but no direct `runDoctor` or doctor CLI cases existed.

## Step 1: establish the doctor contract — completed

Add `test/doctor.test.ts` and doctor-specific CLI cases to
`test/cli.integration.test.ts`. Keep these with the migration as one small PR;
run the observable contract tests against the current implementation first.

Use temporary executable fixtures and the existing discovery fixture patterns in
`test/bootstrap.test.ts`. Exercise the real command boundary without an
authenticated model or a running Herdr instance:

- SDK mode with an explicit executable returns the existing JSON fields,
  including `herdr: null`, the version, model, reasoning, fallback flag and warning.
- Herdr mode resolves the exact session and workspace from fixture responses.
  SDK mode must not invoke Herdr discovery.
- Missing executable, failing version command, and incompatible/ambiguous Herdr
  discovery fail without running subsequent stages or selecting a fallback.
- The CLI still prints JSON on success and a redacted `epicd:` diagnostic with
  exit code 1 on failure. Use an adversarial fixture diagnostic to check redaction.
- Fixture invocation logs show only the expected discovery commands. Doctor
  creates no state database and changes no repository files.

These assertions protect observable behavior through the implementation change;
they should not merely assert that a particular Effect combinator was called.

## Step 2: implement the doctor pilot — completed

Depends on the contract checks above. Add the pinned dependency and change
`src/doctor.ts`; retain the existing `runDoctor(options): Promise<...>` boundary
used by `src/cli.tsx`.

1. Define `DoctorOptions`, the unchanged result shape, and one tagged
   `DoctorCheckFailed` error with a `stage` discriminator and original
   `cause: unknown`. Stages should identify executable selection, version check,
   Herdr executable lookup, and Herdr discovery. A failed stage is useful typed
   information; it does not imply retryability.
2. Build a lazy `doctorEffect` using `Effect.gen`, wrapping each existing Promise
   helper with `Effect.tryPromise`. Keep the original sequential order and
   conditional Herdr branch. Wrap individual I/O calls so failures retain their
   stage; wrapping the entire old `runDoctor` would provide little useful structure.
3. Use a small explicit dependency object if needed to test stage failures and
   short-circuiting. There is only one consumer, so a service/layer hierarchy is
   unnecessary here. Keep the effect and its supporting types local to doctor.
4. Execute once at `runDoctor`. Preserve legacy rejection values deliberately,
   rather than exposing a new runtime error format to CLI users. The following
   boundary pattern was checked against the pinned RC:

   ```ts
   const outcome = await Effect.runPromise(Effect.result(doctorEffect(options)));
   if (Result.isFailure(outcome)) throw outcome.failure.cause;
   return outcome.success;
   ```

5. Keep defects distinct from expected failures. `Effect.result` captures the
   typed failure channel; it is not a blanket conversion of defects or interruption
   into successful diagnostic output.

Do not add outer timeouts, retries, concurrency, or a cancellation API in this
pilot. The existing discovery helpers own their deadlines, and several do not
accept an AbortSignal. Running an Effect around them does not add safe process
cancellation. Keep Commander, Ink, Zod, SQLite, the SDK and runtime drivers as-is.

Acceptance: the same doctor JSON and CLI diagnostics, explicit internal failure
stages, short-circuit behavior, one execution per call, and no added lifecycle
machinery. Reverting this pilot should only require its doctor/tests/package diff.

Validate with the repository commands:

```sh
npm run build
npm run typecheck
npm test -- test/doctor.test.ts test/cli.integration.test.ts test/bootstrap.test.ts
npm run format:check
```

The build matters because CLI integration tests execute `dist/cli.js`. The normal
CI suite remains the merge check. Record unrelated failures against the existing
working-tree baseline rather than silently changing them in this pilot.

## Receipt-read lifetime — evaluated, migration deferred

The evaluation retained `readCommandStop` as written; see the 2026-09-09
implementation record. The criteria below apply only if a later composed read
operation justifies revisiting `Effect.acquireUseRelease` or a scoped acquisition.
The resource to release is its local file descriptor. Reading a
receipt and releasing a descriptor must retain the existing Promise result and
receipt validation behavior.

Before replacing its `try/finally`, specify and test acquisition failure, missing
receipt, malformed/foreign receipt, close-on-success, close-on-read-failure, and
the existing precedence when both reading and closing fail. Effect finalizer
failure semantics need explicit treatment; a textual `finally` replacement is
insufficient. Include real file/receipt tests and use fault injection only for
otherwise inaccessible close failures.

Keep `recoverCommandStop` outside this slice: it can claim the exclusive unused
dispatch gate, so it is not merely another read. Neither scoped release nor fiber
completion authorizes workspace release or changes a command's recorded outcome.
Use `test/command-lifetime.integration.test.ts` and the focused new read cases,
after a build, as its validation scope. If this makes the small reader harder to
understand, retain its current implementation and stop expansion there.

## Boundary to preserve before broader adoption

The branch distinguishes cancellation requests, physical stop evidence, durable
settlement, and current eligibility. See
[workspace inspection contracts](../workspace-inspection-contracts.md),
`runWorkspaceInspectionIO` in `src/adapters/workspace-inspection-io.ts`, and the
controller's shutdown `finally` block.

Effect fibers and scopes describe in-process lifetimes. They do not replace the
supervisor's stop receipts, durable journal, ownership fences or cold recovery.
Automatic retries must not replay publication, commits, tracker mutations,
workspace creation/disposal, or indeterminate coordinator attempts. Existing
SQLite transactions must stay synchronous and atomic.

An isolated RC probe compiled with this repository's TypeScript compiler and
strict NodeNext/ES2023 settings. It verified lazy execution, tagged Promise
failure mapping, preservation of the original rejection through the boundary
above, and a critical cancellation case: interrupting `runPromiseExit` aborted
the signal passed to `tryPromise` and completed the fiber while a controlled
legacy Promise remained unresolved. Forwarding a signal alone therefore does
not prove that existing I/O has drained.

Before migrating a durable worker or the controller, design an adapter that
requests interruption and waits for the existing settlement/stop-proof path,
including unknown-stop outcomes and cleanup errors. That deserves a separate
proposal grounded in the process and crash-recovery tests.

## Implementation record, 2026-09-09

The initial investigation used source review and an isolated API probe. The doctor
pilot subsequently added the exact `effect@4.0.0-rc.112` dependency and a lazy
`doctorEffect` in `src/doctor.ts`, with four tagged failure stages. `runDoctor`
retains its Promise API and rethrows each original failure value. The Effect
program and its types are exported from the doctor module for composition and
focused tests; shared discovery functions remain unchanged.

Real executable fixtures cover the SDK report, exact Herdr discovery, missing
executables, version failure, incompatible/ambiguous endpoints, command order,
filesystem preservation, and redacted CLI errors. Fault injection at the existing
I/O helpers checks laziness, each failure stage, short-circuiting, and preservation
of Error, object, null, and string rejections. No model or live Herdr is required.

The pre-migration baseline passed all 29 selected tests. The migrated version
passed all 33 selected tests. Build, typecheck, and formatting checks passed.
These are focused checks, not a full-suite or authenticated runtime result.

The receipt-reader candidate was evaluated and retained as written: its single
descriptor already has a short `try/finally` with explicit close-error precedence.
Adding acquisition, typed read/close failures and a Promise bridge would expand
that function without a current composed Effect consumer. Revisit it when a
larger read-only Effect operation can own the scope. Controller concurrency and
durable recovery remain future work.

## Shared runtime discovery, 2026-09-09

The next slice on `chore/effects-v4` moves executable resolution, SDK native
selection, selected-installation validation, and Herdr discovery into
`src/adapters/runtime-discovery.ts`. Each operation has a lazy `*Effect` function.
Filesystem calls, JSON parsing, Zod validation, and command failures enter the
typed `RuntimeDiscoveryError` channel with their operation and original cause.
The operation identifies the public discovery API: both Codex selection APIs
report `select_codex`, including delegated executable-resolution failures.
Direct executable resolution reports `resolve_executable`, and Herdr discovery
reports `discover_herdr`. Normalizing the operation preserves the original cause.

Doctor now composes those Effects directly. The discovery module also exposes
Promise adapters, re-exported from bootstrap to preserve existing callers.
Bootstrap and handoff retain their check order; no discovery step executes a
nested Effect runtime. Promise boundaries preserve original rejection values,
and doctor retains its four existing failure stages.

The command runners still own deadlines and process cleanup. No services, layers,
new dependencies, retries, or cancellation guarantees were introduced. Zod and
the persistent state format are unchanged.

Tests add the default SDK doctor path and successful Herdr CLI serialization,
plus direct discovery checks for lazy PATH resolution, expected candidate
fallback, unexpected filesystem failures, invalid npm manifests, malformed
Herdr responses, and original command rejection identity. The baseline with
the new doctor/CLI cases passed 54 tests across doctor, CLI, bootstrap, and
runtime handoff before extraction.

Four additional regression cases cover the public operation label for explicit
entrypoint, SDK payload, default SDK selection, and selected npm payload failures,
including original cause identity through normalization and Promise rejection.

After extraction and operation-label normalization, all 69 tests passed across those four files plus
`test/runtime-discovery.test.ts`. Build, typecheck, repository formatting, and
diff checks passed. The build ran before typechecking and integration tests
because some tests import compiled `dist` modules. The full suite and
authenticated runtime acceptance were not run for this slice.

## Epic browser discovery, 2026-09-09

The restored browser composes `loadEpicBrowserEffect` from repository reads,
`resolveExecutableEffect`, the confined tracker page query, and synchronous
journal projections. `EpicBrowserLoadFailed.stage` distinguishes repository
resolution, repository binding, tracker resolution, tracker reading, and run
projection failures. Its original cause survives the single Promise boundary
used by Promise callers. Commander consumes `Effect.result` directly at its own
runtime boundary so a failed navigation can retain the previous page. The program
stays lazy and stops at the first failed stage. Reloads require user input; no
automatic page retry or stale-choice launch is introduced.

This is the useful Effect boundary for the browser fixes. Console routing,
confirmation identity, roots filtering and launch exit status remain ordinary
logic; wrapping those decisions in Effects would not fix them. Controller
launch, SQLite mutations and process supervision retain their existing owners.
No services, layers, Effect retries or fiber cancellation API were added. The explicit
AbortSignal still reaches the legacy adapters; cancellation waits for their
settlement rather than treating fiber completion as physical stop proof.

Tracker browsing now requests searchable pages of 50 epics. A bounded metadata
projection includes one lookahead identity for pagination. Each ordinary nonempty
page needs one listing/search command and one exact-ID detail command, retaining
all six binding checks. Startup work no longer grows
with every epic in the tracker, and trackers above 1,000 epics remain browsable.
Tests cover typed failures and original causes, cancellation settlement, the
reviewed state/confirmation bugs, large trackers, page validation and real
terminal navigation. Authenticated model execution remains outside these tests.

Validation passed 129 tests across 12 focused files, with one optional real-tracker
test skipped. A separate isolated probe against the installed `br` verified page
response parsing, deferred/closed filtering, title and ID search, and literal
handling of a search beginning with `--`. Build, typecheck, repository formatting,
and diff checks passed.

The first oversized-page fix split listing/search ranges or detail ID batches
after the original command had settled. Only the typed output-limit failure permits
splitting; malformed data, binding changes and other command failures propagate.
The 4 MiB command limit, shared deadline and binding checks remain enforced.
An oversized single epic blocks only new starts. Listing overflow used
the tracker's bounded ID/priority/status/type CSV projection; detail overflow
retains the listing metadata. Saved-run resume and operator controls derive from
the journal independently of tracker detail availability. Recovery stays in the
existing Promise adapter; adding an Effect wrapper would duplicate its command
lifetime owner. Controller exit status now reflects the latest controller attempt,
while quitting immediately after a failed attempt preserves its failure status.

Follow-up validation passed 100 tests across seven focused files, with one optional
real-tracker test skipped. Added regressions cover failed page/search recovery,
reload and renewed confirmation, controller failure followed by 0/2 outcomes,
oversized listings and details, the single-epic output bound, and recovery in a
real terminal. Build, typecheck, formatting and diff checks passed.

The next review fix kept this recovery in the Promise adapter: its typed output
limit error and normalized discovery result express the specific recovery without
another Effect runtime or process owner. The existing Effect browser load carries
that result to the UI. Input sanitization now preserves the submitted search
regardless of paste chunking; redaction applies only when displaying it. Explicit
run/resume retain Ink's CI detection, while browser launches remain interactive.

Validation passed 110 distinct tests across seven focused files, including a
disposable 5 MiB epic exercised against the installed `br` and a real-terminal
unavailable-choice check. The other optional real-tracker test was not run.
Pagination regressions cover an oversized first entry, a page-boundary entry,
legacy array responses and detail-only overflow. Build, typecheck, formatting
and diff checks passed. The terminal test waits for the selected row before
sending Enter so separate key events cannot coalesce in the test transport.

The subsequent structural fix replaces full `Issue` placeholders and the separate
unavailable-ID list with `DiscoveredEpic`. The adapter validates bounded metadata
and translates dependency edges; the browser sees explicit unknown title/hierarchy
values. A journal-only helper decides saved-run actions, and off-page owners carry
unknown priority/status instead of invented defaults. The
[discovery contract](../epic-browser-contract.md) records the root cause, decision
table, research evidence and prevention rules. Earlier test counts above describe
their respective iterations, not validation of this final boundary change.

Final boundary validation passed 123 distinct tests across seven files: browser
projection, Effect loading, picker rendering, CLI routing, real-terminal browsing,
tracker integration and explicit CLI integration. Both installed-`br` tests ran,
including the real 5 MiB deferred/P0 epic and confined child claim. One new picker
assertion initially failed on terminal line wrapping; its fixture and assertion
were corrected, and all 12 picker tests passed. Three malformed-summary assertions
were tightened to require the specific header/schema failure and passed again.
Build, typecheck, repository formatting and diff checks passed. No authenticated
model run was needed or performed for this boundary change.

The next Claude review identified crowded-page read amplification, hidden tracker
status and process-argument exposure of search terms. Discovery now starts with a
bounded 51-entry CSV projection and permits at most 16 JSON detail commands. This
replaces recursive full listing reads and bounds detail recovery without hiding
remaining epics. `budget_exhausted` preserves uncertainty separately from a proven
single-epic overflow; saved-run actions remain independent of both. The picker now
shows tracker status in the list and confirmation. The installed CLI has no private
query-input option, so the picker and README explicitly disclose search visibility
to local processes while retaining display redaction. This mitigates the disclosure
gap; it does not remove process-argument exposure.

Validation for that follow-up passed 128 distinct tests across the same seven
focused files. The crowded-page fixture proves a maximum of 17 commands, preserved
page identities and successful narrow-search recovery; all three installed-`br`
cases ran, including list/search at offset 50. Rendering assertions exposed
awkward independent column wrapping after adding status; each picker row now wraps
as one text flow. One terminal run intermittently missed the first Enter when
opening a live console; that case passed alone and the subsequent full five-case
terminal file passed without changing its timing or assertions. Build, typecheck,
repository formatting and diff checks passed. Authenticated model execution was
not exercised.

The subsequent Codex review found a dependency execution gap: `--deferred` makes
the installed tracker remove SQL pagination and hydrate every matching issue before
returning the bounded CSV page. Research of both command paths and a disposable
real-CLI probe confirmed that deferred epics are already included by default.
Discovery now omits the redundant flag. The installed-CLI paging test adds an
unreadable record beyond the requested page and requires both list and search to
succeed; negative controls with the flag require that record's exact decoder
failure. This regression failed before the fix and passed afterward. The discovery
contract now distinguishes wire size, command count, row materialization and
database work, and requires rechecking the dependency's pagination behavior when
changing query options or CLI versions. It does not claim constant database memory
or execution time; a true metadata-only storage projection needs tracker support.

Validation for this correction passed all 162 tests across eight files: browser
projection, Effect loading, picker, CLI routing, terminal browsing, tracker,
explicit CLI and state-format integration. All three installed-`br` cases ran,
including deferred/P0 preservation and the off-page decoder canary for list and
search. Build, typecheck, repository/document formatting and diff checks passed.
No authenticated model execution was performed.

## Policy, creation and browser lifetimes — implemented

This completed slice covers the four candidates identified in the working-tree
assessment. The description below includes the subsequent account-selection
changes present at `33eef1e`. It retains the pinned Effect RC and adds no platform,
SQL or React integration dependency.

- `loadRepositoryPolicyEffect` in `src/adapters/repository-policy.ts` owns policy
  reads, atomic initialization and decoding. Tagged failures retain stage, path and
  cause. `acquireUseRelease` owns only the temporary directory; publication still
  uses a same-filesystem hard link that cannot overwrite a competing declaration.
  Capturing typed use failures inside the bracket preserves the previous `finally`
  behavior: a cleanup failure wins when both writing and cleanup fail. Cleanup is
  never skipped because the caller aborted. Each Node Promise settles before fiber
  interruption, preventing cleanup from racing an unfinished write.
- `createRunEffect` first calls `loadRepositoryPolicyEffect(repoPath, signal, false)`
  to validate an existing policy or inspect defaults without publishing a file.
  Runtime discovery and verification, tracker reads, account freezing, model
  discovery, and run-state validation then complete sequentially. Only afterward
  does it call the policy loader with initialization enabled, reread the winning
  declaration, and pass that policy to synchronous `store.create(state, policy)`.
  A failed account check therefore leaves a missing policy absent, as covered by
  `test/bootstrap.test.ts`. Policy publication and SQLite persistence are separate
  operations: cancellation or a database failure after publication can leave the
  default policy file without a new run. There is no rollback across those stores.
  `createRun` remains the Promise entry point; its errors
  retain the failing stage and original cause in `RunCreationFailed`. Existing
  declarations and generated defaults are still frozen by the same store operation.
  Explicit cancellation is checked at each stage, and in-flight legacy adapters
  settle before interruption. No retry, parallel admission or new process owner is
  introduced.
- `pickEpicEffect` owns one Ink instance and returns one typed event through a
  Deferred completed by Ink callbacks. Release removes the abort listener, unmounts
  and awaits exit. The browser loop has one Effect runtime entry and an enclosing
  lifetime for process signal handlers; the existing Promise controller path still
  owns launch, stop and drain. React rendering and journal-backed choice authority
  remain unchanged.
- Browser reads have child spans and a root span with page counts and search
  presence. The opt-in `--trace-discovery` flag prints safe stage timings to stderr.
  Typed load errors now reach the CLI with stage-specific advice and redaction;
  `loadEpicBrowser` retains its existing raw-cause Promise rejection contract for
  programmatic callers. Trace output failures cannot change discovery results.

Validation must cover real policy files and concurrent creation, acquisition/use/
release failures, interruption during an outstanding write, lazy creation and
stage short-circuiting, interrupted tracker settlement, competing picker events,
terminal exit settlement and handler cleanup, span timing and redaction, and the
compiled terminal navigation/confirmation flows. Existing schemas, transaction
ownership, tracker command budgets and process supervision remain their current
implementations.

Historical validation for this slice passed 205 tests across twelve files, including all three
installed-`br` cases and all five compiled terminal cases. Build, source/test
typechecking, repository/document formatting and diff checks passed. New coverage
includes real concurrent policy initialization, typed cleanup-error precedence,
interruption that waits for file/tracker/UI settlement, run-creation stage failures,
browser signal-handler cleanup, and opt-in trace output without query or payload
text. One new bootstrap cancellation fixture initially omitted its readiness
signal; correcting the fixture made its cancellation assertion execute. The
initial-load CLI assertion was updated for the intentional stage-aware error
wrapper while preserving the original cause. No authenticated model run was
performed, and the full repository suite was not part of this focused validation.

## Account session and preference saving — 2026-09-10

This follow-up implements the two scoped opportunities identified in `33eef1e`.
It retains `effect@4.0.0-rc.112` and the existing Promise APIs and React callbacks.

`selectAccountsEffect` in `src/tui/account-editor-session.tsx` uses a Deferred for
the first terminal selection and `acquireUseRelease` to own Ink and its listeners.
Preparation is lazy, typed failures identify the stage, and `selectAccounts`
rethrows the original cause for Promise callers. Home inventory remains optional;
validation and creation failures still reach the editor so the operator can keep
the draft and retry explicitly.

The session retains an explicit set of pending Promise operations. Its finalizer
removes listeners, aborts pending creation, unmounts the editor, awaits outstanding
validation/save/creation, and awaits Ink exit. Fiber interruption and renderer
failure take this same cleanup path. Late callbacks cannot begin new operations
after selection or cancellation. An unmount error still drains pending operations,
then fails without awaiting an exit promise that Ink may never settle. Genuine
cleanup failures preserve the existing `finally` error precedence; an exit failure
retains its `wait` stage even when observed during release. The bracket does not
treat fiber completion as proof that underlying I/O stopped.

`saveAccountPreferencesEffect` in `src/adapters/accounts.ts` scopes the temporary
file handle, parent-directory handle, and temporary-path cleanup. It preserves
schema and ownership checks, mode 0600, write → file sync → close → rename →
directory sync → close ordering, and raw Promise rejection values. Typed failures
identify the failing stage. A close failure takes precedence over a write failure;
a subsequent unlink failure takes precedence over both. Individual Node operations
settle before interruption. Once rename starts, the publication and directory-sync
sequence is uninterruptible. A failure after rename can leave the new preferences
published; neither failure nor interruption implies rollback.

Session tests use controlled callbacks and pending operations to check first-result
selection, external and fiber cancellation, preparation/renderer failure, listener
removal, failed-start retry, and terminal settlement. Preference tests use real
files with injected filesystem failures to verify ordering, published bytes,
temporary-file cleanup, failure precedence, and interruption around write/rename.
Existing component and real-terminal tests remain the user-visible behavior checks.
Model-discovery supervision, stop receipts, synchronous account reservation, and
controller recovery remain outside these slices.

Validation command, after `npm run build`, from the repository root:

```sh
npm test -- test/account-editor-session.test.tsx test/account-preferences-effect.test.ts test/accounts.test.ts test/account-editor.test.tsx test/account-selection-pty.integration.test.ts test/cli-browser.test.tsx test/epic-browser-pty.integration.test.ts test/epic-picker-session.test.tsx
```

Before the lifecycle review fixes below, the implementation working tree on top
of `33eef1e` passed **118 tests across all
eight files**, with no skipped cases. Build, source/test typechecking, repository
formatting, and diff checks passed. These checks include the new 20 session and 14
preference-save cases and the compiled account-selection/browser terminal flows.
No full-suite or authenticated model run was performed for these two slices.

### Review fixes: failure origin and terminal lifetime

The review exposed a local abstraction error and a test omission. The session
treated Ink's application-exit promise as if it were an independent cleanup
receipt. Awaiting that rejected promise inside a new `cleanup` wrapper erased
the original `wait` stage. Awaiting it after an unmount exception assumed a
settlement guarantee that Ink does not provide. The original exception fixture
settled the exit promise before throwing, so it could not detect this hang.

Research resolved the open questions without changing the Promise API:

- `AccountSelectionFailed.stage` is exported and the plan promises stage-specific
  failures. External Promise callers retain the raw cause; the CLI now keeps the
  typed failure through its recovery decision, as described below. `wait` means
  obtaining or observing Ink exit failed; `cleanup` means a separate release
  operation failed. The stage does not depend on when the error was observed.
- [Ink 7.1.1's implementation](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/ink.tsx)
  sets `isUnmounting` and removes its `beforeExit` handler before final rendering
  and React teardown. An exception can prevent exit-promise settlement, and a
  repeated unmount returns without repairing that state. The installed source
  in `node_modules/ink/build/ink.js` confirms this behavior.
- The pinned Effect v4 implementation in
  `node_modules/effect/src/internal/effect.ts` makes bracket release
  uninterruptible. A timeout would not prove that owned I/O or terminal teardown
  stopped. Keep real settlement on successful unmount; report a failed unmount
  after draining owned work, without retrying or waiting for its missing receipt.
  This reports teardown failure; it cannot repair partially released Ink internals.

`src/tui/ink-lifecycle.ts` now owns one observation of Ink exit and one release
sequence, shared by the account editor and epic picker. It captures the exit
outcome as a non-rejecting `Result`, preserving failure stage and original cause.
Release captures the unmount outcome, drains supplied owned work, and reports an
unmount failure before attempting to await exit. Domain error construction copies
`stage`, `cause` and `terminalState` explicitly because error causes need not be enumerable.
Rendering, selection callbacks, signal listeners and account operations remain
owned by their sessions. There is no general lifecycle framework or new runtime.

Regression coverage keeps exit pending after a failed unmount, verifies actual
draining under cancellation, and checks typed stages and raw causes for early,
late and synchronous exit failures. An isolated subprocess causes a real Ink
terminal write to throw during unmount and checks that release reports the error
while Ink exit remains pending. Existing PTY cases check successful terminal
handoff. Preference-save coverage also checks rejection before temporary-file
creation and interruption during temporary-file close and directory open/close;
its fixtures use a canonical platform temporary directory.

For subsequent async adapter migrations, distinguish operation completion from
resource release, retain failures at the boundary where they originate, and test
cleanup exceptions with the dependent completion deliberately left pending.
Pair these fault-injection cases with real dependency or terminal checks; a mock
must not manufacture the completion guarantee the adapter is supposed to enforce.

Validation before the terminal-recovery follow-up below passed **150 tests across ten files**, with no skipped
cases: the eight-file command above plus `test/epic-picker.test.tsx` and
`test/ink-lifecycle.integration.test.ts`. This includes the real Ink exception
check and all compiled account-selection/browser PTY cases. Build, source/test
typechecking, repository/document formatting and diff checks also passed. No
full-suite or authenticated model run was performed.

### Review follow-up: terminal failure recovery

The next review found that fixing release locally was insufficient. The browser
received a raw rejection from `selectAccounts`, so its recovery loop could not
distinguish account preparation errors from a failed terminal teardown. It tried
to render another picker. [Ink 7.1.1 caches one instance per stdout](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/render.ts);
after a partial unmount it can return the damaged instance, whose exit promise
still cannot settle. The missing contract was whether recovery could reuse the
terminal, rather than whether the preceding operation had returned an error.

The CLI calls `selectAccountsEffect` and preserves `AccountSelectionFailed`
until the browser makes that decision. The failure now carries `terminalState`
separately from its stage: `untouched`, `released`, or `unknown`. Stage identifies
the failed operation; it is insufficient to decide whether the terminal is safe.

| Observation                                                      | Failure stage     | Terminal state | Account-browser recovery       |
| ---------------------------------------------------------------- | ----------------- | -------------- | ------------------------------ |
| Preparation failed before rendering                              | Preparation stage | `untouched`    | Show the error in the picker   |
| Waiting failed, then unmount and its independent flush completed | `wait`            | `released`     | Show the error in a new picker |
| Post-unmount flush failed or exceeded its deadline               | `cleanup`         | `unknown`      | End the session                |
| Unmount threw                                                    | `cleanup`         | `unknown`      | End the session                |
| Render threw without returning an owned instance                 | `render`          | `unknown`      | End the session                |

Ink removes its cached instance before settling its internal exit promise,
including an application-error rejection. Its public async `waitUntilExit`
method can also reject earlier, while registering a `beforeExit` listener. Such
a rejection is not an exit receipt. After successful unmount, the independent
public `waitUntilRenderFlush` method awaits the internal exit promise (suppressing
its application error); that successful receipt permits reuse. Synchronous
`waitUntilExit` throws remain a defensive adapter test case, not behavior of the
pinned async method, and require the same release evidence. In contrast,
Ink's constructor can register process hooks before throwing, and the public
render function can also throw after caching an instance. Without a returned
handle, neither case provides proof of release. The real constructor exception
test exercises this distinction. No internal Ink cache mutation is used to
pretend a partly released terminal is safe.

Unknown-state failure checks precede cancellation: Ctrl+C does not erase a fatal
cleanup failure. The external `selectAccounts` Promise API still rejects with the
original cause, preserving compatibility for callers outside this CLI flow.

After unmount and owned-work draining, release allows five seconds for terminal
output to settle. A stalled asynchronous stdout produces a cleanup failure with
unknown state; it does not permit another renderer or pretend cleanup succeeded.
This bound applies only to terminal output, never to pending persistence or
creation operations.

At the executable boundary, `reportCliFailure` writes the formatted diagnostic and
exits with status 1 after the write callback only for unknown terminal state, with
a one-second fallback for an asynchronous pipe that does not drain. It runs
after command scopes have released their resources and pending operations have
drained. Merely setting `process.exitCode` is insufficient when partial Ink
teardown retains an input handle. Embedded `createProgram` callers receive the
typed error and retain control over their own process lifetime. An explicit
interactive `run` command reports a released-state error and ends naturally with
status 1; it has no enclosing browser to return to. A picker failure likewise
ends its command, but only unknown state requires forced process termination.

The remaining review questions are resolved as follows:

- Both sessions capture use failures as `Result` before releasing Ink. If exit
  and unmount both fail, cleanup takes precedence, because the resource cannot be
  assumed reusable. If only exit fails, its `wait` stage remains intact.
- The exported account-selection and preference-save errors now include a
  diagnostic message with stage and cause detail. Formatting is best effort and
  cannot replace an unprintable original cause. Raw Promise rejection identities
  and failure stages remain unchanged; CLI output retains redaction.

Browser tests cover failed teardown before and after run creation, failed flush,
render failure, Ctrl+C after both signal handlers are registered,
and preparation-error recovery. They distinguish a safe second picker from a
forbidden one and verify no controller launch after setup failure, listener
restoration, and retention of an already-created run. Successful-start
coverage also verifies that release-time abort leaves the persisted run intact.
Preference tests cover EACCES, symlink and shared-mode rejection before temporary
file creation. The real-Ink subprocess now reaches the production failure handler
instead of calling `process.exit` itself, checks the redacted diagnostic and exit
status with a deliberately retained handle, and loads source through `tsx` so a
stale `dist` tree cannot validate this regression. A second real-Ink case exits
with an error, successfully renders another application on the same stream, and
verifies that reporting a released-state failure does not force process exit.
PTY cases still require a build.

Creation and terminal teardown also have independent outcomes. A run can be
committed before setup later fails or cancellation wins. `RunSetupFailed` at the
CLI boundary retains that run ID, state path, and original failure. Its diagnostic
starts with the created run, the fact that no controller started, and a resume
command using the same state file; recovery information precedes error detail so
clipping cannot hide the durable outcome. The CLI formats those structured fields
separately from redacted error detail; applying a text redactor to an already
quoted filename can change its value and remove its closing quote. Control
characters in filenames are escaped instead of being printed to the terminal.
Cancellation after commit reports the same information, including cancellation
at the final pre-launch check. Recoverable browser failures also write recovery
instructions to stderr before opening the next picker, so quitting that view
does not discard the instructions. This does not recreate, remove, or launch the run. Tests cover
these paths in both the browser and explicit interactive `run`, including a long
error message that is clipped only after the recovery information.

For future migrations, keep typed failure information through the layer that
decides whether to retry or reuse resources. Keep error origin, release evidence,
and durable side effects as separate facts. Verify recovery and operator-visible
outcomes in the caller, including competing cancellation, in addition to testing
local release.

Validation before the explicit release-state and committed-run reporting fixes
passed **201 tests across twelve files**, with no
skipped cases: the ten-file lifecycle group above plus `test/bootstrap.test.ts`
and `test/cli.integration.test.ts`. Build, source/test typechecking,
repository/document formatting and diff checks passed. The new regressions first
failed against the preceding implementation: two browser-reuse cases, the picker
dual-failure case, and the later cancellation-ordering case. The real-Ink source
test verifies production diagnostic redaction and process termination. No
full-suite or authenticated model run was performed.

Validation before the cancellation and cleanup follow-up passed **208 tests
across the same twelve files**, with no skipped cases. Build, source/test
typechecking, repository/document formatting and diff checks passed. The new
browser recovery and committed-run reporting regressions failed against the
preceding implementation before these fixes. The real-Ink cases verify reuse
after a clean error exit, forced termination after failed teardown, and a
constructor exception before an instance handle is returned. No full-suite or
authenticated model run was performed.

### Cancellation and independent cleanup obligations

The next review exposed a remaining outcome-precedence error: after creation
committed and Ink reported a released-state failure, browser cancellation could
discard `RunSetupFailed`. Cancellation describes whether to start more work; it
does not undo committed work or discharge the obligation to report it. The
browser now propagates that committed-run failure before acknowledging
cancellation. Ordinary cancellation without a committed setup failure retains
its existing behavior. SIGINT and SIGTERM regression cases assert the saved run,
resume instructions, no controller launch, and no second picker.

In browser setup, after a run commits, SIGINT/SIGTERM before controller launch
consistently reports `RunSetupFailed` and exits with status 1, including signals
observed immediately after account selection. Explicit Back and Quit still report
recovery instructions and return normally. Tests exercise both signal timings
through the executable failure reporter and assert the exit status, alongside the existing navigation
cases. This keeps signal interruption separate from an explicit navigation choice.

The cleanup question was also a real composition issue. Node's AbortSignal
dispatch does not synchronously propagate listener exceptions, but `process`
is an EventEmitter: a `removeListener` observer can throw synchronously from
`process.off`. This was confirmed against the installed Node runtime and the
[Node event documentation](https://nodejs.org/api/events.html#event-removelistener).
The shared Ink release adapter now attempts each listener-removal and cancellation
callback independently, then unmounts and drains owned work even if an earlier
callback failed. Successful unmount still waits for the exit receipt. An unmount
failure takes precedence; otherwise the first callback failure takes precedence
over an exit failure. Cleanup failures conservatively retain unknown terminal
state. A regression with a real process observer verifies cancellation of a
blocked start, removal of the other listeners, unmount, and draining before the
error returns. The picker also verifies exit waiting after listener cleanup fails.

Fatal diagnostic delivery is a separate external I/O operation. Per
[Node's process I/O contract](https://nodejs.org/api/process.html#a-note-on-process-io),
POSIX pipe writes are asynchronous and may not drain. Unknown-state executable
reporting now exits after a successful write callback or a one-second fallback,
and exits immediately if writing throws. The fallback may lose undeliverable
diagnostic bytes; it runs only after command scopes and owned I/O have drained.
It is not a timeout on persistence or a claim that Ink teardown succeeded.
A timer cannot interrupt a synchronous kernel-blocked write; that limitation of
Node's synchronous stdout/stderr modes remains. Solving it requires an external
supervisor, outside this scoped adoption.

Real subprocess tests fill an unread stderr pipe for both account and picker
failures and assert exit status 1 without a parent kill. Source-loading subprocess
deadlines are now twenty seconds, below the thirty-second test deadline, to leave
room for a cold `tsx` startup. Additional coverage verifies the browser-to-reporter
picker failure path, rejection of late validation/start callbacks, and interrupted
file opening and syncing without publication.

The prevention rule is to keep cancellation, committed outcomes, resource health,
and diagnostic delivery as separate obligations. Cleanup must attempt independent
actions even when one fails; caller tests must assert durable and operator-visible
outcomes when those obligations compete.

Validation before the structured-recovery and independent-flush fixes passed **286 tests across fifteen files**, with no
skipped cases: the preceding twelve-file group plus `test/epic-browser.test.ts`,
`test/runtime-handoff.integration.test.ts`, and `test/state-format.test.ts`.
Build, source/test typechecking, repository/document formatting, and diff checks
passed. The two cancellation regressions and the process-listener cleanup
regression failed before the fixes. A full home filesystem briefly prevented
validation; after space was restored, a source-loading child timeout passed on
rerun and all five subprocess cases passed in the final fifteen-file run. No
full-suite or authenticated model run was performed.

### Structured recovery output and independent release evidence

The all-reviewer pass found two remaining boundary problems. Structured recovery
data was being turned into an error string and then passed through a credential
redactor. Separately, the adapter treated any rejection from Ink's public wait
method as proof that its internal exit promise had settled. These were modeling
errors, not isolated missing catches. The corrected contracts above keep command
data distinct from diagnostic prose and keep failure observation distinct from
release evidence. The historical audit below now names its exact six-file command
instead of relying on its position relative to newer commands.

The new CLI regressions first failed on the old implementation: they reproduced
invalid shell quoting in fatal/cancel output, missing persistent recovery output
after a browser error, and lost recovery instructions after a late SIGINT. The
fixed tests parse the generated command through a shell function that captures
its arguments, checking the exact state filename while verifying error-secret
redaction. Other cases check JSON round-tripping of newline/C1 filenames, back
and quit after browser creation, and wrapped unknown failures reaching executable
termination. Existing creation, persistence, controller, and public Promise
boundaries remain intact.

CLI diagnostic formatting also escapes terminal controls after composing the
message. Credential redaction alone does not prevent an error cause from moving
the cursor or erasing the preceding recovery instructions. Newlines and tabs stay
readable; other C0/C1 controls become visible Unicode escapes. Both ordinary and
committed-run failures exercise this boundary, retaining secret redaction and
the quoted state path. Session comments now state the actual post-bracket
invariant: reaching the retained use result proves release already succeeded.

A real-Ink subprocess installs a throwing `newListener` observer for `beforeExit`.
It demonstrated the premature released classification before the fix, then
verified that release waits for an independently held output callback before
classifying the same failure as released. Another real-Ink case blocks output
and verifies that owned work drains before the five-second failure is reported
through the executable boundary. Session tests cover listener registration
failures followed by successful release. Preference tests cover competing
publication/unlink and directory-sync/close failures and their actual disk state.

Investigation also resolved the intermittent source-subprocess timeout. With
`TSX_DISABLE_CACHE=1`, an installed-runtime probe observed stderr descriptor flags
change from `02004002` to `02000002` during the CLI import: the nonblocking flag
was cleared. esbuild inherits stderr and its
[terminal probe calls `File.Fd`](https://github.com/evanw/esbuild/blob/main/internal/logger/logger_linux.go),
whose [Go implementation can switch the descriptor to blocking mode](https://github.com/golang/go/blob/master/src/os/file_unix.go).
The unread-stderr fixture now waits for a startup handshake and explicitly
restores asynchronous pipe mode before applying backpressure. This adjustment is
confined to the disposable test child; the compiled executable uses no `tsx`
loader. Both asynchronous pipe handling and the remaining inability of a JS
timer to interrupt a synchronous kernel write are documented separately.

Validation before the review-fix-loop follow-up passed **299 tests across the same fifteen files**,
with no skipped cases. The five-file focused run passed 131 tests. Build,
source/test typechecking, repository/document formatting, and diff checks passed.
The before-fix failures described above establish the recovery and release
regressions; the final run includes all seven real subprocess cases. No full-suite
or authenticated model run was performed.

The review-fix-loop's first repair passed **304 tests across those fifteen files**,
including the new signal-status and terminal-control regressions, which failed
before repair. Build and source/test typechecking passed in an isolated copy;
repository/document formatting and diff checks passed in the working tree.

## Current validation commands

Run from the repository root. The first command group checks the directly adopted
Effect programs, including policy cleanup, interrupted I/O settlement, picker
release, typed errors, and creation short-circuiting:

```sh
npm run build
npm run typecheck
npm test -- test/doctor.test.ts test/runtime-discovery.test.ts test/epic-browser-effect.test.ts test/repository-policy-effect.test.ts test/epic-picker-session.test.tsx test/bootstrap.test.ts
npm test -- test/account-editor-session.test.tsx test/account-preferences-effect.test.ts test/accounts.test.ts test/account-editor.test.tsx test/account-selection-pty.integration.test.ts test/ink-lifecycle.integration.test.ts
npm run format:check
npx prettier --check docs/plans/effect-v4-adoption.md
git diff --check
```

Build before integration tests: several fixtures execute or import `dist` files.
Expect each command to exit successfully and the test files to report no failures.
Do not rebuild concurrently with tests using `dist`.

Changes to browser navigation, tracker discovery, creation, or handoff also require
the relevant integration checks:

```sh
npm test -- test/epic-browser.test.ts test/epic-picker.test.tsx test/cli-browser.test.tsx test/epic-browser-pty.integration.test.ts test/cli.integration.test.ts test/tracker.integration.test.ts test/runtime-handoff.integration.test.ts test/state-format.test.ts
```

The compiled PTY cases require Linux. The installed-tracker cases additionally
require `EPICD_TEST_BR_PATH` to name the supported `br` executable; without it those
cases skip. To include them against the selected local installation:

```sh
EPICD_TEST_BR_PATH="$(command -v br)" npm test -- test/tracker.integration.test.ts
```

These commands use disposable fixtures and do not require authenticated model
execution. For repository-wide validation, run `npm test` after the build and
report skipped or failing cases separately.

The 2026-09-10 audit ran the following exact command against
`33eef1e2094193b2731c11d2849ab1747f6ec6d1`: **83 tests passed in six files**.

```sh
npm test -- test/doctor.test.ts test/runtime-discovery.test.ts test/epic-browser-effect.test.ts test/repository-policy-effect.test.ts test/epic-picker-session.test.tsx test/bootstrap.test.ts
```

It did not rerun the build, typecheck, broader integration group, or full suite.
Earlier counts remain reports of their individual working-tree iterations; the
205-test record did not retain an exact tested commit or complete file list and
must not be treated as reproducible validation of the current revision.

## Revision note — 2026-09-10

Aligned the status summary with the implemented Effect modules and the recorded
decision to retain the receipt reader. Corrected creation ordering from
`src/bootstrap.ts` and the policy publication behavior from
`src/adapters/repository-policy.ts`, including the separate persistence boundary.
Separated dated registry observations from the installed RC pin and floating API
documentation. Added explicit validation commands using existing tests and package
scripts, and recorded the audit's tested revision without reassigning historical
test counts to newer code.
