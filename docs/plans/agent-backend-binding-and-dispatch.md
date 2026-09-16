# Persist agent execution bindings and route execution and recovery through them

This ExecPlan records the first implemented slice toward configurable implementation agents.
It is grounded in repository revision `b591c15`, inspected on 2026-09-12. No
repository-specific `PLANS.md` was found. The Codex-only foundation is complete;
Claude adapter work remains out of scope.
Maintain Progress, Surprises & Discoveries, Decision Log, and Outcomes &
Retrospective as work proceeds.

## Purpose / Big Picture

An agent generation must keep the backend and execution configuration with which
it was created. A backend is the coding agent implementation, initially Codex and
later potentially Claude Code. A runtime is how that backend runs; the existing
names `sdk` and `herdr` mean Codex SDK execution and a native terminal in Herdr.
A generation identifies one particular agent conversation and workspace owner.

After this slice, every new Codex agent records enough configuration to select
its driver after a controller restart. Every execution, interruption, and recovery
operation uses that recorded selection. Run settings supply defaults for new
agents. They do not select a driver for an existing agent. Operators can inspect
the recorded backend and runtime without exposing credential material.

The observable acceptance is a real persisted agent and turn surviving database
reopen and controller replacement, reaching the correct execution or recovery
adapter without redispatching an uncertain prompt. Both existing Codex runtimes
remain functional. A recorded native turn can be reconciled from its supervisor
without first satisfying native-launch prerequisites.

The follow-up owned by `epicd-4du` adds two recovery guarantees. An operator may
explicitly transfer one stopped coordinator conversation across a runtime handoff;
the old generation loses active ownership before the new generation can resume it,
and ordinary replacement never opts into reuse. Separately, an unreadable agent
record removes authority from that generation without making unrelated valid
history unusable. Provably stopped malformed owners are isolated automatically;
unsettled work whose stop cannot be proved remains a narrow fail-closed boundary.

This is a Codex-only foundation. It does not enable Claude selection, add a Claude
SDK dependency, change the coordinator model, migrate turns to app-server, or
expose mixed runtimes through new CLI flags. Those are separate feature slices.
Do not publish a selectable backend that cannot actually execute.

## Progress

- [x] (2026-09-12) Trace reservation, launches, settings, runtime handoff, worker/review/coordinator dispatch, and restart recovery.
- [x] (2026-09-12) Define the first slice, persistence decision, lifecycle rules, and behavioral acceptance.
- [x] (2026-09-13) Milestone 1: Persist and validate complete Codex agent bindings, including frozen execution, launch envelopes, account identity, and provider uniqueness.
- [x] (2026-09-13) Milestone 2: Route every execution and recovery entry point through exact persisted agent identity; remove run-wide driver bridges and migrate test harnesses to explicit dispatchers.
- [x] (2026-09-13) Milestone 3: Prove restart behavior, retain existing Codex behavior, and document the state-format boundary.
- [x] (2026-09-13) Review repair round 1: remove the ignored launch auth override, admit live-fixture accounts through the production resolver, preserve the built Herdr dispatcher entrypoint, and isolate malformed owner records during recovery. The recovery regression also exercises the real SDK dispatcher through prevented-launch stop proof and custody release while retaining the malformed-owner unresolved path.
- [x] (2026-09-13) Follow-up design: define explicit, exclusive coordinator-session transfer and the rule that corruption removes authority from the affected generation rather than availability from the run.
- [x] (2026-09-13) Milestone 4a: persist an explicit stopped-session transfer, claim it exactly once for the replacement coordinator, and reject concurrent or implicit session reuse.
- [x] (2026-09-13) Milestone 4b: split exact reads from tolerant operational projections, isolate provably stopped malformed owners, and keep unproven work fail-closed with actionable recovery state.
- [x] (2026-09-13) `epicd-yc7`: complete snapshot-scoped ownership assessment, post-reconciliation incident reporting/admission, and explicit safe conversation-transfer abandonment. Full validation: 1,612 passed, 88 skipped; build, typecheck, and formatting passed.
- [x] (2026-09-13) `epicd-ub9`: separate durable allocation, conversation execution and recovery contracts; include relinquished claimants across transfer lineage; preserve diagnostics and idempotent abandonment. Validation: 211 affected tests plus five final-build smoke checks passed.
- [x] (2026-09-13) Final comprehensive-review repair: make consumed transfer authority independent of later source-payload damage, enumerate exact claimants relationally, assess valid owners together with their turns, reconcile stopped turns before decoding damaged owners, and supersede queued mail for isolated owners with an audit event. Orchestration format 47 records the transfer claim as a foreign key on each agent generation.
- [x] (2026-09-13) Milestone 4c: update CLI/TUI documentation and deterministic restart, authority, evidence, and exclusivity regressions; run focused and project validation.

Implementation allocation: Luna Max performs routine commands, coding, testing,
log checks, and polling. Root Astra owns planning, milestone reviews, and blocker
decisions. This allocation is preserved in the handoff notes for the slice.

## Context and Orientation

