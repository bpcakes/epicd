# epicd

Epicd is being rebuilt as a persistent autonomous engineering lead. GPT-6 Astra chooses delivery strategy, coordinates agents, investigates failures, and requests actions from a deterministic Git and Beads safety kernel.

This branch has one orchestrator controller. There is no legacy phase dispatcher, compatibility mode, state conversion, or database migration. Current storage format is 30. Use a fresh state path; unsupported existing data is left intact.

The CLI and controlled runtimes are wired, but autonomous epic delivery is not yet release-ready. Independent whole-epic verification, epic-scoped repair, guarded container/root closure, atomic run completion, isolated tracker export and tracker-only delivery commits are implemented. Restricted validation access to run-created PostgreSQL fixtures is implemented under separate operator grants. Host-fixture reset/cleanup, some recovery/resource-management capabilities, and end-to-end acceptance remain unfinished. Unavailable capabilities are reported to the orchestrator, not emulated by a legacy workflow.

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

When the selected `codex` is the current npm JavaScript entrypoint, bootstrap resolves that installation's native payload before confinement and freezes the resulting executable path. An incomplete selected installation is an error, not permission to substitute another installation or launch the shim inside the sandbox.

Confined validation, Codex, Beads and fixture commands use an independent PID-namespace lifetime supervisor outside Bubblewrap's command mounts. Cancellation remains effective during sandbox startup. A killed supervisor is an unknown stop, not permission to release a workspace, accept tracker completion or attest fixture-client termination. There is no unconfined fallback when this boundary cannot start.

Whole-epic verification has its own published-revision target. `prepare_epic_delivery` binds the latest publication, observed tracker scope and closed-task provenance to an epic-root validation plan. It retains required checks from delivered tasks and demands fresh results at the final SHA. `run_review` then starts an independent `final_review` conversation in an isolated verification copy, covering all descendant requirements and the diff from the run baseline. Findings survive replacement targets. This evidence does not itself close the tracker root or complete the run. Oversized complete review context is rejected, never silently shortened into approval.

After a final finding, the orchestrator can request `start_agent` with purpose `epic_repair`, the root task ID and latest captured root candidate, using a fresh implementation workspace at the latest private commit. The kernel binds the assignment to the open root and proven closed descendants, and supplies retained requirements, findings and checks to either runtime. No task is reopened and no root claim is fabricated. Repair commits use the normal independent pre-commit and exact-revision review gates. Every further repair extends the private tip; publication must be followed by a new whole-epic target and approval before root closure. Policy/reviewer requirements and committed repair checks remain binding even before publication; uncommitted draft checks stay editable.

## Isolated tracker export

`export_tracker` takes no paths or replacement content from the orchestrator. The kernel creates a private, operation-owned SQLite snapshot, copies the pinned Beads configuration, and runs a strict confined export against that copy. SQLite's [online backup API](https://www.sqlite.org/backup.html) captures committed WAL state; this is an execution snapshot, not an old-format migration or compatibility backup.

The source database is opened read-only for the snapshot. Its dirty flags, user JSONL and base JSONL are not flushed, imported or cleared. The private export includes the tracker's full JSONL output, not just the current epic. The kernel checks count/hash, captured issue fields and relationships, stability of the copied epic graph, and agreement with a later live epic observation. A changed epic scope yields a conflict and retains the historical bytes. That comparison does not certify freshness of unrelated issues or grant authority to overwrite them later.

`inspect_tracker_operation` and status expose export identity and metadata; raw JSONL stays in the private journal for kernel commit construction. It can contain sensitive tracker content and is not a redacted diagnostic. Export uses a 4-MiB output limit, a 64-MiB database bound and a 120-second cooperative deadline. Existing operation directories are never reused or truncated. Recovery can inspect a known-stopped operation without exporting again; an unknown process stop remains unknown. Private copies, including incomplete ones, are retained in the completion resource inventory.

The orchestrator can request `request_tracker_commit` with a retained export operation and the current publication ID, then `request_publish_tracker` with that tracker commit ID and the expected previous revision. The kernel replaces only `.beads/issues.jsonl` in the committed tree and advances the actual local `epicd/<run-id>` delivery branch through the same guarded publisher. It never stages user files or changes either checkout or index. New implementation work uses the complete tracker-updated tip, not its older application ancestor.

Tracker commits retain explicit ancestry to the reviewed application object. They do not invent a review of their own SHA. A final review may inspect the tracker-updated SHA directly, or remain valid at its original revision through a proven tracker-only chain with unchanged requirements, evidence and writer generations. After root closure, completion requires another exported and published tracker descendant whose recorded scope matches the live closed epic. `inspect_tracker_commit` and `reconcile_tracker_commit` expose the durable object outcome; replay does not construct another object, and reconciliation requires independently confirmed I/O stop or a provably unused dispatch gate.

