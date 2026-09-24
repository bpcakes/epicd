# Native macOS plan — independent review round 2

Reviewed the revised plan against `/var/tmp/epicd-macos-plan-round2.md`, the round-1 snapshot/report, all task packets in current `tasks.json`, and relevant receipt/browser fixture source. The only current-plan change beyond the round-2 snapshot at verification time was the sentence distinguishing direct heading edges from transitive prose beneficiaries. No plan/source/tracker edits, installations, or model tests were performed by this reviewer.

## Result

The round-1 architecture and ordering blockers are resolved. No new dependency restructure is needed. Remaining revisions are bounded contract clarifications; this round is close to steady state, subject to verifying those changes in the next review. This does not qualify native execution or discharge MAC-01.

## Round-1 disposition

| Finding | Disposition |
| --- | --- |
| R1: early helper depends on MAC-01 language/matrix | Scheduling resolved by C17 and provisional component work. A few old acceptance phrases still need alignment (S1 below). |
| R2: identity schema/provider cycle | Resolved. MAC-02 owns schemas and historical/live boot comparisons; MAC-04 provides the gated primitive; MAC-21 integrates recovery. MAC-15 now explicitly depends on MAC-21. |
| R3: MAC-18/MAC-22 completion cycle | Resolved. MAC-18 supplies CI and prerequisite suites; MAC-22 extends and proves final parity coverage. |
| R4: controller disconnect destroys receipt custody | Resolved. D5, MAC-10 and MAC-11 explicitly retain supervisor-owned custody through cancellation/settlement. |
| R5: conflicting receipt formats and downstream acceptance | Resolved. Native Codex two-link publication deliberately retains its 2 KiB bound, generic receipts retain 16 KiB, other single-link files remain protected, both launch/recovery claims are included, and full integration belongs downstream. |
| R6: assumed reconnectable endpoint fallback | Resolved. MAC-03 uses inherited framing; MAC-11 owns reconnectable endpoint qualification and remains blocked if it fails. |

## Remaining actionable findings

### S1 — Low: finish aligning early completion wording with provisional qualification

The revised task inputs allow early work, but MAC-03 acceptance still says the helper builds on “the qualified native matrix,” MAC-10 acceptance still demands “every advertised Darwin architecture,” and D4 still proposes “C or Objective-C.” MAC-16's unconditional instruction to build both arm64 and x64 also reads more strongly than the newly optional Intel release scope.

Use explicit, consistent language: MAC-03/MAC-10/MAC-16 close from component tests and artifacts on the observed/proposed build target with provisional metadata; MAC-18/MAC-25 qualify every target actually advertised. D4 should name C17 for filesystem/transport work, with a reviewed extension only if lifecycle qualification requires one. Make x64 artifact execution/qualification conditional on an Intel support claim, while retaining target-table/package-fixture tests on any host. This is wording follow-through, not a reason to reintroduce MAC-01 prerequisite edges.

### S2 — Medium: make the installation identity independent of the state being adopted

MAC-02 now says host identity is a stable installation binding plus native boot identity. That correctly distinguishes historical receipt comparison from live process identity, but does not say where the installation authority is anchored. An implementation that stores the installation ID only beside the state database could copy the ID with the database and treat another Mac's new boot like an ordinary reboot. Repeating “refuse another Mac” in MAC-21 does not specify the missing comparison input.

Add a bounded requirement to MAC-02: define the authoritative installation/host anchor's storage and comparison independently from imported run data; do not trust a binding solely because the copied record carries it. MAC-04 qualifies whatever native host observation is needed. An unavailable or mismatching anchor refuses adoption without recreating/rebinding it during read-only discovery. Keep receipt historical boot checks separate from current-host admission.

Add paired acceptance fixtures: same installation with a different boot can consume an intact historical receipt; another installation presenting copied run records and their copied installation token must fail even if its canonical paths and supplied filesystem identities look equal. This is a contract clarification and adversarial test, not a demand for a particular private API or hardware identifier.

### S3 — Low: MAC-21 should consume the primitive assigned to MAC-04

MAC-04 now explicitly implements native identity observation, while MAC-21 step 1 still says “Implement native observations.” Change MAC-21 to “Consume MAC-04's qualified native observations and integrate them into ownership/recovery.” The wire schema cycle is resolved already; this edit prevents duplicate providers and inconsistent absence/error handling.

## Standalone MAC-11 assessment

Pass for its explicitly scoped native file/control component work after its prerequisites provide their described contracts. It no longer requires future identity schemas, a completed process supervisor, or unspecified endpoint fallback to close. The artifact-specific limits, independent custody, recovery-side claim, failure behavior and integration handoff are sufficient for an implementation agent to proceed from `br show` with the shared invariants.

Endpoint qualification remains real work within this task, not an established Darwin API guarantee. If its native parent-swap/long-path/reconnection experiment fails, the task remains blocked as written. Component receipt fixtures must continue to be identified as fixtures, never process-stop evidence.

## Rationale sample

| Decision | Assessment |
| --- | --- |
| D1 | Pass: ties platform-independent authority to consistent delivery semantics. |
| D4 | Pass rationale: missing Node primitives, reduced ABI coupling and native-crash isolation justify a subprocess. Align its language choice per S1. |
| D5 | Pass: descriptor custody rationale now covers supervisor survival after controller loss. |
| D6 | Pass: clearly distinguishes target result, domain stop and evidence eligibility, including remote database activity. |
| D9 | Pass: explains why executable/resource/profile identity must be frozen and why mismatches require refusal. S2 makes the host comparison input more explicit. |

## Checks and steady state

All 25 task bodies exactly matched the corresponding current plan packets. The declared graph is acyclic; all tasks reach MAC-25; consumers match inverse prerequisite edges. The new MAC-15 prerequisite introduces no cycle. Browser fixture inspection confirmed that `/bin/sh tools/browser-check.sh` is the generated repository command, the environment variable names are current, and its Playwright configuration has the stated 10-second web-server readiness limit.

This round proposes no architecture replacement, task split, dependency reversal, or weakened release gate. S1/S3 are editorial alignment; S2 is a small but meaningful identity contract addition. Integrate and verify them before recording steady state. Only rounds 1 and 2 have been reviewed by this reviewer so far.