`src/domain/types.ts` defines role model/effort preferences and session contracts.
The contract now contains the required Codex backend discriminator alongside
runtime, requested settings, and effective settings. `src/controller.ts:agentContract`
builds that contract from current run settings. `ControlledAgentDispatcher`
constructs an adapter from the selected agent's persisted execution binding for
each operation.

`src/adapters/agent-journal.ts:reserveAgent` transactionally reserves the agent,
assignment, and workspace relationship. It already freezes a purpose-aware
`accountBinding`. `src/domain/accounts.ts:accountBinding` handles implementation,
review, verification, final review, epic repair, and specialist inheritance.
Credentials are external to SQLite: bindings contain paths and identity digests.
Retain this existing account policy and its principal/source validation.

`src/adapters/controlled-launch.ts:ControlledLaunches` builds per-turn launch
manifests from the frozen agent execution, settings, and account binding.
`AgentJournal.bindLaunch` checks account, model, workspace, source permissions,
and the persisted launch↔agent binding before submission.

`src/adapters/controlled-sdk.ts` and `src/adapters/controlled-herdr.ts` execute
turns and reconcile interrupted launches. `src/domain/codex-launch.ts` contains
the manifest, its digest, the launch-owning controller lease, optional native
endpoint, and independent process-stop receipt. These mechanisms establish which
process generation stopped; neither model output nor terminal idle state is proof.

`src/kernel/agents.ts` covers ordinary agents, specialists, follow-ups,
replacement, and interruption. `src/kernel/reviews.ts` covers initial and final
review execution plus failure cleanup and reconciliation. Delivery recovery in
`src/kernel/delivery-recovery.ts` can reach review reconciliation independently.
`src/orchestrator/sdk-source.ts:ControlledDecisionSource` also consumes the driver,
despite the filename, and handles persisted coordinator decision attempts.

`src/adapters/runtime-handoff.ts` requires stopped turns and settled operations,
retires old agents, and changes run defaults. This is an explicit transition to
fresh conversations, not conversion of an existing conversation to a new runtime.
`src/kernel/settings.ts` already applies model/effort changes to future assignments.

Follow `docs/plans/effect-v4-adoption.md`: keep Promise-facing controller and driver
interfaces, existing synchronous SQLite transactions, and current process owners.
Do not combine routing work with an Effect concurrency or resource-lifetime rewrite.
Use the existing pinned dependencies only.

## Proposed Data and Interface Boundaries

Extend the existing session contract with a required `backend: "codex"`
discriminator. Retain `runtime`, `requested`, and `effective` in their existing
locations and preserve Codex model/effort validation. This gives future Claude
settings a distinct schema branch; do not invent that branch or translate effort
names in this slice. Backend selection is explicit in persisted records even
though Codex is the only supported value initially.

Add a required `execution` field to `AgentInstanceSchema`. Define its schema in
`src/domain/agent-execution.ts`. It contains the canonical executable path,
private runtime root, turn timeout, and either a null Herdr configuration or the
existing Herdr executable/session-name/workspace-id tuple. Validate the tuple
against `agent.contract.runtime`. Keep backend, runtime, and model settings in
the contract rather than duplicating them in this field. Keep the existing
`agent.accountBinding` as the sole credential binding; do not copy credentials or
introduce an account registry alongside the existing account snapshot.

Freeze execution fields and account binding inside `reserveAgent` from trusted
run configuration, in the same transaction that reserves the agent. They are not
model-supplied `start_agent` fields. Validate that the requested contract agrees
with the currently admitted backend/runtime before inserting records. Preserve
the existing purpose-specific account lookup. Production reservation requires a
configured execution source; update fixtures that currently omit configuration
instead of adding ambient PATH or HOME fallbacks.

Add the backend discriminator to `ProviderIdentitySchema`, retaining the existing
runtime-specific session and terminal fields. Session identity begins as null at
agent reservation and is attached only from trusted adapter observations. It is
not available to freeze before first execution. Validate backend and runtime
agreement on every provider attachment, follow-up, and session reuse. Scope the
existing provider uniqueness key by backend as well as runtime and session or
terminal identity; preserve the current generation/collision rules.

Add backend and runtime to the persisted `TurnLaunch` envelope and compare them
with the owning agent. Keep `CodexLaunchSchema`, its wire manifest, and stop
receipt payload Codex-specific. There is no need for a universal launcher or
another credential format. Continue validating the manifest digest and controller
lease, and validate its executable, derived private paths, account, settings,
workspace, and source permissions against the recorded agent binding.

Introduce `ControlledAgentDispatcher` and its implementation in
`src/adapters/agent-dispatch.ts`. Its public operations are:

    assertSupported(contract: AgentSessionContract): void
    run(authority: ControllerAuthority, identity: TurnIdentity,
        signal?: AbortSignal): Promise<TurnRecord>
    reconcile(authority: ControllerAuthority,
              identity: TurnIdentity): Promise<TurnRecord>

`assertSupported` checks the supported backend/runtime combination without
starting processes, resolving executables, or authenticating. `run` and
`reconcile` load the exact persisted turn and agent generation, assert controller
authority, and select the appropriate adapter. Keep `ControlledAgentDriver` as
the concrete adapter interface, adding backend identity alongside its existing
runtime `kind`. Use a small explicit factory for the two supported combinations,
not dynamic plugins. Supply injectable factories for tests, with production
selection and validation still exercised.

