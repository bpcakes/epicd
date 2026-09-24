# Native macOS plan — independent review round 1

Reviewed 2026-09-09. Inputs: the 1,865-line `docs/plans/macos-support/plan.md`, all 25 packets in `tasks.json`, and relevant private I/O, Codex launch, command lifetime, identity/schema source. This is round 1 only. No production files, plan files, tracker records, privileged installations, or model runs were changed or executed.

Snapshot note: findings refer to the original 1,865-line round-1 plan, retained by the author at `/var/tmp/epicd-macos-plan-round1.md`. After this review's initial feedback, the author reported revisions selecting C17, moving identity schemas into MAC-02, separating MAC-18/MAC-22 completion, separating controller/supervisor sessions, and expanding MAC-20. Those changes are pending independent round-2 verification; this report does not assess or certify them.

## Result

Not at steady state. The plan is candid about native feasibility and preserves the important product boundaries, but several task packets require outputs from later tasks. The declared JSON DAG passes; its apparent executability is stronger than the task prose actually supports. Correct these structural issues before Beads conversion. MAC-01's unresolved arbitrary-descendant proof is an intentional implementation gate, not a reason to weaken the acceptance contract or mark negative research complete.

## Structural findings

### R1 — High: early native helper work depends on an uncompleted feasibility decision

Evidence: MAC-03 depends only on MAC-02, but its first implementation step (plan line 499) uses the language chosen by MAC-01. MAC-01 chooses language, OS, architecture and filesystem requirements at line 386. MAC-10 and MAC-16 also describe qualification supplied by MAC-01 while being scheduled ahead of it. This conflicts with D4's deliberate independent filesystem/protocol work and means a ready agent must either invent a decision or wait on an undeclared dependency.

Recommended revision: preserve useful independent work by choosing the bounded filesystem/protocol helper language now (C with the macOS SDK is a reasonable proposed plan choice, if the author agrees), with MAC-01 allowed to require a reviewed lifecycle extension. Explicitly label early filesystem/package build tests as provisional capability evidence. MAC-01 should consume those measurements and choose the final release matrix; MAC-18/MAC-25 perform final matrix acceptance. Alternatively, add MAC-01 dependencies to affected tasks, knowingly sacrificing independent portability work. Do not keep both scheduling promises.

Proposed edits:

```diff
- Add ... using the language chosen by MAC-01.
+ Add the filesystem/transport helper in [chosen language]. MAC-01 may require a reviewed lifecycle extension; this issue does not implement or enable lifecycle admission.
+ Before MAC-01 selects the release matrix, qualify this component on the stated development target and retain provisional target metadata. Final advertised-matrix coverage belongs to MAC-18/MAC-25.
```

### R2 — High: native identity ownership creates an implicit dependency cycle

Evidence: MAC-11 says “MAC-21 defines host/boot/backend identities” (line 973) and requires those identities on every receipt read (984). MAC-21 implements the qualified identity provider (1598), but it depends on MAC-04/MAC-06/MAC-08; all those transitively depend on MAC-11. MAC-15 also requires resume identity validation while merely coordinating with MAC-21. This is not a problem fixable by adding a MAC-21 prerequisite to MAC-11: that would create an actual cycle.

Recommended revision: make MAC-02 the sole owner of exact host, boot and process identity schemas and comparison semantics. Put the low-level native identity provider in an early helper task, with MAC-01 supplying any primitive qualification needed. MAC-21 then integrates already-defined identities into recovery and contention. MAC-11 consumes the MAC-02 schema and an injected typed identity value/provider, not a future MAC-21 design. Explicitly distinguish historical launch boot binding from the current boot used for live process comparison: a retained exact receipt must not be invalidated just because it was written before reboot, and a changed boot must not manufacture a missing receipt.

Proposed edits:

```diff
- MAC-21 defines host/boot/backend identities added to retained run and operation records.
+ MAC-02 defines host/boot/process identity fields and historical-versus-live comparison rules. MAC-03 supplies the bounded identity primitive; MAC-21 integrates it into recovery without changing MAC-11's wire contract.
```

If the low-level provider cannot be implemented before MAC-01, distinguish schema/component tests using supplied immutable identity fixtures from runtime enablement and put the implementation obligation explicitly in the gated supervisor task. Do not let component tests claim real identity qualification.

### R3 — High: MAC-18 cannot finish before the MAC-22 work it blocks