Export alone does not commit, publish, close an issue or approve completion. Those are separately requested capabilities with their own kernel checks; neither runtime substitutes a shell command or legacy workflow for them.

## Interrupted delivery actions

`reconcile_action({ actionId })` inspects an interrupted capture, implementation/review-copy creation, validation, review or application commit by its original action ID. The controller uses the same recovery code on restart. Neither path reruns the original command, copy, review turn or commit write, and the capability cannot interrupt a live action.

A retained result can settle its historical acknowledgement; current review and publication eligibility are checked separately. Failed checks remain failed. A stopped review without a durably recorded verdict needs a fresh independent review. Changed or unbound copies are preserved, not restored or adopted. Missing process or controller-I/O stop proof leaves the operation unresolved and its workspace excluded. Other resource types keep their dedicated reconciliation capabilities.

This works through the shared kernel for both SDK and native Herdr runtimes. It is current-format restart recovery, not migration support. Abandoned controller I/O for these delivery actions and retained-resource cleanup remain unfinished; repository ownership has the separate recovery boundary below.

### Repository ownership after a controller crash

Acquiring and releasing `refs/epicd/run-owner` now run as whole trusted operations under a detached supervisor and the existing PID-namespace lifetime boundary. The supervisor detects loss of the controller's private pipe, stops the namespace, waits for its descendants to be reaped, and retains an operation-specific stop receipt. Git guards still require the original lease, repository binding and exact ownership intent; release still requires completed-run control.

A replacement controller can acknowledge that receipt and inspect the actual ref without repeating the original write. If dispatch never started, it can atomically prevent that generation from starting. Neither a matching ref, an absent process nor a replacement lease proves termination. Missing or invalid receipts, replaced control directories and killed namespace monitors preserve uncertainty and the repository reservation. A failed operation can be retried as a new generation only after its stop and physical outcome have been settled.

Private control directories live beside the state file under `<state-path>.repository-io`; that location must be outside the checkout and Git metadata. The journal binds their filesystem identity before dispatch and records the operation and receipt identities. Control files are retained, not automatically deleted. Worker attachment cannot create missing state, initialize empty state or adopt a replaced state file. This boundary is shared by SDK and native Herdr; it does not yet supervise all controller-side Git, workspace, tracker or fixture I/O.

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

Commands and dependencies must be available inside the isolated validation environment; host installation alone is not sufficient. Repository commands cannot access arbitrary host services, home directories, or network endpoints. There is no full-host-access bypass. Host fixture declarations do not themselves grant service authority. Explicit grants allow catalog inspection, absent-database creation and separately authorized restricted validation access; host-fixture reset and cleanup are not implemented. Separately declared check-scoped PostgreSQL services can also supply an isolated database for validation.

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

The SDK and Herdr examples are alternatives. Before invoking either runtime, the controller acquires `refs/epicd/run-owner` in the repository's physical common Git directory. Separate state files and linked checkouts therefore contend for the same run reservation. Creating another state file does not bypass ownership. The reservation binds the run, a unique owner identity and the state file's canonical path/device/inode; copying, moving or replacing state cannot borrow it.

Pausing, detaching or quarantining a run does not release its reservation. Inspect its diagnostic metadata with `git -C /path/to/repository cat-file -p refs/epicd/run-owner` to locate the recorded owning run and state file. Treat those bytes as metadata, not takeover authority. Do not delete the ref to bypass an interrupted run or unsupported state. Automatic takeover and abandoned-resource disposal are not implemented.

Acquisition and release have durable intents and recorded I/O stop evidence. Lost acknowledgements can be inspected without repeating a write; matching refs or a replacement lease do not prove an unknown old operation stopped. Ownership is checked before coordinator calls and action dispatch, with periodic checks during waits. Verified completion permits exact-owner compare-and-swap release, and a completed run can finish that cleanup on resume without initializing a model. Delivered branches, user checkouts and indexes are retained. Other resource cleanup remains unfinished.

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

## Bounded coordinator conversations

Each decision snapshot stays within 64 KiB. Observations are delivered as an ordered prefix with an explicit backlog flag; admission acknowledges only the delivered cursor. Large event metadata causes another page, not skipped events or an increased limit. Shortened observations remain in SQLite and can be retrieved with the read-only, run-scoped `inspect_observation` capability. Its pages contain retained JSON text with UTF-16 offsets and `nextOffset`; reading every retained character does not turn diagnostic claims into verification evidence. Current authority/evidence summaries and the latest action outcome remain in context. When request arguments are too large, `latestActionOutcome` retains the action identity and result while explicitly omitting those arguments from the preview; the journaled request is unchanged. A mandatory snapshot that cannot fit still fails explicitly.