Construct concrete drivers from `agent.execution`. `ControlledLaunches.reserve`
must use the recorded agent account and settings and verify all constructor
configuration against the binding; remove the production credential fallback to
an unrelated constructor source. On recovery, the existing per-turn manifest is
the authoritative process identity, validated against its agent. The manifest
does not acquire new settings from the current run. Initially avoid driver caching;
if later needed, key by complete binding or agent generation, not role alone.

## Milestone 1: Bind New Agents and Their Launches

Implement the domain changes and transactional reservation first. Update
`agentContract`, agent and launch fixtures, `recordProvider`/`bindTurnProvider`,
`bindLaunch`, and `bindNativeLaunch` checks together. New launches must preserve
the recorded executable and derive the same generation-owned directories from
the recorded runtime root. Validate the native session and workspace against the
recorded Herdr tuple; continue recording and validating exact socket, pane, tab,
and terminal identities at launch time.

Use the frozen run account snapshot to authorize an account at reservation. At
launch, validate the frozen agent account and the credential source's identity,
without selecting an account again from current role preferences. Keep existing
checks against the immutable account snapshot where they establish admission;
the snapshot must not become a way to retarget an existing agent. Token refresh
for the same validated principal remains possible through the existing adapter.

This milestone is complete when reopened agent records retain the same contract,
execution fields, and account binding, and attempts to bind a launch with a
different executable, account, settings, workspace, or runtime fail before
dispatch. Test each account purpose, especially specialist fallback and epic repair.
Existing account-routing and journal tests must continue to pass.

## Milestone 2: Dispatch and Recover by Persisted Agent Identity

Replace the single driver constructed in `OrchestratorController.run` with the
dispatcher. Remove the controller-wide `driver.kind === state.runtime` test.
Keep backend/runtime validation at reservation, driver selection, and concrete
adapter entry, where it can check the relevant agent rather than all run history.

Pass the dispatcher through `registerAgentCapabilities`,
`registerReviewCapabilities`, `reconcileReview`,
`registerDeliveryRecoveryCapabilities`, `reconcileDeliveryAction`, and
`ControlledDecisionSource`. Replace each single-driver runtime check with the
corresponding supported-contract check or persisted-agent dispatch. The driver
factory used by tests must follow this same boundary; do not leave a production
run-wide path as a testing convenience.

Trace these paths explicitly: start agent; start specialist; continue agent;
replace agent; interrupt agent; initial review; review follow-up; review failure
cleanup; explicit delivery reconciliation; startup's unsettled-turn sweep;
coordinator dispatch; coordinator attempt reconciliation; coordinator settings
rotation; and controller cancellation/drain. Preserve the current ordering of
repository ownership, recovery, action reconciliation, and new coordinator work.

Keep coordinator backend Codex and model `gpt-6-astra` enforced at reservation
and decision dispatch. Replacement requires old-work stop and existing workspace
rules, then gets a fresh binding. Model/effort updates affect future assignments;
follow-ups and decision retries retain their existing agent. Handoff retains its
global stop requirements, retires old generations, and only changes defaults for
future generations. Do not make handoff or replacement silently reuse a provider
session from another backend or runtime.

Separate launch prerequisites from recovery. In particular,
`ControlledHerdrRuntime` currently throws in its constructor when `HERDR_ENV`
is absent even though `reconcile` uses the supervisor and private transcript,
not Herdr discovery. Move the managed-caller requirement to native execution
before launch reservation or external effects. Recovery may construct the adapter
without a usable Herdr caller, credentials, or executable, provided it has the
recorded storage and supervisor identity. Preserve the refusal to launch native
work outside an admitted Herdr context.

Settled turns return their recorded state without requiring a runnable adapter.
Prepared turns may be cancelled through the journal's existing proof that no
dispatch was admitted. Submitted turns without a valid launch remain unresolved.
An unavailable adapter or invalid binding must never fall back to the current
run runtime, release an uncertain workspace, manufacture stop evidence, or retry
the prompt. Startup continues recording unresolved recovery observations and
attempting independent recoveries as it already does.

This milestone is complete when all named paths route by persisted identity and
native recovery works with `HERDR_ENV` absent. A stopped historical SDK agent
must remain inspectable after a legitimate handoff to Herdr, and the reverse.
Historical stop reconciliation must not initialize the new run-default driver.

## Milestone 3: Acceptance and Persistence Boundary

Add `test/agent-dispatch.integration.test.ts`. Use the real StateStore, journal,
and dispatcher with injected adapter factories to distinguish selection failures
from adapter behavior. Assert which persisted agent reaches which factory, and
assert that the other factory receives no calls. Use real supervisor fixtures for
process-stop assertions; a mocked return value is not evidence of descendant stop.

The main scenario creates an agent and prepared turn, closes and reopens storage,
acquires a replacement controller lease, and routes reconciliation through the
agent's recorded binding. Exercise SDK and Herdr separately, plus a valid
handoff with retained settled historical records. Exercise an unavailable factory
with a submitted turn and prove no alternate factory runs and no workspace is
released. Use adversarial invalid backend/endpoint/manifest records to prove
rejection, rather than exposing an unimplemented Claude backend to production.