Evidence: MAC-22 explicitly depends on MAC-18. MAC-18 says MAC-22 provides the adversarial parity suite (1408), then requires cases “supplied by MAC-22” in its implementation contract (1428), with required-test inventory/zero-skip acceptance. An implementation agent cannot close MAC-18 honestly without doing blocked MAC-22 work or deferring an unmentioned acceptance requirement.

Recommended revision: keep the existing edge and make MAC-18 own CI infrastructure and execution of the component suites delivered by MAC-01 through MAC-21. MAC-22 owns adding its new adversarial/deterministic full-delivery cases to that infrastructure and running them. MAC-25 verifies the final union is mandatory. Remove language making MAC-18 completion depend on unimplemented MAC-22 fixtures. Another valid choice is to reverse the edge and let MAC-22 run locally before CI integration, but describe that deliberately.

```diff
- Include ... cases supplied by MAC-22.
+ Run the adversarial component cases delivered by prerequisite tasks. Provide a required native-suite entrypoint for MAC-22; MAC-22 must add its final parity cases and verify CI execution before it closes.
```

### R4 — High: operation-owned receipt custody is not separated from controller session cleanup

Evidence: D5 closes all handles on connection loss (196); MAC-10 closes all handles when a session closes; MAC-11 explicitly closes helper sessions on controller cancellation (1000). At the same time MAC-04's guardian must survive controller loss long enough to stop the domain and publish evidence. MAC-03 does not select helper roles, process cardinality, or which connection owns the directory descriptors/endpoint needed after EOF. A single controller-owned helper session followed literally could close the exact handles needed for receipt retention after controller death.

This is an architecture gap, not proof the proposed helper approach is impossible. The present Linux command supervisor is explicitly detached and holds its own private I/O descriptor (`src/adapters/command-lifetime.ts`), making the missing native ownership split concrete.

Recommended revision: define distinct request-scoped filesystem sessions and operation-owned guardian custody. Before admitting exec, the guardian must independently acquire/validate its operation directory and private publication authority; it must not depend on the controller's continued filesystem session. Controller EOF closes admission and requests cancellation, but does not destroy guardian-owned receipt custody. Guardian crash stays unknown. Specify whether launch-control endpoints are guardian-owned or separately supervised and what survives each process death.

```diff
+ Controller cancellation closes controller-owned streams and handles. Guardian-owned directory custody and terminal-publication capability survive controller EOF until settlement or guardian failure. Never shut down that custody as generic client-session cleanup.
```

Add a component fault test: sever only the controller helper channel after admission, then verify a surviving operation owner retains exact terminal evidence using its own descriptors. This test must not assert descendant-stop proof until MAC-04's real mechanism exists.

## Task contract findings

### R5 — Medium: MAC-11 merges two existing receipt formats without stating the new file contract

Source evidence: `private-io-files.ts` publishes a retained staging hard link and accepts 16,384-byte files with `nlink === 2`. `codex-launch.ts:56` reads at most 2,048 bytes; its `readOwnerFile` rejects `nlink !== 1`; `writeCodexLaunchStop` renames its staging file. MAC-11 tells the implementer to preserve existing parser bounds while retaining no-replace final linking and expected retained link count, but does not distinguish the two current protocols or explicitly change the Codex reader/writer together.

Recommended revision: include a per-artifact table specifying start gate, temporary name, final name, maximum bytes, link count before/after publication, and reader validation. State whether new-format Codex receipts deliberately adopt the two-link retained protocol; if so, update only the stop-reader contract to expect two links, retain single-link requirements for manifests/configuration, and explicitly retain the 2,048-byte Codex bound unless MAC-02's new fields require a reviewed bound change. Add the recovery-side `preventCodexLaunchStart` path to the explicit descriptor-relative call-site list: it also currently writes absolute `started.json`, not just `codex-launch-cli.ts`.

MAC-11's acceptance also says dispatch, Codex and durable-worker tests use native implementation. Full production integration requires MAC-04/06/08, which MAC-11 blocks. Limit this issue's completion to native file/control component tests and compatibility tests that do not fabricate stop proof; allocate the full integrated suites to the downstream issues already responsible for them.

### R6 — Medium: MAC-03 does not deliver the fallback MAC-11 assumes is qualified

