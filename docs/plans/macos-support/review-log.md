# macOS planning review record

This log records work actually performed during planning, not future implementation acceptance.
The plan uses native macOS execution only, as explicitly requested by the user.
The review models are the available independent coding/reasoning agents; GPT Pro was not invoked.
No paid model delivery test, privileged installation, or production implementation ran.

## Final audit before commit, 2026-09-24

Freshly fetched master/origin/master remains 48e1577. One final independent focused review
found no remaining material contradictions in endpoint allocation, native paths, descriptor roles,
deadlines, onboarding/recovery ordering or task dependencies. No further contract edits were needed.
MAC-01 remains an explicit unresolved native feasibility gate, not a completed implementation.

Fresh br readback matches all 25 canonical task packets and acceptance fields. The plan, SQLite,
JSONL and bv graph agree on 103 blocking and 25 parent edges; no cycles, every task reaches MAC-25,
and MAC-01/MAC-02 remain ready. All 23 upstream tracker records match master exactly.
Planning JSON parses, source references exist and git diff whitespace checks pass.
Only planning/tracker artifacts are included in the commit; the existing package-lock.json edit
is excluded. No product tests or native delivery ran for this documentation/tracker change.

## Second master audit, 2026-09-24

Fresh fetch still resolves master/origin/master to 48e1577. The user requested another audit.
This pass checked remaining native execution details and made the corrections recorded in
reviews/master-reaudit-2026-09-24.md: endpoint schema/evidence ownership, mount-view path mapping,
system-shell compatibility, distinct startup deadlines, descriptor roles and repository timeout ownership.
One independent focused review covered native helper/filesystem/disposal/packaging consumers.
No new task or dependency edge was needed. Shared-file integration ownership is now explicit.
The first alignment's validation artifact is preserved as
reviews/master-alignment-audit-2026-09-24.json; beads-audit.json records the latest readback.
Local Bash capability inspection ran; no product tests or native delivery were performed.

## Current baseline: master alignment, 2026-09-24

The numbered reviews below describe the original 9e66f49 plan. They are historical
and do not certify current master. The active baseline is fetched master/origin/master
48e1577; see reviews/master-alignment-2026-09-24.md and beads-audit.json.

- Independently reviewed runtime/accounts/recovery and browser/CI changes since the original baseline.
- Revised MAC-17 around the already-shipped browser/account workflow, with native integration and
  noncreating browse/cancel inspection still required.
- Added explicit ownership for pre-run native account-model discovery, current per-generation
  dispatch/account/continuation contracts, Effect boundaries, staged onboarding and current CI.
- Added one prerequisite: MAC-08 depends on MAC-06 for durable command/stdin support.
- A focused consistency review found two ordering ambiguities. Corrected MAC-02/08/15 so durable
  installation authority precedes active first-run discovery; added interrupted-probe cleanup evidence.
  Narrowed policy non-mutation assertions to failures before publication, retaining valid published
  defaults after later failure as current master does.
- Updated the existing epic and 25 children in place; preserved their IDs, statuses and metadata.
- Read back full descriptions and acceptance fields, and compared all 128 relationships across
  the plan, SQLite, exported JSONL and bv graph. No cycles; every task reaches MAC-25.
- Ready work remains MAC-01/MAC-02. All 23 unrelated tracker records are unchanged.
- Current local source-path references exist. Historical six-pass import evidence is preserved in
  reviews/beads-import-audit-2026-09-09.json; beads-audit.json records this audit's actual checks.
- This was planning/tracker work. No product code, new product tests or live model runs were performed.

## Grounding and initial validation

- Read current source at 9e66f49 and compared historical master startup/runtime code.
- Ran bounded native probes showing working Darwin Codex and failing Linux-specific epicd primitives.
- Read Apple primary-source constraints for launchd, kqueue, process identity, and endpoint entitlements.
- An independent native-mechanism research pass confirmed the process-domain feasibility gap.
- An independent portability task-authoring pass supplied MAC-10 through MAC-18.
- Initial plan contained 25 tasks, 101 blocking edges, 1,865 lines.
- Python DAG validation found no cycles; every task reached MAC-25.
- Source-path validation found 74 references; three unavailable current paths are explicitly historical master TUI files.
- MAC-01 and MAC-02 are the two initial ready tasks.

## Review round 1 — structural review completed

