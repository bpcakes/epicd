# Native macOS plan — independent review round 4

This is the fourth actual sequential review. Reviewed current `plan.md`, all `tasks.json` packets, the round-3-to-round-4 diff, and `/var/tmp/epicd-macos-plan-round4.md`. Current plan matched that snapshot exactly. Rechecked MAC-15's bootstrap/doctor source anchors. No source/plan/tracker mutation, native experiment, privileged installation, or model test was performed.

## Final planning verdict

Pass: no remaining actionable review findings. The plan is at steady state and ready for conversion into the requested single Beads epic with self-contained task descriptions and blocking edges preserved. All four review rounds are real; the fourth adds no new implementation or scope requirement.

This verdict is planning readiness, not proof native execution is feasible. MAC-01 still must establish an unprivileged native arbitrary-descendant containment/stop mechanism with both mechanism reasoning and adversarial evidence. A negative experiment keeps that task and its runtime consumers blocked. No VM, process-group-only substitute, permanent unknown backend, or hidden privilege installation satisfies the plan. SDK, Herdr, service and installed-artifact release gates remain unexecuted implementation obligations.

## T1 and steady-state verification

MAC-14 now explicitly separates held-parent custody from source-basename stability. It checks registered source identity before rename, checks archived identity after independently proven worker stop, and reports a preserving conflict for a replaced entry. The barrier-based source-name replacement fixture and prohibition on compensating moves are present. T1 is resolved.

The last diff is 12 added lines in MAC-14, with no task split, dependency change, architecture replacement, or acceptance weakening. This is a marginal clarification of an existing identity invariant.

## Standalone MAC-15 assessment

Pass. Its packet names the implementation entrypoints and required prerequisite products, distinguishes discovery, explicit disposable probes and state-changing admission, and defines failure timing and output contracts. Native create/resume/handoff checks use the established backend and identity contracts. Passive doctor must label untested dynamic properties unknown, while help/version remain independent of SQLite, authentication and helper availability.

Its failure matrix covers missing or replaced helpers, unsupported platforms/volumes, policy and executable failures, foreign state and noninteractive output without creating durable runs or ownership. MAC-21 is an explicit prerequisite, so resume identity behavior no longer depends on a later task. A fresh implementation agent can work from this packet once its listed prerequisites have completed; no additional product choice is required from the user.

## Rationale sample

| Decision | Assessment |
| --- | --- |
| D2 | Pass: transport choice and physical execution are independent axes, with persisted bindings preventing silent policy changes. |
| D5 | Pass: opaque local handles avoid path-reopen races; supervisor custody survives controller disconnection. |
| D8 | Pass: narrow resource admission is justified by the credential/state boundary and measured access-policy equivalence. |
| D9 | Pass: executable, resource, host and filesystem identity checks prevent silent substitution after upgrades or path changes. |
| D11 | Pass: native service qualification addresses loopback's different isolation properties and remains part of final parity acceptance. |

## Graph and plan consistency

- All 25 JSON bodies exactly match their plan task packets.
- The declared dependency graph is acyclic; every task reaches MAC-25.
- Every consumer list matches inverse prerequisite edges.
- The current plan exactly matches the round-4 snapshot.
- Earlier ordering, identity-schema, helper-custody, receipt-format and CI-completion fixes remain intact.
- Primary arm64 support, conditional Intel claims, native-only execution, current-format recovery, Linux regression protection and separate live SDK/Herdr evidence remain consistent throughout the plan.

No additional planning revision is requested. Beads conversion must retain the positive feasibility gate and must not turn unresolved implementation work into completed acceptance.