Cover an interrupted real supervised launch with no Herdr caller, missing launch
executable, and unavailable credentials at recovery time. Its original supervisor
must either prove stop and allow cancellation or leave the turn indeterminate;
no discovery or model command may run. Preserve old-lease rejection, late result
ineligibility, no uncertain-prompt replay, decision retry budgets, session
continuity for healthy follow-ups, and independent review evidence requirements.

Add backend to the bounded agent summaries in `AgentJournal.summaries`, consumed
by status and orchestrator context. Do not serialize the execution binding into
model-facing context: executable paths, private roots, and account paths are
operator/control-plane data. Preserve existing runtime and settings output.

The existing store uses an exact-version hard cut: orchestration format 43 and
agent record schema 1 at the investigated revision. It has no migration path.
For this required-record change, advance the orchestration format once (44 if
still unused) and agent record schema, update fixtures, and document refusal of
older storage. Do not add a migration or silently infer missing bindings from
current run defaults. Leave run-state schema version 4 unchanged unless its actual
shape changes. This compatibility decision means existing active runs must be
finished or stopped with the old build; retained state remains available to that
build. A requirement for seamless upgrade would need a separately designed
migration and would materially enlarge this slice.

Acceptance includes opening an old-format fixture with the new build and
receiving the existing unsupported-format error without changing its logical
records, inventing backend data, deleting storage, or running external work.
Test rollback/reopen with the original build's format assumptions. Do not operate
on the user's real run databases to test an upgrade.

## Milestone 4: Exclusive Conversation Transfer and Damage-Scoped Recovery

Keep fresh conversations as the default runtime-handoff behavior. Add an explicit
operator option that retains only the stopped coordinator conversation. The
handoff transaction records a transfer bound to the source agent generation,
session ID, provider home, workspace, target runtime, account binding, and current
raw record digests. It retires the source before the transfer becomes claimable.
On resume, coordinator reservation claims that transfer atomically into the next
generation; no general replacement path may discover or reuse it. The transferred
generation reuses the stopped coordinator's immutable workspace and private
provider home so the pinned Codex session metadata and working-directory contract
remain intact. Scratch, artifacts, launch controls, and turn identities remain
generation-specific. A session may have historical owners but at most one
non-released owner or pending transfer.

Do not make broad collection reads silently best-effort. Exact `instance` and
`turn` reads remain strict. Add a recovery inventory that parses rows independently,
binds every incident to stable relational identity plus a raw-record digest, and
classifies an unreadable owner as isolated only when every dependent turn is
intrinsically valid and carries durable stop evidence. Returned historical turns
from an isolated owner have `resultEligible` projected false; the raw row is not
rewritten. Operational scans use valid agents plus this conservative turn
projection. A malformed owner with any unparseable or unstopped turn remains an
uncontained incident and prevents new coordinator work, publication, and completion.

Startup first attempts every recovery that still has a valid owner. It then records
one bounded observation for each isolated or uncontained owner. Isolated historical
owners do not prevent coordinator replacement or unrelated delivery. Uncontained
owners produce an actionable `controller_unavailable` escalation only after safe
automatic reconciliation paths are exhausted. Repeated restart is idempotent by
using the controller lease and raw-record digest in observation identity. Status
reports isolated and uncontained counts without exposing execution paths, account
material, or raw invalid JSON.

Acceptance requires a stopped SDK coordinator session to transfer explicitly to a
Herdr coordinator generation and the reverse journal boundary to remain symmetric;
a fresh handoff and ordinary replacement must not reuse it. A simultaneous live
binding of the same backend session must fail. An active run with one malformed,
fully stopped historical owner must create or resume a healthy coordinator and
must not treat the malformed owner's results as eligible. A malformed owner with
unproven work must not permit a replacement writer or run completion and must retain
its raw bytes. Restarting either scenario must not duplicate transfers, claims, or
recovery observations.

### Post-review boundary corrections — 2026-09-13

The review failures were not nine unrelated missing checks. They exposed three
boundary-design mistakes:

- conversation-scoped provider state and generation-scoped launch policy shared
  one `config.toml`, even though their lifetimes differ;
- continuation was treated as matching metadata rather than an ownership lineage
  with validated transitions and releasable claims; and
- the damage-tolerant recovery projection was reused to prove absence during
  authorization, so an unreadable record could disappear exactly where a conflict
  needed to fail closed.

Keep the provider home as durable conversation state, but materialize confinement
policy in the exact launch control directory and mount that immutable file over
`$CODEX_HOME/config.toml` for the launched namespace. A continued generation may
reuse the provider home; scratch, artifacts, controls, and policy remain owned by
the new launch. Validate the complete transfer lineage before provider binding or
shared storage, including fields derived from the source owner. A stopped target
that never acquired provider identity may relinquish its claim for a later exact
generation; consumed ownership is never silently released.

Recovery-tolerant collections are availability views, not authorization views.
Any proof that a workspace was never assigned, that a generation does not exist,
or that a reviewer has no implementation history must use relational identity and
treat malformed payloads as conflicts. Completion inventories relational resource
IDs even when a payload is unreadable. Model-facing projections use explicit
allowlists rather than subtracting known-private fields. Cross-record turn
validation loads one owner inventory and joins in memory, avoiding a historical
owner query for every turn.

