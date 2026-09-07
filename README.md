# epicd

Epicd is being rebuilt as a persistent autonomous engineering lead. GPT-6 Astra chooses delivery strategy, coordinates agents, investigates failures, and requests actions from a deterministic Git and Beads safety kernel.

This branch has one orchestrator controller. There is no legacy phase dispatcher, compatibility mode, state conversion, or database migration. Use a fresh state path. Unsupported existing data is left intact.

The CLI and controlled runtimes are wired, but complete epic delivery is not yet ready. Independent whole-epic verification is implemented; container/root closure, epic-scoped repair, terminal completion, host-fixture reset/cleanup and restricted shared-service access, some recovery/resource-management capabilities, and end-to-end acceptance remain unfinished. Unavailable capabilities are reported to the orchestrator, not emulated by a legacy workflow.

## Requirements

- Linux x64, Node.js 22.12+, Git, Bubblewrap, util-linux `unshare`, and working unprivileged user/PID/mount namespaces.
- Codex authentication and access to exactly `gpt-6-astra`. There is no coordinator model fallback.
- `br` (Beads) and a repository with a local `.beads/beads.db`.
- A repository-declared `.epicd/policy.json`.
- For native Herdr: a compatible running Herdr session, its Codex integration, the native `codex` executable, and invocation from a Herdr-managed pane.

The coordinator defaults to Astra/high. Supported Astra efforts are low, medium, high, xhigh, and max. Worker defaults are resolved once from the selected Codex executable unless supplied explicitly. Role preferences can change future assignments; existing agent contracts remain pinned. [Official Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra)

## Build and inspect

```bash
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js doctor --repo /path/to/repository --runtime sdk
```

`doctor` checks executable/endpoint availability without starting a model turn. It does not certify authentication, model access, confinement, or successful delivery.

SDK mode uses the SDK-pinned native Codex binary through the supervised SDK transport. Herdr mode launches a real native Codex TUI in run-owned, unfocused tabs; it does not wrap SDK workers in decorative panes. The selected runtime, executable paths, private storage roots, and Herdr endpoint are persisted at creation. Resume does not silently switch runtimes.

Confined validation, Codex, Beads and fixture commands use an independent PID-namespace lifetime supervisor outside Bubblewrap's command mounts. Cancellation remains effective during sandbox startup. A killed supervisor is an unknown stop, not permission to release a workspace, accept tracker completion or attest fixture-client termination. There is no unconfined fallback when this boundary cannot start.

Whole-epic verification has its own published-revision target. `prepare_epic_delivery` binds the latest publication, observed tracker scope and closed-task provenance to an epic-root validation plan. It retains required checks from delivered tasks and demands fresh results at the final SHA. `run_review` then starts an independent `final_review` conversation in an isolated verification copy, covering all descendant requirements and the diff from the run baseline. Findings survive replacement targets. This evidence does not itself close the tracker root or complete the run. Oversized complete review context is rejected, never silently shortened into approval.

## Declare policy

The JSON declaration uses schema version 1. Include the checks that actually establish your repository's acceptance requirements. For example:

```json
{
  "schemaVersion": 1,
  "requiredChecks": [
    {
      "id": "unit-tests",
      "command": "npm",
      "args": ["test"],
      "cwd": ".",
      "timeoutMs": 120000,
      "stage": "both"
    }
  ],
  "budgets": {
    "maxWorkers": 4,
    "taskDecisions": 64,
    "epicDecisions": 128
  }
}
```

Commands and dependencies must be available inside the isolated validation environment; host installation alone is not sufficient. Repository commands cannot access arbitrary host services, home directories, or network endpoints. There is no full-host-access bypass. Host fixture declarations do not themselves grant service authority. Explicit grants, catalog inspection and absent-database creation are implemented; host-fixture reset, cleanup and restricted shared-service access are not. Separately declared check-scoped PostgreSQL services can now supply an isolated database for validation.

