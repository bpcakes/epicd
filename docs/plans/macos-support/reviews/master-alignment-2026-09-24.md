# macOS epic alignment with master

Audited `master` and fetched `origin/master` at `48e1577` on 2026-09-24.
The original plan targeted `9e66f49`. This audit updates planning and Beads;
it does not implement or qualify native execution.

## Findings resolved

| Current master evidence | Plan correction |
| --- | --- |
| `src/cli.tsx`, `src/epic-browser.ts`, `src/tui/epic-picker-session.tsx`, `src/tui/account-editor-session.tsx`, `docs/epic-browser-contract.md` already implement the browser/account workflow | MAC-17 now integrates and qualifies existing functionality on macOS. Preserve pagination, search, journal-backed actions, frozen resume accounts, scoped Ink cleanup and noninteractive stderr help/exit 1. Noncreating browse/cancel state inspection remains explicit new work. |
| `src/bootstrap.ts` stages read-only preflight, account freezing and delayed atomic policy initialization; `src/adapters/repository-policy.ts` supports missing-policy defaults | MAC-15/17 preserve confirmed Start onboarding and explicit account-default Save. Passive doctor/browsing remains non-mutating; malformed policy is never overwritten. |
| `src/adapters/runtime-discovery.ts` owns lazy typed Effect APIs; bootstrap retains compatibility wrappers | MAC-12/15 use current source locations and pinned Effect v4, preserving original failures, sequencing, interruption settlement and lease-finalizer precedence. No second resolver or wholesale Effect rewrite. |
| `src/domain/agent-execution.ts`, `src/domain/agents.ts`, `src/adapters/agent-dispatch.ts`, `src/adapters/agent-journal.ts` persist execution and exact turn ownership per generation | MAC-02/08/21 extend existing contracts with host identity, preserving provider/runtime distinctions, mismatch guards, account bindings and explicit continuation transfer. Recovery uses recorded execution and does not require new-launch readiness for settled history. |
| `src/domain/accounts.ts`, `src/adapters/accounts.ts`, `src/adapters/codex-credentials.ts` freeze per-class source selection and project refresh-free tokens | MAC-02/05/08/11/13/15/17/21 cover class inheritance, credential/source continuity, private-file custody, canonical overlap checks and immutable resume selection. No automatic account fallback or pool feature is introduced. |
| `src/adapters/account-model-discovery.ts` directly uses Bubblewrap and durable command supervision before a run exists; `src/adapters/codex-settings.ts` owns model-list lifecycle | MAC-05 owns its neutral profile; MAC-06 owns durable command/stdin support; MAC-08 ports the actual pre-run process; MAC-15 orders admission; MAC-21 covers retained cleanup intent/receipts. Synthetic operation ownership needs no run row/controller lease. Unknown stop retains private resources. |
| Orchestration/run/agent schemas are 48/4/3 | MAC-02 inventories the current baseline and coordinates one next-format change. No old-record migration, optimistic binding defaults or independent per-task bumps. |
| `.github/workflows/ci.yml`, `package.json`, `vitest.config.ts` now use fast validation, four Ubuntu integration shards, bounded parallel workers | MAC-18 extends this layout, retains Linux coverage and Node 22.12.0 minimum, ports GNU-script/Linux-path PTY fixtures, and requires real native test inventory. Existing two-file platform jobs cannot certify native delivery. |
| Both real model-led acceptance harnesses remain Linux-gated | MAC-23/24 remain required, with current accounts, default/explicit models, recorded dispatch, retained handoff and restart. MAC-25 documents the delivered command surface plus qualified native support. |

## Remaining blockers and scope

`createRunEffect` and native Codex package selection still reject Darwin. Namespace supervision,
Bubblewrap, descriptor paths under `/proc/self/fd`, GNU disposal operations and ELF-only admission
remain native blockers. The new account-model discovery path adds another explicit consumer of them.
MAC-01 still requires a positive native arbitrary-descendant containment result; this audit supplies
no such proof. Its investigation is bounded by candidate mechanisms, counterexamples and an explicit
decision report. A failed result leaves implementation dependent on that guarantee blocked.

Apple Silicon remains required. Intel is optional only after equivalent qualification. The macOS 14
floor remains proposed, pending primitive/OS evidence. Historical September 9 native probes and
source research were not rerun or represented as current release qualification.

## Graph and tracker changes

Keep epic `epicd-m7r` and all 25 stable child IDs. Add one true prerequisite:
`epicd-m7r.8` depends on `epicd-m7r.6`, because native pre-run model discovery consumes the
generic durable command/stdin port. MAC-12 remains executable discovery and does not depend on
the supervised probe, avoiding a discovery/profile cycle.

The intended graph has 103 blocking edges plus 25 parent edges. MAC-01 and MAC-02 remain ready;
every task reaches MAC-25. Reverse-edge lists are derived from prerequisites rather than manually
maintained in each packet. All tasks remain open because the remaining native acceptance is unfulfilled.

## Evidence and validation

Two independent focused source reviews covered runtime/accounts/recovery and UI/CI drift.
A final focused consistency review checked the revised ownership, onboarding and graph boundaries.
Its two findings were corrected: installation authority now precedes active first-run discovery,
with interrupted-probe cleanup coverage, and policy preservation checks distinguish failure before
publication from later failure that can leave valid defaults. Neither change adds a task or edge.
Machine readback results are recorded in `../beads-audit.json`; historical import results were retained
in `beads-import-audit-2026-09-09.json`. Earlier numbered review reports certify the original baseline only.

The preceding master-transport verification built successfully and ran the CLI integration file:
12 passed, 3 skipped, 2 failed on canonical `/private/var/tmp` versus `/var/tmp` expectations.
MAC-18 now requires fixing those fixture expectations while preserving exact recovery diagnostics
and production identity checks. That run is historical evidence for this audit, not a new passing test.
No product tests or live model runs were executed for these planning-only changes.