Regression tests must cross the next real boundary: materialize a continued
launch, inspect the actual namespace mount arguments, bind a later Herdr turn,
exercise a three-generation transfer chain, corrupt schema-valid derived fields,
and count owner queries. Reservation-only assertions are insufficient evidence
that a launch or continuation remains executable.

## Concrete Steps and Validation

Work from `/home/aa/Documents/epicd`. Some integration tests import `dist`, so
build before running them. For implementation, run:

    npm run build
    npm run typecheck
    npm test -- test/agent-dispatch.integration.test.ts test/types.test.ts test/agent-journal.test.ts test/account-routing.integration.test.ts test/agent-settings.test.ts test/agent-replacement.integration.test.ts test/runtime-handoff.integration.test.ts
    npm test -- test/controller.integration.test.ts test/decision-source.integration.test.ts test/orchestration-recovery.integration.test.ts test/review.integration.test.ts test/reviewer-conversation.integration.test.ts test/delivery-recovery.integration.test.ts
    npm test -- test/controlled-sdk.integration.test.ts test/controlled-herdr.integration.test.ts test/codex-launch.integration.test.ts test/codex-launch-herdr.integration.test.ts test/codex-confinement.integration.test.ts test/store.test.ts test/store-process.integration.test.ts
    npm run format:check
    git diff --check

Expect the selected tests to pass and the new assertions to demonstrate the
behaviors above, not merely successful schema parsing or a renamed interface.
Existing authenticated tests may be gated by environment. Report those skips
explicitly; they are not live-model acceptance. Use the full `npm test` suite once
at the end because the schema and shared driver touch many fixtures. A routing
foundation does not require a new paid-model acceptance run. Do not claim Claude
execution or complete epic delivery from these tests.

## Idempotence and Recovery

No implementation or tracker mutation is authorized by this document itself.
During implementation, repeat tests against private temporary fixtures and retain
the old build for its existing databases. Never update stored bindings in place
to make a failed resume work. Reconciliation observes/stops the exact recorded
launch and preserves uncertain work. It cannot create a replacement turn. New
conversation creation follows the existing explicit replacement/rotation rules.

## Surprises & Discoveries

The existing account feature already supplies purpose-aware, per-agent identity
bindings. Generalizing authentication would add scope without helping dispatcher
selection. Evidence: `reserveAgent` and `src/domain/accounts.ts:accountBinding`.

Recovery is distributed across the controller, decision source, worker kernel,
and review/delivery recovery. A controller-only factory replacement would leave
important alternate paths tied to one runtime.

Native recovery does not call Herdr, but constructing its runtime currently
requires `HERDR_ENV=1`. This slice should remove that launch-only prerequisite
from recovery while retaining exact supervisor and journal validation.

The repository refuses previous storage formats rather than migrating them.
Backend persistence therefore has a release compatibility cost even before a
second backend is implemented.

The persisted launch↔agent validation must run before submitted-turn recovery
constructs or invokes an adapter. Recomputing a manifest digest alone does not
protect the owning agent binding, so recovery validates backend, runtime,
execution tuple, derived private paths, account, workspace, and contract fields
through a pure journal gate. Factory results are checked for the selected
backend/runtime and fail closed on an injected mismatch.

Component-only fixtures that reserve agents now provide an explicit frozen Codex
execution source. Foreign repository fixtures update their cloned common Git
identity so ownership checks remain meaningful under the hard-cut schema.

An operational turn projection is queried by several independent context
predicates. Giving it a separate immutable per-snapshot cache preserves the
existing one-full-history-read contract without allowing a tolerant projection
to satisfy an exact `turns()` call. The first exhaustive validation run exposed
this boundary with a read-count assertion (four reads instead of one).

## Decision Log

2026-09-12: Combine persistence and dispatch as one deliverable with sequential
milestones. A stored backend label without authoritative routing is incomplete.

2026-09-12: Keep production Codex-only initially, with its existing two runtime
adapters as concrete consumers. Claude selection and provider-specific settings
arrive with the actual Claude adapter, avoiding unusable public configuration.

2026-09-12: Extend existing contracts, account bindings, and launch envelopes.
Keep one authority for each field and avoid a generic authentication service,
plugin framework, universal launcher, or whole-controller Effect rewrite.

2026-09-12: Freeze execution configuration at agent reservation; bind session and
native terminal identity as observed later. Use per-turn launch records for stop
recovery. These are different stages of identity and must not be conflated.

2026-09-12: Follow the existing exact-version storage policy, explicitly disclosing
the inability to resume old-format runs with the new build. Do not silently add
migration behavior to a routing slice.

2026-09-13: Keep the public dispatcher boundary explicit in production and tests;
remove the former run-wide driver injection and omitted-backend conversion paths
instead of preserving fixture convenience through compatibility shims.

2026-09-13: Treat a valid but cross-record-mismatched persisted launch as unsafe
during recovery. Validate it against the owning agent before selecting a driver,
while leaving settled and prepared recovery paths adapter-free.

