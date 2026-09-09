# Effect v4: first adoption steps

Investigated 2026-09-09 on `feature/always-engaged-orchestrator`, at HEAD
`2ec237f`, including the existing uncommitted workspace-inspection and recovery
changes. Steps 1 and 2 are now implemented on top of `9e66f49`; see the
implementation record below. The broader adoption sections remain proposals.

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
