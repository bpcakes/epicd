# Effect v4: first adoption steps

Investigated 2026-09-09 on `feature/always-engaged-orchestrator`, at HEAD
`2ec237f`, including the existing uncommitted workspace-inspection and recovery
changes. Steps 1 and 2 are now implemented on top of `9e66f49`; see the
implementation records below. Shared runtime discovery is also implemented;
the controller and resource-lifetime sections remain proposals.

Start with the read-only `doctor` command. Use it to establish a small typed
Effect program behind the existing Promise API. Then consider a single scoped
file read before touching controller concurrency. The initial benefit is learning
the integration and failure boundaries; the larger potential benefit is clearer
resource ownership and concurrent lifetimes later.

## Version and compatibility

- The npm registry currently reports `rc = 4.0.0-rc.112`,
  `beta = 4.0.0-beta.107`, and `latest = 3.22.2`. Target the exact RC:
  `npm install --save-exact effect@4.0.0-rc.112`. Execute this in the implementation
  step, with its first consumer, and commit both package files. Recheck the tags
  if implementation happens later.
- Effect v4 is a release candidate. Its current requirements are TypeScript 5.9+,
  strict checking, and generally Node 18+. This repository already uses
  TypeScript 5.9.3, strict NodeNext/ES2023, and Node 22.12+.
  [Official requirements](https://github.com/Effect-TS/effect/blob/main/README.md)
- Use the explicitly versioned [v4 documentation](https://effect.website/docs/v4/)
  and [RC API reference](https://effect.website/docs/v4/api/effect/Effect).
  Older examples can use incompatible APIs. Current services use `Context.Service`;
  typed failure recovery includes `Effect.catchTag`; success/failure values use
  `Effect.result` and `Result`.
  [Context API](https://effect.website/docs/v4/api/effect/Context)
- Use static module imports such as `import * as Effect from "effect/Effect"`
  throughout the migration. Focused imports avoid evaluating unrelated modules
  through the root barrel. Consider lazy loading only if measured CLI startup
  warrants it.
- Install only `effect` for the pilot. Ordinary Vitest can await its programs.
  Add `@effect/vitest` or platform integrations only for an actual later need,
  with versions matching the core package. CLI, process, and SQL integrations
  include `effect/unstable/*` modules with different stability commitments.
  [Package organization](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)

Registry checks: `npm view effect dist-tags --json` and
`npm view effect@rc version engines peerDependencies --json`. An isolated install
confirmed the published package is `4.0.0-rc.112`.

## What fits this branch

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

## Step 1: establish the doctor contract

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

## Step 2: implement the doctor pilot

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

## Next candidate: one receipt-read lifetime

After the doctor pilot is useful and the current command-lifetime changes have
settled, evaluate only `readCommandStop` for `Effect.acquireUseRelease` or a scoped
acquisition. The resource to release is its local file descriptor. Reading a
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

## Policy, creation and browser lifetimes

The next adoption slice covers the four candidates identified in the working-tree
assessment. It retains the pinned Effect RC and adds no platform, SQL or React
integration dependency.

- `loadRepositoryPolicyEffect` in `src/adapters/repository-policy.ts` owns policy
  reads, atomic initialization and decoding. Tagged failures retain stage, path and
  cause. `acquireUseRelease` owns only the temporary directory; publication still
  uses a same-filesystem hard link that cannot overwrite a competing declaration.
  Capturing typed use failures inside the bracket preserves the previous `finally`
  behavior: a cleanup failure wins when both writing and cleanup fail. Cleanup is
  never skipped because the caller aborted. Each Node Promise settles before fiber
  interruption, preventing cleanup from racing an unfinished write.
- `createRunEffect` composes policy initialization, existing Effect discovery,
  runtime verification, tracker reads and final journal creation in their original
  sequential order. `createRun` remains the Promise entry point; its errors now
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

Final validation passed 205 tests across twelve files, including all three
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