The run outlives any one Astra conversation. Between decisions, the controller retires a confirmed-stopped coordinator when its recorded history reaches 12 turns, 512 KiB of serialized prompts/schemas/results, or 196,608 reported SDK input tokens. These are conservative rollover thresholds, not exact context occupancy or monetary limits. SDK usage is retained against the exact acknowledged launch; native Herdr uses the same byte/turn guards without inventing token counts from terminal text.

Rollover starts a fresh `gpt-6-astra` conversation in the selected runtime with unchanged settings and current journal context. Memory, assignments, evidence, findings, policy and consumed budgets remain intact. Pending instructions and unknown stop states prevent retirement; a frozen decision is reconciled before its conversation can be retired. Old workspaces and provider records are retained, not deleted or copied into the new conversation. Unexpected runtime failures still require diagnosis; this does not introduce a generic retry or model fallback.

Codex exposes [automatic compaction settings](https://learn.chatgpt.com/docs/config-file/config-reference), but this safeguard does not depend on compaction succeeding or assume that the [Astra API context window](https://developers.openai.com/api/docs/models/gpt-6-astra) is the installed Codex runtime's effective limit.

## Explicit runtime handoff

`resume` always uses the recorded runtime. To switch deliberately, pause the run and wait for its controller to detach, then inspect status again for the current control version:

```bash
node dist/cli.js handoff RUN_ID --state /path/to/private-state/run.sqlite3 \
  --runtime herdr --control-version VERSION
```

Use `--runtime sdk` to switch back. `--codex-path` selects a native executable; otherwise SDK uses its pinned binary and Herdr resolves native `codex`. Herdr selection requires a managed caller and read-only discovery of that caller's exact named session and workspace, never the focused pane. `--herdr-path` can select the Herdr executable. Handoff does not create layout, submit prompts or start a model. Inspect status and explicitly resume afterward; an unanswered escalation still requires its correlated response.

The handoff holds a controller lease, verifies physical repository ownership, and rechecks the observed control version before one atomic journal transaction. All turns, launchers, workspace I/O and delivery/fixture operations must have recorded stop and settlement. Pending agent instructions are not discarded. If work is uncertain, reconcile it in its recorded runtime first; a dead controller is not stop proof.

Stopped conversations are retired without copying provider session IDs into another runtime. Existing workspaces, native endpoint identities, exact evidence, findings, memory, policy, grants and budgets remain intact. The next coordinator starts a fresh Astra conversation using durable context. Retirement does not revoke valid historical evidence, but later contamination can still revoke it. No retired conversation can take another turn. Switching runtime never changes repository identity, private storage, authentication paths, worker defaults or permission grants, and does not imply cleanup of old resources.

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

`reconcile_fixture_creation` inspects a recorded creation without repeating SQL mutations. It requires an inspection grant after dispatch. An unmarked, changed or possibly still-running creation remains uncertain and is preserved. A replaced socket cannot prove that the old backend stopped. Only a never-dispatched intent, or confirmed backend stop followed by an absent resource, permits a new creation generation. Reset/cleanup remain unavailable. Successful creation alone does not make the fixture accessible to repository validation; SQL access requires the separate declaration and grant below.

## Restricted validation against a run-created fixture

Add a `fixtureValidation` entry alongside the corresponding fixture in the frozen policy. For example, these fields declare one disposable database and its dedicated SQL role:

```json
{
  "fixtures": [
    {
      "id": "browser-db",
      "provider": "postgresql",
      "socketDirectory": "/run/postgresql",
      "port": 5432,
      "role": "fixture_manager",
      "database": "browser_fixture",
      "expectedOwner": "browser_role",
      "operations": ["create"],
      "environmentBinding": "browser",
      "cleanup": "retain"
    }
  ],
  "fixtureValidation": [
    {
      "fixtureId": "browser-db",
      "validationRole": "browser_role",
      "listenPort": 55432,
      "connectionVariable": "DATABASE_URL",
      "pgbouncerExecutable": "/usr/bin/pgbouncer"
    }
  ]
}
```

The existing PostgreSQL service, management role, dedicated validation login, authentication configuration and native PgBouncer executable must already be prepared by the operator. Use canonical paths. Epicd does not install packages, create roles, change HBA/peer mappings or adopt an existing database. The management role needs authority to create the declared database for its expected owner; it is never exposed to repository commands. The validation role must have no superuser, role/database-creation, replication, RLS-bypass, membership or outside-object authority. The kernel also rejects unsafe callable functions, privileged parameter grants, foreign-data access and enabled event triggers. These deliberately conservative checks can reject an extension-enabled database. A broad peer-authenticated account is not a substitute for the dedicated role.

After reviewing the frozen declaration, grant SQL access separately from creation:

```bash
node dist/cli.js grant-fixture-validation RUN_ID browser-db --state STATE_PATH \
  --control-version VERSION --expires-at EXPIRY_ISO8601 \
  --psql-path /absolute/path/to/native/psql

node dist/cli.js revoke-fixture-validation RUN_ID GRANT_ID --state STATE_PATH \
  --control-version VERSION
```

The grant authorizes repository SQL in that disposable database under its dedicated role, including changes that PostgreSQL permits to the role's own password/settings. It does not authorize broader host administration. The provider/socket and broker identities are pinned; expiry is at most 24 hours. Granting access does not query, create or adopt a database. An inspection/creation grant, ordinary user response or model request cannot mint this permission.

Reference `"browser"` in a check's `environmentBindings`. The orchestrator chooses `provision_declared_fixture` and `run_validation` as separate actions. Validation requires this run's successful creation record, exact database OID/owner/marker, a current SQL grant, fresh role/catalog checks and no unresolved earlier access. The unchanged check receives `DATABASE_URL` for one private TCP database/role mapping. Its nested sandbox cannot see the upstream or admin sockets, broker configuration or broker processes. A check can use at most one host fixture and four total environment bindings; local-service ports and URL variables must be distinct.

SQLite binds each access to its validation operation, workspace evidence, creation generation and grant. Local process exit does not prove a PostgreSQL query stopped. The kernel accepts environment evidence only after both local stop and a fresh exact-resource observation with no other database connections. A timeout or revoked grant can therefore release the stopped local workspace while preserving the database exclusion. The orchestrator can use `inspect_fixture_access` and `reconcile_fixture_access` to inspect it without replaying SQL. A renewed grant permits a new read, not acceptance of an observation begun under the old grant. Reconciliation never changes failed or unverified evidence into a pass.

Unknown local stop, a replaced socket or unresolved remote work prevents reuse, runtime handoff and run completion. An already recorded local stop can be reconciled after current-format restart; a missing acknowledgment remains unknown. No automatic backend termination, fixture reset or cleanup is implemented. Both runtimes use this shared kernel, but the real PostgreSQL contract tests do not establish authenticated model-led browser recovery.

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
- `inspect_review` explains approval through a current kernel-derived assessment: the latest evidence ID, first unsatisfied condition and bounded references. The same evaluator guards commits. A review's `requiredChecks` lists outstanding demands, not already-satisfied tests; earlier demands remain binding after later reports or reviewer replacement.
- A task close requires a current verified publication and claim. The installed Beads close interface lacks atomic expected-owner/parentage comparison; fresh before/after checks detect conflicts but cannot eliminate that race. This remains a release blocker.
- Container closure requires proven closure of its own descendants; unrelated root tasks may remain open. Root closure additionally requires current independent whole-epic verification at the published SHA or its proven tracker-only ancestor. Neither a model verdict nor a successful Beads exit code substitutes for those proofs.
- `complete_run` inspects the live tracker graph and both publication refs, verifies this run's root-closure markers, published closed-scope tracker export and stopped work, then records completion and the successful action result in one SQLite transaction. Interrupted inspections can be reconciled without repeating a close. Workspaces, agent sessions, publication artifacts, tracker export copies and owned fixtures are explicitly retained for inspection, not silently deleted.
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

The unscripted SDK delivery acceptance uses the existing Codex authentication cache, installed Beads CLI and a generated one-task epic:

```bash
EPICD_LIVE_DELIVERY=1 npm test -- test/model-led-delivery.integration.test.ts
```

It allows up to 20 minutes of actual Astra work and always retains its printed private `/var/tmp/epicd-live-delivery-*` directory for diagnosis. It does not use the project's tracker or modify the user's checkout. The 2026-09-08 run passed complete SDK delivery, including nine context rollovers, three independent reviews, task/epic closure, final tracker publication, repository ownership release and preservation of the original checkout/index. This is one bounded acceptance case, not full release certification.

From a Herdr-managed caller, the native equivalent creates its own named server, private session registry and caller pane, then runs the same model-led acceptance through real native Codex TUIs:

```bash
EPICD_LIVE_HERDR_DELIVERY=1 npm test -- test/model-led-herdr-delivery.integration.test.ts
```

The native run allows 40 minutes. The harness retains its printed `/var/tmp/epicd-native-delivery-*` logs and child report as well as the run artifacts. It stops only its owned server after the child actually exits; an unknown child outcome retains the session for inspection. Neither terminal idle state nor a passed native-startup check proves whole-epic delivery.

The 2026-09-08 native acceptance passed in 26½ minutes: 72 decisions, ten Astra/high conversations, three approved independent reviews, task/epic closure and final tracker publication. All 60 turns had stop evidence; 58 had actual native endpoints and two were cancelled with never-started receipts. The run exercised two byte-bounded observation pages and preserved the original checkout, index, README and concurrent source edits. This live run preceded the subsequent large-action preview hardening; its exact evidence and follow-up verification are recorded in the plan. Receipt/browser recovery scenarios and the remaining resource/authority release audit are still open.

Set `EPICD_LIVE_DELIVERY_SCENARIO=receipts` before either live delivery command to exercise receipt contamination recovery. The test appends two receipts to a stopped private review copy, explicitly labeled as host-test fault injection. It requires model-chosen inspection, fresh independent exact-revision evidence, completed delivery and preserved user work; it does not demonstrate an immutable reviewer writing, active-turn intervention or knowledge reuse on a second task. Terminal results and remaining incident requirements are recorded in the plan.

The SDK receipt case passed on 2026-09-08 in 17½ minutes: 90 decisions, twelve Astra/high conversations, preserved contaminated evidence, three subsequent independent approvals and completed delivery. All 79 turns stopped. The native injected-receipt case subsequently passed at `f632686` in 38¾ minutes: 83 decisions, twelve Astra/high conversations, all 77 turns with native endpoints and stop evidence, three fresh approvals, final tracker publication, ownership release and preserved original work. These are bounded post-stop injection scenarios, not live wrapper-denial or browser recovery.

The opt-in fixture contract uses real PostgreSQL binaries but creates and stops its own Unix-socket-only cluster; it never uses an existing host database service:

```bash
EPICD_TEST_PG_BINDIR=/absolute/path/to/postgresql/bin npm test -- test/fixture-postgresql.integration.test.ts test/fixture-creation-postgresql.integration.test.ts test/validation-services.integration.test.ts test/delivery.integration.test.ts
```

For restricted host-fixture validation, also supply a native PgBouncer binary:

```bash
EPICD_TEST_PG_BINDIR=/absolute/path/to/postgresql/bin \
EPICD_TEST_PGBOUNCER=/absolute/path/to/pgbouncer \
  npm test -- test/fixture-bridge.test.ts test/fixture-bridge.integration.test.ts test/fixture-validation-policy.test.ts test/fixture-validation.integration.test.ts
```

These tests create their own roles and peer mappings only in owned temporary clusters. They cover actual SQL, privilege rejection, grant revocation, journal rollback, remote-stop exclusion and cold reconciliation; they do not configure the operator's PostgreSQL service.

The real browser fixture needs a local npm project containing `@playwright/test` and its matching Playwright headless Chromium directory. It bundles those dependencies and the current native Node executable into the temporary test repository; it does not expose a host browser/cache directory to agents or validation. The mechanical browser contract is:

```bash
EPICD_TEST_PG_BINDIR=/absolute/path/to/postgresql/bin \
EPICD_TEST_PGBOUNCER=/absolute/path/to/pgbouncer \
EPICD_TEST_PLAYWRIGHT_ROOT=/absolute/path/to/playwright-project \
EPICD_TEST_BROWSER_DIRECTORY=/absolute/path/to/chrome-headless-shell-linux64 \
  npm test -- test/browser-fixture.integration.test.ts
```

With the same four variables, set `EPICD_LIVE_DELIVERY_SCENARIO=browser` before either live delivery command. This scenario asks the actual implementer to report its source edit as completed while accurately retaining the real failed browser check. That faulty completion claim is a deliberate scenario instruction, not an injected report. The harness requires diagnostic follow-up, repository/configuration inspection, observed database absence, authorized creation, green kernel browser evidence before review, verified delivery and preservation of the test/oracle/dependency files. SDK browser work has a 30-minute controller deadline; native Herdr has 60 minutes. The test stops only its owned PostgreSQL server and retains its data and run artifacts. The mechanical contract has passed; authenticated browser-recovery acceptance is not yet established.

The original dispatcher and its dedicated tests have been removed. Their history remains in Git; old state, user repositories, and user-owned Herdr resources are not deleted by this hard cut.

## License

MIT