Policy is frozen when a run is created. Editing the repository file does not change an existing run's permissions or required checks.

To let the orchestrator change worker settings itself, list exact permitted model/effort pairs in `autonomousWorkerSettings`, for example `[{"model":"YOUR_WORKER_MODEL","reasoningEffort":"high"}]`. An empty or omitted list does not grant unrestricted model choice. Operator-selected initial settings remain usable; this list bounds autonomous changes, not explicit operator settings commands.

## Start and operate a run

Use an explicit state path outside the target repository for this experimental branch:

```bash
node dist/cli.js run EPIC_ID --repo /path/to/repository \
  --state /path/to/private-state/current.sqlite3 --runtime sdk --headless

# From a Herdr-managed pane:
node dist/cli.js run EPIC_ID --repo /path/to/repository \
  --state /path/to/private-state/native.sqlite3 --runtime herdr
```

The SDK and Herdr examples are alternatives. Use one state path for a repository: linked-checkout exclusion is enforced within that database, not across independently created state files. Cross-state repository admission fencing remains unfinished; do not run independent state stores against the same repository concurrently.

The command prints the new run ID. Subsequent commands target that exact ID:

```bash
node dist/cli.js status RUN_ID --state /path/to/private-state/current.sqlite3 --json
node dist/cli.js pause RUN_ID --control-version VERSION --state /path/to/private-state/current.sqlite3
node dist/cli.js resume RUN_ID --state /path/to/private-state/current.sqlite3 --headless
```

In the status UI, `p` or `q` pauses admission, interrupts owned work, and exits after shutdown handling. Headless mode streams journal events. A pause request is not proof that an external process stopped.

Answer a pending escalation using the question ID and control version returned by status:

```bash
node dist/cli.js respond RUN_ID ESCALATION_ID "Your instruction" \
  --control-version VERSION --state /path/to/private-state/current.sqlite3
node dist/cli.js resume RUN_ID --state /path/to/private-state/current.sqlite3
```

Responses are durable, correlated instructions, not environment or destructive-action grants. A stale response is rejected. Pausing does not dismiss an unanswered question.

Change future-thread settings while no live controller owns the run:

```bash
node dist/cli.js settings RUN_ID --role review --model WORKER_MODEL \
  --reasoning high --state /path/to/private-state/current.sqlite3
```

The coordinator model must remain `gpt-6-astra`. A changed coordinator effort takes effect through a new assignment after the prior turn has stopped; existing worker assignments retain their contracts.

During a run, the orchestrator can invoke `change_agent_settings` within frozen policy. A coordinator effort change creates a fresh conversation before the next decision, retaining journaled memory, findings and budgets. It does not use provider-specific in-place effort updates or silently change models.

`replace_agent` requires the old worker's confirmed stop and a separately created workspace. It preserves the old copy, retires that generation and reserves a fresh one with the same task/purpose and current permitted settings. The orchestrator supplies handoff instructions and chooses when to continue; independent reviewers still run through `run_review`. Replacement does not erase findings, reuse a contaminated copy or count as completed work.

`create_diagnostic_workspace` gives specialists a writable private copy for experiments. With `candidate` and `revision` both null it copies the frozen epic baseline, even while implementation is active. A candidate identity selects its captured snapshot; an explicit revision must also identify that candidate's kernel-recorded exact commit. Candidate copying requires its source workspace to be stopped. The orchestrator then chooses `start_specialist`, follow-up, inspection or replacement through the selected SDK/native Herdr driver. Diagnostic edits and reports cannot satisfy delivery validation or independent review. Restart can recover a lost creation acknowledgement only from an intact recorded copy with confirmed I/O stop; it never recreates an uncertain copy or discards its delta.

## Fixture authority, inspection and creation

Review the frozen fixture declarations in `status RUN_ID --json` before granting access. A declaration identifies its canonical local PostgreSQL socket directory, port, existing role, exact database and expected owner. Grant only the operations you intend, with an ISO-8601 UTC expiry in the next 24 hours:

```bash
node dist/cli.js grant-fixture RUN_ID FIXTURE_ID --state STATE_PATH \
  --control-version VERSION --operations inspect \
  --expires-at EXPIRY_ISO8601 --psql-path /absolute/path/to/native/psql

node dist/cli.js revoke-fixture-grant RUN_ID GRANT_ID --state STATE_PATH \
  --control-version VERSION
```

Use the canonical native `psql` executable, not a shell wrapper such as `pg_wrapper`. The grant pins the run, policy, declaration, executable contents and filesystem/socket identities. A changed socket or provider requires a new grant. Replacing a grant revokes the old identity but preserves its history; revocation never deletes a database. Grant changes do not answer pending escalations or resume paused runs. Ordinary `respond` messages cannot issue grants.

The orchestrator chooses when to invoke `inspect_fixture`. Its fixed read-only catalog query connects to the declared local server's `postgres` maintenance database using the declared role; startup files, inherited PostgreSQL environment and password files are not loaded. Only the trusted inspection process receives the exact socket, inside a separate PID/network sandbox. [The `psql` options reference](https://www.postgresql.org/docs/current/app-psql.html) documents the startup-file and error-stop controls used here.

Inspection distinguishes a missing socket, an absent database, a present database and a failed query. Matching database ownership does not establish epicd ownership. Successful local authentication is not reported as proof of peer authentication, and neither observation grants service access to repository commands.

To authorize creation too, use `--operations inspect,create` with a declaration that allows `create`. The orchestrator may then request `provision_declared_fixture` with `operation: "create"` and the observed `expectedGeneration` (initially 0). The kernel creates only an absent exact database, using the existing declared role. It does not install/start PostgreSQL, change roles or authentication rules, or adopt an existing database. The real provider contract is tested against PostgreSQL 18 with a non-superuser `CREATEDB` role; repository commands never receive that role's socket.