### Recovery assessment and transfer abandonment — 2026-09-13

The follow-up `epicd-yc7` completes the contracts identified by the comprehensive
review. Ownership assessment now returns valid ownership, isolated damage, or
uncontained damage and is reused only inside the existing immutable SQL snapshot.
Strict execution and relational absence proofs remain strict. Finished-review
eligibility rejects damaged ownership explicitly; status and coordinator context
retain its evidence and explain the blocker. Uncontained damage also denies
candidate currency and review approval without making those diagnostic projections
throw. Unexpected storage/programming errors still propagate.

Startup finishes its safe inspection/action reconciliation before its final
containment assessment. That assessment drives both observations and admission.
Observation IDs bind stable incident identity and the complete semantic report,
so identical restarts deduplicate and changed containment produces a new report.
A known uncontained-ownership admission error leaves its action unresolved while
reconciliation continues to independent actions; unexpected failures and lost
authority still propagate.

Orchestration format 46 adds terminal `abandoned` conversation transfers. The
trusted operator command `abandon-conversation` acquires a controller lease and
rechecks the observed control version inside the final transaction. It requires a
paused/blocked/awaiting-user run, settled coordinator requests/actions and workspace
I/O, no provider identity on any claim target, and exact turn/launch/mailbox stop
proof before retiring targets. It retains the original transfer and claimed target,
abandonment reason/time, and stopped-turn references. Consumed transfers cannot be
abandoned. Abandoned transfers cannot be reclaimed. Status and the console expose
only bounded transfer summaries, without provider homes or session IDs.

This supersedes the earlier prohibition on abandoning any open transfer: handoff
and completion still cannot silently discard a reservation, but the operator can
explicitly settle an unused one before choosing fresh continuity. Older storage
formats keep the existing rejection policy; no automatic migration rewrites them.

Acceptance crosses the next real boundary: database reopen after damaged finished
review ownership, startup after an uncontained-to-isolated transition, a failed
native resume before binding, explicit abandonment, and fresh SDK coordinator
execution. Negative cases retain exclusivity for live/uncertain/consumed targets,
and verify stale operator requests do not mutate the reservation.

Validation completed with `npm run build`, `npm run typecheck`,
`npm run format:check`, and the full `npm test -- --reporter=verbose` run:
**1,612 passed, 88 skipped, no failures** across 108 passing and 11 skipped files
(3,849 seconds). The earlier affected-suite run passed 98 tests; the first broader
run exposed an obsolete newer-format fixture (46 became current), corrected to
47 before final validation. The added regressions also cover rollback of claim
retirement on observation failure, immutable assessment lifetime, propagation of
unexpected storage errors, continuation past a known ownership admission denial,
the real CLI abandonment path, and abandonment alongside unrelated isolated damage.
Authenticated/live scenarios behind repository opt-ins remain skipped. No further
external model review was run; existing staged work and the index were preserved.

2026-09-13: Give the first epic-repair end-to-end integration case a 120-second
test budget after targeted repeats showed the workflow can complete near the
60-second boundary (59.160 seconds passed; two repeats reached 60.105 and
60.070 seconds). This changes only the test budget; command deadline assertions
and production timeouts remain unchanged.

2026-09-13: Runtime handoff remains fresh by default. Only the operator's
`--retain-coordinator-session` choice creates a durable pending transfer after
the source generation is confirmed stopped and released. The transfer pins the
source digest, session, provider home, workspace and target runtime, is claimed
by one exact replacement generation, and is consumed only when that generation
binds the exact session. Another handoff or run completion cannot abandon an
open transfer.

2026-09-13: Separate record validity from run availability. Exact agent and turn
reads remain strict. Operational scans omit unreadable owners, retain only
intrinsically valid stopped history with `resultEligible` forced false, and
report stable digest-bound incidents. A submitted or otherwise unproven launch
remains uncontained and reaches operator escalation only after automatic
reconciliation has been attempted.

## Recovery boundary follow-up — 2026-09-13

Tracked as `epicd-ub9`, following the second independent review. The remaining
faults share a contract problem: an operational projection is not an allocation
history, and permission to resume a provider is stronger than the evidence
needed to diagnose or retire a stopped reservation. Separate tests for failed
claims and multi-hop transfers missed the composition of those transitions.

The repair keeps synchronous fenced transactions and uses orchestration format 47:

- Coordinator slot counts use relational agent/workspace history, including
  unreadable owners. Failed-copy retry identities and budgets remain stable.
- Storage sharing follows the verified conversation lineage. A relinquished
  claimant must precede the successful claimant of an exact lineage transfer,
  retain the same continuation binding, have no provider identity, and have
  proven turn/launcher stop. Sharing a session or path string is insufficient.
- Execution reads still require a valid source contract. Abandonment can use
  an isolated source's relational workspace and strictly validated claim targets
  without reconstructing its damaged execution record. Uncontained sources,
  malformed transfer records, bound targets and unsettled work remain blockers.
- Open-transfer existence uses relational status; it cannot disappear because
  a source or transfer record is unreadable. Status decodes each bounded row
  independently and reports unreadable entries with their relational identity.
