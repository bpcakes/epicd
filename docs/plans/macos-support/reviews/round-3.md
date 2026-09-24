# Native macOS plan — independent review round 3

Reviewed current `plan.md` and all `tasks.json` packets against `/var/tmp/epicd-macos-plan-round3.md`, which matched the current plan exactly. Compared rounds 2–3 and inspected the existing workspace-disposal implementation for the standalone MAC-14 check. No plan/source/tracker edits, native experiments, installations, or model execution were performed.

## Result

Pass with one bounded MAC-14 clarification below. No new structural finding; S1–S3 are resolved. The round-2-to-round-3 diff is marginal: 21 insertions and 5 deletions, with no task changes or dependency changes. The plan has reached apparent steady state; the required fourth sequential review remains outstanding.

## Verification of prior findings

- **S1 resolved:** D4 selects C17, MAC-03/MAC-10 component completion explicitly uses provisional development-target evidence, and final advertised-target qualification belongs to MAC-18/MAC-25. Intel build and execution are conditional on an Intel support claim.
- **S2 resolved:** installation authority is anchored outside run data, includes a separately observed native host binding, refuses copied-token-only authority, and is created only during explicit new-run setup after preflight. Doctor/resume cannot repair it. Paired same-host-reboot and copied-host-token tests are present. The native host observation remains a qualification obligation; listing `gethostuuid` as a candidate does not claim it already satisfies the binding contract.
- **S3 resolved:** MAC-21 consumes MAC-04's qualified observations rather than implementing another provider or adding late schema fields.

## Standalone MAC-14 assessment

Pass with a bounded clarification. The packet provides concrete source anchors, names its prerequisite outputs, defines disposal as retention of the original directory object, forbids overwrite and copy/delete substitutions, and distinguishes rename outcome from independent worker stop. Its recovery rules cover missing acknowledgement, source-name reoccupation, directory synchronization failure, cross-volume failure, and unresolved physical identity.

The packet is consistent with the current `workspace-disposal-files.ts`: the existing implementation retains the entire directory, syncs source/archive parents, and inspects the result only after worker stop. A fresh agent can implement the native adapter and tests from this packet once its stated prerequisites supply qualified filesystem and supervisor contracts. Qualification of `renameatx_np`/`RENAME_EXCL` remains required; the plan does not present an untested primitive as already accepted.

**T1 — Medium, bounded clarification:** an independent MAC-14-only check relayed by the author identified a specific source-name race worth making explicit. Held parent descriptors prevent ancestor redirection but do not freeze the source basename between its identity check and rename. Require a registered-source identity check before rename and an archived identity check after independently proven worker stop. If the moved directory differs from the registered source, report conflict, preserve every occupant and never certify the expected workspace as retained. Add a barrier-based fixture that swaps only the source basename after the precheck. This sharpens the packet's existing exact-identity/conflict rules and does not require a new primitive or graph change.

## Rationale sample

| Decision | Result |
| --- | --- |
| D3 | Pass. False stop evidence has an explicit consequence, and positive mechanism reasoning plus adversarial tests remain mandatory. Negative experiments cannot close the gate. |
| D6 | Pass. Separates target exit, complete-domain stop, original result and validation eligibility, including remote database quiescence. |
| D7 | Pass. Explains why old records cannot acquire backend proof by default and preserves current-format recovery after the coordinated hard cut. |
| D10 | Pass. The interactive front door serves the requested workflow through current controller interfaces without reintroducing the removed engine. |
| D12 | Pass. Installed-artifact and symlink acceptance prevent source-tree-only native claims; diagnostics remain bounded and non-model-starting. |

## Consistency and scope checks

All 25 JSON task bodies match their plan packets. The graph is acyclic, every task reaches MAC-25, and consumer lists match inverse prerequisite edges. The revised host-anchor, current/historical boot, component qualification and helper custody rules do not introduce an implicit prerequisite cycle.

The unchanged tasks remain consistent with the revised boundaries: runtime admission joins the positive feasibility gate, service qualification remains mandatory for the promised release scenario, SDK and native Herdr have separate real delivery gates, and optional Intel support cannot be claimed from translated execution. Current-format recovery, Linux regression coverage and preservation of uncertain resources remain required.

This is the third review only. It establishes planning consistency, not native feasibility, implemented functionality, privileged-install authorization, or passing live acceptance. Integrate T1 before the fourth verification pass.