Before mutation, SQLite records the generation, planned database OID, operation marker and exact creation backend. A one-use dispatch gate prevents mutation replay. The new database starts with connections disabled; a locked transaction verifies its identity before installing the ownership marker and enabling connections. Completion requires a separate observation proving that backend has stopped and the resource's OID, name, owner and marker match. [PostgreSQL's CREATE DATABASE reference](https://www.postgresql.org/docs/current/sql-createdatabase.html) describes the explicit OID, ownership and transaction constraints.

`reconcile_fixture_creation` inspects a recorded creation without repeating SQL mutations. It requires an inspection grant after dispatch. An unmarked, changed or possibly still-running creation remains uncertain and is preserved. A replaced socket cannot prove that the old backend stopped. Only a never-dispatched intent, or confirmed backend stop followed by an absent resource, permits a new creation generation. Reset/cleanup remain unavailable, and successful creation does not make the fixture accessible to repository validation.

## Check-scoped PostgreSQL validation

When a check needs a fresh database rather than a shared host fixture, add a separate `validationServices` declaration to policy:

```json
{
  "validationServices": [
    {
      "id": "e2e-postgres",
      "provider": "postgresql",
      "lifetime": "check",
      "binDirectory": "/usr/lib/postgresql/18/bin",
      "database": "browser_test",
      "role": "fixture_owner",
      "port": 55432,
      "connectionVariable": "DATABASE_URL"
    }
  ]
}
```

Reference `"e2e-postgres"` in the required check's `environmentBindings` array. The orchestrator still chooses when to call `run_validation`; the kernel initializes the declared service before executing that check's unchanged command/arguments. Setup stays inside the validation profile already authorized for the run. It does not consume or expand a host-fixture grant, install PostgreSQL, or connect to a host database. Service IDs cannot alias host fixture bindings.

Each invocation creates a fresh private PostgreSQL cluster and database, exposes its URL only inside that check, and discards its data when the sandbox stops. TCP uses the sandbox's private loopback interface; no host socket, host account file or credential is mounted. Even PostgreSQL-superuser operations remain inside the same filesystem/process/network confinement. The existing `CREATEDB` host role is never passed through `SET ROLE` as a substitute for isolation; [PostgreSQL permits resetting that role](https://www.postgresql.org/docs/current/sql-set-role.html).

SQLite records the instance ID, definition digest and native executable fingerprints before launch. Binding and its audit write commit together. Setup failure cannot start the check; a changed runtime cannot supply passing environment evidence. Replaying the same action returns its stored result, while a new invocation gets a new instance. There is no database state shared between checks, and no automatic substitution for a declared host fixture. Use a deliberately matching check/plan; application dependencies and browser binaries still need to exist in the validation environment.

The live contract currently uses PostgreSQL 18. Native `initdb`, `pg_ctl`, `postgres` and `psql` must reside in the declared canonical `/usr` directory. The validation user must be non-root. These services are visible in `status --json` and in the orchestrator's frozen policy context.

## Safety and recovery

The model chooses the next useful capability. The kernel validates control versions, leases, policy, workspace ownership, and evidence before executing it.

- Only the kernel claims/closes Beads and stages/commits/publishes Git changes.
- Implementation and review use private repository copies. The user's checkout and index are not a scratch workspace.
- Review judgments and validation evidence are tied to exact candidate/workspace/turn identities; actual-SHA verification is separate from pre-commit review.
- A task close requires a current verified publication and claim. The installed Beads close interface lacks atomic expected-owner/parentage comparison; fresh before/after checks detect conflicts but cannot eliminate that race. This remains a release blocker.
- Unknown stop state stays unknown. Restart reconciles recorded work; it does not replay an uncertain external mutation.
- Epicd creates local commits/refs, never pushes.

Status is derived from the journals: current control, assignments, actions, evidence, diagnostics, pending questions, and controller ownership. SQLite also retains strategy, hypotheses, findings, and run-local operational knowledge.

Runtime diagnostics retain bounded, best-effort-redacted content. Native terminal excerpts are partial; clipping and omissions are explicit. Diagnostic hashes establish content identity, not truth or approval.

If a controller lease must be fenced, first inspect its exact PID and lease ID:

```bash
node dist/cli.js unlock RUN_ID --owner-pid PID --lease-id LEASE_ID --force \
  --state /path/to/private-state/current.sqlite3
```

Unlocking does not kill processes or prove they stopped. A replacement controller must reconcile their recorded identities. Do not use it as routine resume.

`quarantine RUN_ID --force --state PATH` preserves an invalid current-format run's raw records; it does not infer cleanup actions or delete external resources. Unsupported whole database formats require a different state path, not quarantine or migration.

## Development and verification

```bash
npm run build
npm run typecheck
npm test
npm run format:check
```

Build before testing: supervised-process and CLI tests exercise the compiled entrypoints. Do not rebuild or edit source while those tests are running.

Normal integration tests use owned temporary repositories and scripted provider results. They exercise real journaling, Git operations, confinement, and process stop; they do not prove model judgment. Authenticated model/native checks are opt-in and recorded separately. See the implementation plan for remaining acceptance scenarios and their live-test commands.

The opt-in fixture contract uses real PostgreSQL binaries but creates and stops its own Unix-socket-only cluster; it never uses an existing host database service:

```bash
EPICD_TEST_PG_BINDIR=/absolute/path/to/postgresql/bin npm test -- test/fixture-postgresql.integration.test.ts test/fixture-creation-postgresql.integration.test.ts test/validation-services.integration.test.ts test/delivery.integration.test.ts
```

The original dispatcher and its dedicated tests have been removed. Their history remains in Git; old state, user repositories, and user-owned Herdr resources are not deleted by this hard cut.

## License

MIT