MAC-03 permits either an inherited private channel or an authenticated local endpoint. MAC-11 requires a persistent reconnectable AF_UNIX endpoint and says to use MAC-03's qualified endpoint if relative bind/connect fails. A valid MAC-03 implementation using only an inherited channel supplies no reconnectable fallback.

Recommended revision: make MAC-11 explicitly own qualification of persistent recovery endpoints. Specify a required result: a held-directory-relative server/client operation plus session/generation authentication that supports a replacement authorized controller. MAC-03 owns only framing and peer-auth primitives. If the candidate fails, keep MAC-11 blocked and revise the design; do not claim an unspecified alternative is already qualified. Record which identity/auth material survives controller restart and how a new controller is admitted after the current lease is checked. An endpoint's owner UID alone must remain insufficient, as the existing packet correctly says.

## Independent MAC-11 packet assessment

Verdict: not yet implementable to completion from its task packet alone, even with shared invariants appended. A fresh agent can start descriptor I/O work and understands the intended security properties, but must design around R2/R4/R5/R6 and decide whether downstream integration is required for this task to close. These are load-bearing decisions, not absent boilerplate. Do not solve this by copying the entire 1,865-line plan into the issue; add the specific ownership, artifact contract, prerequisite-output and completion-boundary details above.

The packet already does well at exclusive start claims, loser behavior, immutable evidence, conservative unknown outcomes, bounded transcript ingestion, and distinguishing diagnostic provider messages from proof. Retain those details.

## Architecture rationale sample

| Decision | Rationale assessment |
| --- | --- |
| D2 | Pass. Explains why transport and execution are separate axes and avoids mixed SDK/Herdr/platform enums. Concrete operational consequence is persisted independent binding. |
| D3 | Pass. Explains the consequence of false stop evidence and refuses cooperative-only, always-unknown and VM substitutes. Preserve the positive gate. Add written mechanism reasoning alongside adversarial experiments; finite tests alone do not establish arbitrary-descendant completeness. |
| D5 | Partial. Correctly explains descriptor custody and path-reopen races, but must distinguish controller session handles from operation-owned custody (R4). |
| D8 | Pass. Explains why broad home/toolchain allowances break the boundary and requires access-policy parity through tests. Does not claim Seatbelt is a stable replacement API. |
| D11 | Pass. Correctly separates local loopback from private network namespaces, gives service qualification its own obligation, and forbids parity claims before it passes. Optional development availability must not silently make the final service acceptance optional. |

## Grounding and unsupported-API assessment

The plan's caution about kqueue, launchd and private process APIs is supported by the inspected primary sources. Apple's current [XNU event header](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/event.h) marks NOTE_TRACK/NOTE_TRACKERR/NOTE_CHILD unsupported since 10.5 and says the NOTE_FORK child PID is not passed through the actual kevent. Apple's [launchd guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) discourages setsid; it does not establish a kernel prohibition. Apple's [libproc header](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h) labels its interfaces private and subject to change. I found no basis here for promoting any of those to arbitrary-descendant stop proof.

Relative Darwin AF_UNIX lookup, qualified no-replace rename/durability, endpoint restrictions and Mach-O dependency admission remain explicit qualification obligations. This review ran no native mechanism experiment and makes no positive runtime feasibility claim. Pin moving source URLs to commits/SDK versions in the implementation decision record as already requested by the plan; that is a small evidence improvement, not a structural blocker.

## Graph and artifact checks actually performed

- Parsed every task in `tasks.json`; 25 unique task keys.
- Traversed all prerequisites from MAC-25: no declared cycle and all 25 tasks reach the final sink.
- Checked every consumer against inverse dependency edges: no mismatch.
- Compared each JSON body to its complete plan task packet: no drift.
- Read the full task plan in chunks and inspected relevant native-port source anchors.
- Rechecked the three Apple primary sources above.

The graph should be checked again after revisions, including semantic task inputs, not only its JSON edges. Some final “Unblocks” paragraphs list transitive consumers while packet headings list direct consumers; label that convention to avoid false discrepancy reports during tracker conversion.

## Steady-state assessment

Round 1 requires structural revisions to prerequisite ownership, helper lifetime and CI completion boundaries. It is not steady state and must not be recorded as a successful final review. The base product scope remains coherent and candid: native execution is conditional on a positive MAC-01 mechanism, then real deterministic delivery, SDK delivery, Herdr delivery and installed-artifact qualification. No recommendation here weakens that outcome, authorizes privilege installation, or closes the gate on a negative experiment.