- Abandonment retires claims directly into the terminal transfer outcome. It
  does not emit a relinquishment event. Terminal retries acknowledge the same
  transfer before checking the obsolete control version; first-time mutations
  retain version, pause, lease and stop checks.

Open questions resolved from the code:

1. The previous retry path always called `noteSettingsChange`, even when the
   agent journal returned an already-abandoned transfer. The operator wrapper
   also rejected the original version before reaching that result. Both layers
   now defer to the fenced terminal acknowledgement, preserving events and
   control state on retries.
2. Global uncontained ownership intentionally makes candidates ineligible.
   `ReviewJournal.reserve` now reports `agent_integrity_uncontained` explicitly
   before its ordinary current-candidate checks, consistent with approval
   assessment. Candidate validity remains conservative.
3. `OrchestratorLoop.obtainDecision` only retries `transient` outcomes, at most
   `MAX_DECISION_SOURCE_ATTEMPTS = 3`. `ControlledDecisionSource.decide` turns a
   stopped unsuccessful resume into a `runtime` failure; the loop escalates it
   after one attempt. Durable provider failures also do not authorize automatic
   prompt replay. No additional retry budget or operator preference is needed.

The relinquishment finding concerns audit semantics, not concurrent exposure:
other SQLite connections see committed transactions, not the intermediate
pending update ([SQLite isolation](https://www.sqlite.org/isolation.html)).
The event should describe the terminal operation the operator requested.

Regression coverage composes corruption, failed claims, later runtime handoffs,
reopen, duplicate operator commands and negative stop cases. No external model
or native Herdr service is needed to establish these journal guarantees.
Validation: all 211 tests passed across controller, runtime handoff, review,
decision-source, agent journal, read snapshot, operator controls and operator
view suites. The final build passed a further five selected coordinator and
transfer recovery smoke tests (71 other tests filtered out). Build, source/test
typecheck, formatting and diff checks passed. The prior full-suite result above
predates this follow-up; the full suite and independent external review were
not repeated for these repairs.

## Final recovery-boundary repair — 2026-09-13

The final Claude, Codex, and Cursor review found five manifestations of one
remaining design error. Recovery code still used schema-valid operational JSON
as both payload and ownership authority. That made later damage to a historical
source revoke an already-consumed transfer, let a readable owner hide malformed
turn history, forced abandonment to decode unrelated generations, and made queued
mail look like evidence of an external process that might still be running.

The corrected boundary has three independent layers:

- Relational columns establish durable identity and attribution. Format 47 adds
  `agent_instances.conversation_transfer_id`, a foreign key whose value must
  equal the continuation transfer ID in readable JSON. Exact claimant lookup and
  multi-hop lineage traversal use this column even when an agent payload is
  isolated.
- JSON schemas validate the payload needed for an operation. Execution entry
  points remain strict. Recovery parses each exact turn independently, so a
  stopped turn can settle an action or review without first decoding its owner,
  while a submitted turn with an unreadable owner still fails closed through the
  stable `agent_integrity_uncontained` boundary.
- Stop receipts establish whether external work may remain. A valid agent is no
  longer admitted when any of its own turns is malformed. An unreadable historical
  owner is attributed only the active turn named by relational turn ownership;
  a successor's turn on a shared coordinator workspace does not revive the old
  generation's authority.

A consumed transfer is the durable grant produced after exact claim and provider
binding. The transfer row and target's relational claim remain authoritative;
later source-payload damage can disqualify source evidence, but cannot silently
release or revoke the successor's conversation ownership. Pending and claimed
transfers still revalidate their readable source because ownership has not yet
completed. Abandonment examines only relationally exact claimants and reports a
stable recovery error if one of those payloads is unreadable.

Mailbox rows are durable delivery intent and audit evidence, not process-lifetime
proof. Startup supersedes still-queued messages addressed to an isolated owner,
preserves their content and target identity, and records one idempotent audit
event. Reserved messages remain governed by their exact turn and its stop proof.
This lets safe recovery continue without erasing the historical request or
pretending an undelivered message can execute on its own.

No additional product choice is required for these invariants. Authenticated SDK
and managed Herdr acceptance remain environment-gated checks; they can add live
provider evidence but cannot change the journal guarantees above.

Validation completed against the rebuilt artifact: 226/226 affected journal,
dispatcher, runtime-handoff, controller, review, orchestration-recovery, and
state-format tests passed. Build, source/test typecheck, selected formatting, and
diff checks also passed. Existing staged work and the Git index were preserved.

## Outcomes & Retrospective

Milestones 1 through 3 are implemented. New agent records use schema version 2 with
frozen Codex execution bindings, launches carry backend/runtime identity, and
orchestration storage uses format 45. Controller, worker, review, coordinator,
replacement, handoff, and recovery paths select the exact persisted generation.
The acceptance dispatcher suite has passed 28/28, including inspect-agent
serialization, native endpoint binding and recovery integrity, and direct
adapter option checks. No Claude flags, adapter, or generic credential/plugin
framework was added.

Validation complete: build, source/test typecheck, format check, and
diff-check pass. Post-fix focused SDK/journal suites report 72 passed and 7
environment-gated Herdr skips; earlier focused evidence remains controller
33/33, delivery recovery 29/29, review 24/24, commit recovery 7/7, workspace
disposal 22/22, workspace creation 9/9, validation I/O 2/2, workspace
inspection 69/69, and agent journal 46/46. The first full-suite attempt was
blocked by an exhausted `/var/tmp` and stopped by Vitest with 116 failed
suites caused by ENOSPC; only test-created `epicd-*` artifacts were removed,
recovering disk space. After the targeted fixture and test-budget fixes, final
serial full-suite session 80483 (`fileParallelism: false`) completed with 108
files passed, 11 skipped, and 1,586 tests passed, 88 skipped (exit 0). No
large workspace or supervised-process accumulation remained; only the small
review crash fixtures intentionally retained by the tests were present.
Environment-gated native Herdr and authenticated model tests account for the
explicit skips.

The receipt and tracker failures were fixture migration regressions, not
production routing failures. The review fixture now routes its explicit fault
driver through the dispatcher factory, and preserves the intentionally
unconfigured tracker-root state for the late-claim test while still supplying
an explicit execution source. Isolated receipt recovery is 2/2; tracker
closure is 21 passed/1 skipped. The command-deadline suite is 4/4 in
isolation; its two full-suite timing failures are baseline-sensitive and the
deadline path is unchanged. Epic-repair diagnosis found all dispatcher work
complete and only the first end-to-end test budget was too close to its
60-second limit; that case now has an explicit 120-second budget for the final
full-suite run. The final full suite passed after these bounded changes.

Review repair round 1 addressed three independently verified medium findings.
`ControlledLaunchOptions` no longer exposes an ignored `authCachePath`; live
SDK and Herdr fixtures now freeze accounts through `loadAccountDraft` and
`freezeAccountDraft`, while synthetic accounts remain local to fake runs. The
Herdr dispatcher fixture forwards the same built launcher entrypoint as its
direct runtime. Startup recovery now uses an isolated per-row turn walk and
records malformed owner rows as unresolved while continuing valid submitted
turns; strict ordinary instance/turn reads remain fail-closed, and status
projection reports unreadable rows without exposing private execution/account
fields. Focused post-repair validation passed 142 tests with 7 gated skips and
no failures; the strengthened recovery regression passed 1/1 and the affected
controller/dispatcher/SDK suites passed 88 tests with 3 gated skips. Build,
source/test typecheck, format, and diff checks passed.

Milestone 4 implements explicit, exclusive conversation transfer and
damage-scoped owner recovery. Orchestration format 45 and agent schema version 3
persist the transfer/continuation records. SDK and Herdr resume the pinned Codex
session from the retained provider home, while active provider identity is
globally exclusive and historical reuse without an open exact-target transfer
is rejected. The CLI and operator console expose retention as an opt-in; ordinary
handoff and replacement continue fresh.

Malformed stopped owners now lose authority locally: strict reads still fail,
operational scans continue with healthy generations, historical results become
ineligible, and status/observations report isolated damage without exposing raw
records. Only malformed owners associated with work whose integrity or exact
stop cannot be proved become `recovery.owner_uncontained` and lead to the
existing `controller_unavailable` intervention path.

Post-implementation build, typecheck, format and diff checks pass. Focused
handoff, journal, operator and state-format validation passed 120/120. The first
serial full-suite run completed 1,591 passed, 88 skipped, and one failed
read-snapshot work-count assertion; it found that the new operational projection
was uncached. After adding an independent immutable operational-turn snapshot
cache, the exact failing snapshot suite plus journal, controller and runtime
handoff suites passed 115/115 against a fresh build. A final serial full-suite
rerun then completed with 108 files passed, 11 environment-gated files skipped,
1,592 tests passed, and 88 skipped (exit 0). No paid-model acceptance run was
needed for this storage, recovery, and runtime-routing change.

Post-review structural repair separated durable provider state from per-launch
policy, made conversation reuse follow a validated multi-generation lineage,
added safe/audited relinquishment for stopped unbound claims, and removed
recovery-tolerant projections from absence and independence proofs. Prepared-turn
recovery now uses ordinary owner-aware cancellation whenever the owner is
readable. Model-facing agent inspection is an explicit allowlist, and turn-history
validation performs one owner inventory instead of one owner query per turn.

Focused post-repair validation passed controller 34/34, runtime handoff and review
54/54, and journal/launch/snapshot/dispatch 97 passed with 5 environment-gated
skips. Build, source/test typecheck, formatting, and diff checks passed. The serial
full suite completed 1,598 passed and 88 skipped with two failures in unrelated
load-sensitive fixtures: an 8-second PTY transition poll and a `/proc` disappearance
reported as `ESRCH` rather than the fixture's accepted `ENOENT`. Both exact files
then passed together in isolation, 8/8. The repair did not change those test or
production paths.

The following feature slice can add a real Claude backend, its role preference
and credential admission, and supervised headless execution/recovery. It will
also need its own confinement and output/session contract. This foundation does
not claim to solve those provider-specific requirements.

Revision note, 2026-09-12: Initial proposal expands the two requested scope items
into one bounded deliverable and records the launch/recovery separation and
storage compatibility findings from repository inspection.