- Independent full-plan review identified hidden ordering requirements despite an acyclic declared graph.
- MAC-03 now fixes the portable filesystem helper in C17 without depending on uncompleted lifecycle research.
- MAC-02 defines complete host/boot/process wire schemas; MAC-21 supplies native observations and recovery integration.
- MAC-18 builds CI scaffolding and prerequisite suites; MAC-22 owns later adversarial/full-delivery CI integration.
- File/control protocols now distinguish controller-owned read sessions from supervisor-owned receipt sessions.
- Independent MAC-20-only self-containment review identified six missing implementation details.
- Added endpoint threat matrix, handoff contract, allocation/readiness rules, service ownership, teardown rules, and exact browser fixture commands.
- Clarified Apple Silicon as required; Intel support is optional until equivalently qualified.
- Post-revision graph remains 25 tasks, 101 blocking edges, acyclic, with every task reaching acceptance.
- Rationale sample reviewed by the independent reviewer: D2, D3, D5, D8, D11.
- Structural revisions mean this round has not reached steady state.


Additional round-1 revisions:
- Added per-artifact receipt bounds/link counts; new-format Codex stop records deliberately use exclusive two-link publication.
- Included recovery-side preventCodexLaunchStart in descriptor-relative conversion.
- MAC-11 owns persistent endpoint qualification; MAC-03 no longer promises an unspecified fallback.
- Historical receipt boot binding is separate from current live process identity.
- MAC-04 implements the qualified identity observation; MAC-21 consumes it without redesigning schemas.
- Added MAC-21 as an explicit prerequisite of MAC-15 resume/preflight integration.
- Restricted MAC-11 acceptance to file/control components and MAC-18 to preexisting component suites.
- Required mechanism-level reasoning in addition to finite native experiments.
- Revalidated graph after these changes: 102 blocking edges, no cycles, no orphan path, ready set unchanged.

## Review round 2 — bounded contract clarifications completed

- Independent review verified the round-1 structural fixes and passed MAC-11 in isolation.
- A second independent MAC-11-only check also passed component implementability.
- Five sampled rationales D1, D4, D5, D6, D9 passed after wording alignment.
- Changed early component acceptance to provisional target evidence; final matrix remains MAC-18/MAC-25.
- Fixed C17 and optional Intel wording consistently.
- Added an installation anchor independent from run records, qualified native host observation, and copied-token/reboot tests.
- MAC-21 now consumes MAC-04 identity observations rather than implementing a competing provider.
- This round needed no task split, architecture replacement, or graph change.
- The meaningful identity clarification still required another review before claiming steady state.

## Review round 3 — marginal revision completed

- Independent full-plan review verified round-2 fixes and found no new structural issue.
- Separate MAC-14-only review found one missing explicit source-basename race.
- Added before/after registered identity checks, barrier-based swap test, and conflict preservation without compensating mutation.
- Five rationale samples D3, D6, D7, D10, D12 passed.
- Round-2-to-round-3 revision was 21 added / 5 removed lines with unchanged task graph.
- Graph, inverse consumers, and packet consistency remained valid.
- Apparent steady state still required the fourth independent verification.

## Review round 4 — steady-state verification passed

- Independent fourth full-plan review found no remaining findings.
- MAC-14 source-entry race clarification passed without a graph or architecture change.
- Independent full-plan reviewer and separate MAC-15-only reviewer both passed preflight implementability.
- Rationale samples D2, D5, D8, D9, D11 passed.
- All 25 packets match the plan; 102 blocking edges remain acyclic, with every task reaching MAC-25.
- Final plan revision is marginal and the review reached steady state.
- Planning is ready for Beads conversion; native implementation feasibility remains unproven and gated by MAC-01.

## Beads conversion and six post-import polish passes

Created epic epicd-m7r and 25 open child tasks epicd-m7r.1 through epicd-m7r.25.
Used description-file import rather than bulk Markdown import, preserving every paragraph and separate acceptance fields.
Every task references actual prerequisite issue IDs as well as stable plan keys.
Retained 25 parent-child edges and 102 blocking edges in both SQLite and JSONL.

1. Issue fidelity/membership: PASS. One epic, all 25 children, full exact descriptions and acceptance fields.
2. Actual graph/readiness: PASS. 102 exact blockers, no cycles, all tasks reach MAC-25; ready tasks .1 and .2.
3. Native scope/proof semantics: PASS. Independent actual-issue review of MAC-01/04/05/11/19/20 found no material drift.
4. Standalone packets: PASS. All saved issues retain source context, rationale, implementation, adverse tests, acceptance and actual dependency references.
5. User workflow/release coverage: PASS. Independent actual-issue review of MAC-15/16/17/18/23/24/25 retained installation, TUI, both live transports and final gates.
6. Export/readback: PASS. Database and JSONL match for issue content, criteria, states and all 127 relationship edges; sync is clean.

These were six scoped post-import validation/polish passes, not six additional full architecture-model reviews.
Four full sequential plan reviews are recorded above and in reviews/round-1.md through round-4.md.
Implementation tests and live native delivery were not run because this task created the plan and tracker work only.
The native containment mechanism remains an implementation feasibility gate, not an already proved claim.
