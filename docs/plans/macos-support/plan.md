# Native macOS support for epicd

Status: reviewed plan, saved as Beads epic epicd-m7r with 25 open child tasks.
No implementation or native execution acceptance is claimed.
Baseline: master and origin/master at 48e1577, fetched and audited 2026-09-24.
Original native probes and feasibility source research: 9e66f49, 2026-09-09; not rerun by this audit.
Alignment evidence: reviews/master-alignment-2026-09-24.md and reviews/master-reaudit-2026-09-24.md.
The second fresh fetch still resolves to 48e1577; the re-audit corrects remaining execution gaps.
Earlier review reports are historical.
Requested outcome: native macOS execution, explicitly confirmed by the user.
Tracker outcome: one epic with self-contained child tasks and blocking dependencies.
Plan keys MAC-01 through MAC-25 map to epicd-m7r.1 through epicd-m7r.25 in beads-map.json.

## 1. User outcome and boundaries

A Mac user installs epicd, runs epicd in a Beads repository, selects an open epic,
reviews the resolved settings, and starts the current persistent orchestrator.
The startup experience must expose useful diagnostics before creating durable run state.
The user must not need a Linux VM, container guest, remote Linux service, or Rosetta.
Agents, repository commands, Git operations, and validation execute on macOS.
Both the SDK transport and native Herdr transport remain supported targets.
Native Herdr means real Codex terminal sessions in owned Herdr panes.
A decorative terminal around an SDK worker does not satisfy Herdr acceptance.
The existing root-command epic browser and account picker must work through the native backend.
Headless and explicit run/resume/control commands remain independently usable.

This is a port of the current controller and deterministic kernel.
Do not restore the removed EpicEngine, phase dispatcher, session formats, or bypass mode.
Do not change the coordinator model or invent a fallback model.
Do not weaken independent review, exact-revision checks, publication, or tracker closure.
Do not migrate previous-format state as part of this work.
Retain unsupported records and external resources without interpreting them as current.
Current-format recovery on the same installation remains a release requirement.
Cross-host or Linux-to-macOS resumption is not part of this epic.

The primary release target is native Apple Silicon.
Native Intel macOS is an optional qualified target, not a prerequisite for the Apple Silicon release.
No Intel support claim is made until the same advertised-feature tests pass on Intel.
The implementation qualification matrix starts at macOS 14 and includes the current stable OS.
This is a proposed support floor to validate, not a claim that current primitives work on it.
If a necessary primitive requires a newer OS, MAC-01 must establish the minimum from evidence.
Documentation, package metadata, CI, and preflight must use the same qualified minimum.
An untested Intel artifact cannot be advertised as supported.
The original probe host was macOS 26.6.2, arm64; this is evidence provenance, not a support claim.
Node's existing package engine floor is >=22.12.0 and remains until evidence requires a change.

The ordinary installation target is an unprivileged npm installation with a packaged native helper.
No task may silently require sudo, disable SIP, require Full Disk Access, or install a service.
A privileged broker or Apple entitlement is a separately documented design proposal if necessary.
The native requirement alone does not authorize installing such a component.
The planning task itself performs no privileged installation and no model run.

## 2. Grounded starting state

src/bootstrap.ts: createRun rejects any platform other than linux/x64 before repository discovery.
src/adapters/runtime-discovery.ts owns sdkNativeExecutableEffect and selectedCodexExecutableEffect.
Both hardcode @openai/codex-linux-x64 and its musl vendor path; bootstrap retains public wrappers.
The locally installed SDK already maps both Darwin architectures.
The original Darwin arm64 probe reported codex-cli 0.153.4 without an authentication request.
Therefore native Codex availability and epicd's binary-selection restriction are separate facts.

src/adapters/pid-namespace.ts launches /usr/bin/unshare for every supervised process.
Its guardian checks process.pid === 1 and receives a private cancellation descriptor.
The guardian's exit triggers Linux namespace destruction.
Normal unshare completion plus the retained private result establishes descendant stop.
Killing the unshare monitor itself does not establish that proof.
The macOS probe failed with spawn /usr/bin/unshare ENOENT.

src/adapters/codex-launch.ts builds an outer Bubblewrap process environment.
src/adapters/sandbox.ts builds command isolation and validation environments.
src/adapters/kernel-beads.ts confines even tracker graph reads.
src/adapters/fixtures.ts and fixture-creation.ts construct additional Bubblewrap environments.
src/adapters/account-model-discovery.ts also uses namespace/Bubblewrap supervision before run creation.
Its bounded app-server model discovery is invoked through codex-settings.ts when a model is unspecified.
All these call sites must use a native backend rather than merely removing platform guards.
The SDK and Herdr controlled adapters both use ControlledLaunches.
Runtime switching therefore does not currently avoid the Linux dependency.

src/adapters/private-io-files.ts uses /proc/self/fd for one-use dispatch and stop receipts.
src/adapters/inspection-files.ts traverses paths relative to held directory descriptors.
workspace-disposal-files.ts and codex-transcript.ts also depend on /proc/self/fd.
codex-launch.ts and codex-launch-cli.ts use descriptor-derived Unix socket paths.
The macOS probe failed opening /proc/self/fd/<fd>/started.json.
Replacing the prefix with /dev/fd is not an established equivalent.

src/adapters/workspace-disposal-files.ts invokes /usr/bin/mv with GNU flags.
The move must remain atomic, exclusive, and without a copy/delete fallback.
src/adapters/fixtures.ts accepts only executable bytes beginning with the ELF magic.
src/domain/repository-policy.ts limits check-local PostgreSQL binDirectory to /usr paths.
Apple Silicon Homebrew commonly needs a separately admitted toolchain root.
Existing environment construction often reduces PATH to /usr/bin:/bin.
Admitting an executable alone does not admit its interpreter, libraries, or package resources.

src/adapters/store.ts obtains Linux boot and process-start markers from /proc.
Its non-Linux fallback conservatively treats a live PID as occupied.
That fallback is not equivalent to a durable macOS process identity.
The ownership and recovery design must not use PID absence as operation-stop proof.

Master already provides default interactive browse, paged/searchable epic selection, an account editor,
shared Start/Resume/Control routing, and the installed-symlink entrypoint fix.
Browsing still eagerly opens StateStore; MAC-17 retains explicit work to avoid creating state on browse/cancel.
Confirmed Start intentionally initializes missing default policy only after successful staged admission.
An explicit account-editor Save may persist machine defaults; resumed accounts remain frozen.

RuntimeConfiguration includes the frozen account snapshot; each agent generation owns its AgentExecution,
backend/runtime and account binding. ControlledAgentDispatcher routes live work and recovery accordingly.
The inspected versions are orchestration schema 48, run-state schema 4, and agent-instance schema 3.
These are baseline values, not fixed future version numbers; MAC-02 coordinates one next-format change.
Discovery, account, bootstrap and Ink lifecycle boundaries now use pinned Effect v4 (4.0.0-rc.112).
Follow AGENTS.md and docs/plans/effect-v4-adoption.md; preserve typed failures and explicit abort/drain
ownership. Fiber interruption alone is not process drain or stop proof. Do not expand into wholesale adoption.

CI runs fast validation followed by four Ubuntu integration shards with three workers per shard.
Vitest defaults to parallel files, six workers and a 30-second test deadline.
The macOS and Windows jobs still run only process and store contract tests.
Many delivery, inspection, bootstrap, and runtime suites skip non-Linux hosts.
A green existing macOS job does not demonstrate native delivery.

## 3. Source register and interpretation

S1: https://github.com/containers/bubblewrap
Bubblewrap constructs isolation using Linux user, mount, PID, and network namespaces.
Installing a similarly named executable does not give Darwin those kernel primitives.

S2: https://man7.org/linux/man-pages/man1/unshare.1.html
The existing monitor's semantics depend on Linux namespace lifetime and teardown.
This is the behavior to preserve at the domain boundary, not an API to emulate by name.

S3: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
Apple's launchd job guidance discusses job process groups and discourages setsid.
The local launchd.plist manual says remaining members of the same process group are killed.
This does not certify all descendants after group/session escape.

S4: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event.h
NOTE_TRACK, NOTE_TRACKERR, and NOTE_CHILD are marked unsupported since macOS 10.5.
NOTE_FORK events must not be described as automatic recursive descendant tracking.
Record the exact SDK header and OS build used for any process-event experiment.

S5: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_prot.c
The inspected setsid/setpgid implementation does not establish a Seatbelt denial hook.
A plan must not assume that a sandbox rule can prevent those calls without a real probe.

S6: https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h
The header marks libproc APIs private and subject to change.
Process identity and signalling helpers require capability checks on every supported OS.
An audit token may prevent PID reuse mistakes without proving full descendant membership.

S7: https://developer.apple.com/documentation/endpointsecurity/client
S8: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client
Endpoint Security requires entitlement and installation permissions unavailable to an ordinary npm helper.
Do not use it as an assumed fallback dependency in the base native design.

S9: https://developer.apple.com/documentation/security/app-sandbox
Local man sandbox-exec marks the command deprecated.
Seatbelt is a candidate backend whose actual allowed operations must be qualified.
App Sandbox documentation does not imply arbitrary command-line Seatbelt profiles are a stable public API.
File/network denial is not the same promise as hidden Linux mount/PID namespaces.

S10: local SDK headers and man pages for openat, fstatat, readlinkat, linkat, renameatx_np.
The proposed native filesystem helper uses descriptor-relative POSIX operations.
RENAME_EXCL support must be checked on the target filesystem.
Do not assume new flags such as O_RESOLVE_BENEATH exist on the minimum OS.
Record source version and native probe output in the implementation evidence.

S11: node_modules/@openai/codex-sdk/dist/index.js and installed @openai/codex/bin/codex.js.
Both Darwin target triples are present in the pinned dependency.
Read the installed selected version at implementation time instead of copying a guessed package layout.

Source URLs establish constraints; local adversarial tests establish the shipped backend.
Do not infer authentication or model availability from a successful executable version probe.
Do not invent throughput, latency, installation-size, or dollar-cost estimates.
Measure native launch and I/O overhead as part of qualification and report the environment.

## 4. Architecture decisions

### D1. Keep the kernel platform-independent

Authority, operation identity, evidence eligibility, and action admission remain in TypeScript.
Platform adapters implement physical execution, constrained file access, and stop observation.
The domain must not import Darwin native structs, Linux namespace details, or executable search logic.
Why: delivery behavior must be the same across native platforms and across SDK/Herdr transports.

### D2. Separate provider transport from host execution

RuntimeKind continues to mean sdk or herdr.
Extend the existing durable agent execution/dispatch model with a persisted host binding identifying
linux or darwin and its version. Agent BackendKind remains the provider identity (currently codex);
do not overload it with host platforms or introduce a competing dispatcher.
Each generation retains its frozen AgentExecution, runtime, account binding and continuation ownership.
The same coordinator and action code use either host backend.
Why: sdk is not a sandbox and herdr is not a process-lifetime mechanism.
This avoids an expanding matrix of mixed transport/platform enum values.

### D3. Treat native process containment as an unresolved gate

MAC-01 must produce a working experiment and a precise process-domain contract.
A launchd job, process group, ps scan, or kqueue fork notification alone is insufficient.
The proof must cover detached descendants retaining write access and repeated spawning.
Why: false stop proof would permit publication or workspace reuse while old writers remain alive.
If no native mechanism meets the contract, MAC-01 records the blocker and dependent work stays blocked.
An experiment that only works for cooperative children cannot close the feasibility task.
The epic must not be completed by a backend that always returns unknown.
A product-contract change must be explicit; it is not an implementation shortcut.
VM execution is excluded even as an automatic fallback.

### D4. Use a small native helper for missing Darwin primitives

The filesystem and transport helper is C17 built with the macOS SDK.
A lifecycle-specific extension requires MAC-01 evidence and a recorded revision before MAC-04 starts.
Use a subprocess protocol rather than an in-process Node addon for the first implementation.
Keep command-specific operations bounded and avoid exposing arbitrary syscalls or a shell RPC.
Why: descriptor-relative filesystem calls and process identity need APIs Node does not expose directly.
A subprocess keeps Node ABI churn out of the package and isolates native crashes.
The helper does not own scheduling, model choice, Git policy, or Beads decisions.
The filesystem helper and abstract contracts may proceed independently; MAC-01 must resolve lifecycle implementation before MAC-04 and MAC-05 begin.

### D5. Keep stable handles inside their owning process

A directory descriptor integer has meaning only in the helper process that opened it.
Return opaque handle IDs over an authenticated private channel, never bare cross-process fd numbers.
Retained operations carry filesystem identity and generation bindings.
Why: reopening a mutable path after checking it recreates the race the current Linux code avoids.
Controller-owned read handles close on their connection loss.
Operation-owned receipt and process handles belong to the surviving supervisor and remain until its settlement or failure.
Controller EOF requests cancellation without destroying that independent custody.
Native helper restart never silently revives old opaque handles.

### D6. Keep stop evidence independent from command success

An exit code describes the target process result.
A stop receipt describes the complete admitted process domain's termination or never-started state.
A passing check additionally requires the original output, source identity, and policy evidence.
Why: a command can pass while background writers remain; it can stop without a usable result.
No result parser can manufacture stop proof from a success-shaped provider message.
Remote PostgreSQL stop remains separate from local client termination.

### D7. Preserve the current hard cut

Extend current provider/agent execution bindings with explicit host bindings in one next storage format.
Do not add nullable defaults that reinterpret old launch records as native-safe.
Unsupported databases are preserved without automatic migration, deletion, or resource release.
Why: platform-specific proof cannot be inferred from historical Linux-only records.
Current-format recovery must remain complete after this schema change.
A schema bump is coordinated once through MAC-02 rather than independently by every task.

### D8. Build native filesystem and network policies from the existing contract

Workers get their registered workspace plus specific toolchain/runtime resources.
Protected Git, tracker, policy, provider, and instruction metadata retain their current access mode.
Review source stays read-only with explicitly bounded writable scratch.
Validation has no undeclared host network or service access.
Why: allowing the whole home directory to make Homebrew or Codex work defeats the boundary.
A native denial policy may differ internally from Linux mounts, but must satisfy the same access tests.

### D9. Freeze toolchain paths and host identity

Resolve the selected native binaries, interpreter/resource roots, helper build, and backend profile.
Bind them before model execution and reject silent substitution on resume.
Qualify APFS volume semantics and canonical aliases at admission.
Why: host upgrades, symlinks, and toolchain updates can change what a stored executable path means.
The operator receives an actionable mismatch diagnostic instead of an implicit reinstall or switch.

### D10. Integrate the existing interactive front door

The root command on a real terminal displays current-format runs and open Beads epics.
Selection flows through the existing createRun/resume/operator interfaces.
Noninteractive no-argument/browse invocation prints help to stderr and exits 1 without opening state.
Why: native support must include the workflow the user actually invokes.
Navigation, account selection and shared command routing already exist on master.
Port their confined dependencies and qualify the installed native workflow; do not rebuild a legacy wizard.
Keep browsing/doctor non-mutating, preserve explicit account-default Save, and retain delayed atomic
default-policy creation on confirmed Start after successful admission. Malformed policy is never overwritten.

### D11. Native service isolation requires separate qualification

macOS loopback is not a private network namespace.
Check-local PostgreSQL/browser services need narrowly scoped broker and endpoint admission.
Ordinary workers must not gain host-listener access just because validation needs one endpoint.
Why: copying the Linux share-net switch into an SBPL policy would overstate isolation.
MAC-20 can report a specific service capability unavailable while the basic native runtime is developed.
Final release acceptance cannot claim parity until the promised service scenario is proven.

### D12. Make packaging and diagnostics part of acceptance

The installed npm artifact must include a matching native helper and execute through an npm symlink.
Doctor reports the actual executable, backend, filesystem, confinement, and lifetime capabilities.
Why: a source-tree demo with an untracked locally built helper is not installable native support.
No postinstall command may silently download an unpinned binary or install privileged components.
No help/version path starts a model, creates state, or probes user databases.

## 5. Operation contract to preserve

Run-owned operations bind run ID, operation ID, controller lease, scope digest and launch digest.
Pre-run account-model discovery instead retains its exact synthetic operation identity, host binding and
cleanup intent; it cannot assume a run row or controller lease. Both kinds require original stop evidence.
Its private directory is canonical, owner-only, and pinned by device/inode identity.
A one-use start gate prevents both replay and delayed launch after recovery fencing.
Cancellation is effective before helper readiness, during execution, and after controller loss.
The deadline runs outside the controller JavaScript event loop.
Only the original surviving supervisor can retain the corresponding stopped receipt.
Recovery may atomically prevent a never-started operation.
Recovery may read an existing exact receipt without repeating the original command.
Recovery cannot transform missing evidence into stopped.
Supervisor crash is uncertainty until independently provable native evidence exists.
Unknown operations retain resource exclusions, ownership, and historical records.
Unrelated processes and user-owned Herdr panes must never be killed by guessed identities.
Filesystem publication is exclusive and crash-observable.
A changed root, symlink, hard link, or replaced receipt remains an error or uncertainty.
The native backend never emits a Linux-specific proof identifier.
The domain checks backend/profile/version/host binding before consuming a receipt.
Normal SDK/Herdr handoff preserves the host backend and its resource identity.
Cross-host relocation is refused, including copies with matching run IDs.

The production native backend cannot be enabled by a single process.platform check.
Its advertised capability requires the feasibility result, installed helper, and successful probes.
Preflight failures occur before durable run creation and repository ownership acquisition.
Active account model-list discovery may create private disposable resources before a run; they remain
owned by its independent intent/receipt and must be retained if stop is unknown. Passive doctor does not run it.
Offline helper probes run only in disposable task-owned directories.
They cannot execute repository hooks, change the tracker, request auth, or start a model.
Failure output distinguishes unsupported platform, missing dependency, denied access, and invalid state.
No output path prints tokens or private launch-control contents.

## 6. Verification tiers

Tier A: pure contracts, schema validation, action guards, formatting, and typechecking.
Tier B: real native helper and descriptor I/O tests with disposable filesystem fixtures.
Tier C: native process cancellation, crash, timeout, and confinement adversaries.
Tier D: credential-free whole delivery through the real kernel with deterministic model transport.
Tier E: authenticated native SDK whole-epic acceptance.
Tier F: authenticated native Herdr whole-epic acceptance in actual owned terminal sessions.
Tier G: clean installed-artifact runs on every advertised OS/architecture.

Mocks may isolate model decisions but must not replace the native helper in Tiers B through G.
Each test reports whether it passed, failed, was skipped, or could not run.
A skipped native suite cannot satisfy a release gate.
Live tests have explicit bounded budgets and task-owned repositories/resources.
They must preserve failed-run evidence and never close production issues.
Fault injection occurs at acknowledged barriers, not arbitrary startup sleeps.
Readiness markers are atomically published.
Record tested commit, helper digest, OS build, Node version, runtime executable, and filesystem.
A source change after a live run invalidates only evidence whose relevant code/bindings changed.
Do not repeatedly run unrelated tests without a change or unresolved concern.

## 7. Dependency and delivery model

All MAC tasks are direct children of one macOS epic.
Parent-child edges express grouping, not implementation prerequisites.
Each packet lists direct prerequisites. Derive reverse edges from tasks.json or Beads; prose may name transitive beneficiaries.
Blocking edges point from the dependent issue to its prerequisite.
Independent portability work can start while the feasibility investigation runs.
Readiness is not permission for concurrent writes to shared contracts. MAC-02 owns coordinated schema
and journal binding changes; MAC-03 owns the helper envelope. Consumers agree those interfaces first.
Assign one integration owner when tasks touch domain/delivery.ts, repository-policy.ts, shared launch/
filesystem adapters or helper/build files; do not add false blocker edges merely to serialize file edits.
All runtime-dependent paths join the feasibility contract before enabling native execution.
Every task has an explicit consumer; MAC-25 is the final acceptance sink.
Every task must reach MAC-25 through the dependency graph.
No task is closed merely because its code compiled.
A gate that failed remains open/blocked with its evidence; it is not completed research disguised as feasibility.
Task packets below carry the concrete checks required to close them.

The Beads description of each child includes its packet and the essential shared invariants.
An agent must be able to implement from br show without reconstructing this conversation.
The epic description carries the native-only outcome, support matrix, sources, and global acceptance.
The checked-in plan is the fuller rationale and review record.
If implementation changes a dependency, update both Beads and the plan together.
Use br ready --epic epicd-m7r --json to obtain ready implementation work.
Do not add the epic as a blocking dependency of its own children.

## 8. Planning evidence and unresolved decisions

Historical local probes from 2026-09-09 (not rerun during master alignment):
- Native Darwin arm64 Codex version succeeds.
- Current createRun and SDK resolver reject Darwin.
- /usr/bin/unshare and /usr/bin/bwrap are absent.
- /proc/self/fd is absent.
- Current private dispatch creation fails with ENOENT.
- Descriptor-confined inspection rejects Darwin.

Still unproven:
- Native arbitrary-descendant process-domain stop under the ordinary installation model.
- Equivalent worker isolation with the chosen macOS profile and supported OS range.
- Native private validation service isolation and restricted host-fixture access.
- Intel release qualification and the final supported minimum macOS version.
- Clean packaged installation, live SDK delivery, and live native Herdr delivery.

No item in this list is presented as implemented.
MAC-01 determines the native containment feasibility before the runtime is enabled.
The later tasks have exact implementation and qualification obligations if that gate succeeds.
If that gate cannot succeed, the epic remains visibly blocked instead of delivering a false port.

## 9. Implementation tasks

## MAC-01 — Prove native containment and descendant-stop feasibility

Depends on: none.

### Scope and rationale

The existing journal trusts complete process-domain stop, so a native backend must establish that claim before any production adapter is enabled. A positive process-group demo would conceal escaped writers and is not sufficient.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/pid-namespace.ts
- src/adapters/codex-launch.ts
- src/domain/codex-launch.ts
- src/adapters/sandbox.ts

### Implementation contract

Bound this investigation to the candidate mechanisms in the source register plus any concrete
alternative justified by a cited admission/containment primitive. For each candidate record the mechanism,
minimum-OS/API evidence, listed adversarial cases, and the first counterexample or positive result.
Stop a candidate when its required guarantee fails; deliver a decision table, reproducible probe and
mechanism argument. If all candidates fail, record the specific missing primitive and leave the positive
gate blocked for an explicit design decision; do not spin through unbounded speculative experiments.

1. Write a standalone native experiment and evidence report in a disposable test-owned directory; do not alter production admission.
2. State the adversary: arbitrary repository subprocesses may fork, double-fork, setsid, setpgid, retain descriptors, race exit, and attempt host IPC delegation.
3. State the required result: a closed admission domain with no surviving process able to execute or mutate its resources after a stopped receipt.
4. Evaluate unprivileged macOS mechanisms first, with a native guardian independent of the Node controller.
5. Document launchd same-PGID cleanup and unsupported kqueue NOTE_TRACK as rejected standalone proofs.
6. Do not assume Seatbelt can deny setsid/setpgid; prove any required rule against native syscalls and source evidence.
7. Separate process identity from process membership: an audit token avoids signalling a reused PID but does not discover hidden descendants.
8. Define how spawn admission closes before membership is declared empty, and prove there is no fork/enumeration gap.
9. If a dedicated UID or privileged broker is required, produce an installation/ownership/credential/entitlement design proposal instead of installing it or assuming consent.
10. Pin the viable primitive, helper language, minimum OS, architecture, threat model, and supported filesystem requirements in a reviewed decision record.
11. If no mechanism meets the native contract, retain concrete negative results, mark the gate blocked, and do not enable or close dependent runtime tasks.
12. A changed product contract must be an explicit plan revision; a VM or permanently-unknown backend does not fulfill the requested outcome.

### Verification and adverse cases

- A detached grandchild keeps a writable workspace descriptor and stdout after its immediate parent exits.
- A tree repeatedly forks or posix_spawns during cancellation, including short-lived intermediate parents.
- The controller receives SIGKILL before setup, after start admission, and while the command runs.
- The guardian receives SIGKILL separately; absence of its receipt must remain uncertainty.
- A paused Node event loop cannot prevent the native deadline from expiring.
- A recovered controller races a delayed old launcher at the one-use start gate.
- An unrelated same-user process, reused PID fixture, and user-owned Herdr pane remain untouched.
- Attempt signal, task-port, launchd/XPC, and filesystem access to escape the admitted execution domain.

### Acceptance criteria

- A reproducible native experiment demonstrates all required lifecycle and confinement properties on at least the primary target.
- The report includes mechanism-level reasoning for completeness and admission closure as well as tests; finite success samples alone do not prove arbitrary-descendant containment.
The report distinguishes proved guarantees, failed approaches, OS/API limits, and untested architectures.
- Only a positive proof closes this issue; a negative experiment leaves it blocked with a precise reason.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-02 — Define and persist host execution contracts

Depends on: none.

### Scope and rationale

Separating host execution from provider transport keeps SDK and Herdr on one controller and prevents platform details from leaking into delivery decisions or historical proof.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/agent-journal.ts

- src/domain/agent-execution.ts
- src/domain/agents.ts
- src/domain/accounts.ts
- src/adapters/agent-dispatch.ts
- src/adapters/orchestration-journal.ts

- src/domain/types.ts
- src/domain/command-lifetime.ts
- src/domain/codex-launch.ts
- src/domain/delivery.ts
- src/adapters/runtime.ts
- src/adapters/store.ts

### Implementation contract

Include native service endpoint allocation in the coordinated contract: current ValidationEnvironment
records definitionDigest and binary runtime but no resolved endpoint lease; policy service.port and
fixture-validation listenPort are fixed values in src/domain/repository-policy.ts.
Keep requested policy endpoints separate from immutable per-check resolved endpoints. Specify how the
native backend admits dynamic allocation without silently mutating frozen policy: an explicit versioned
allocation mode must be authorized before dispatch if exact requested ports cannot be preserved.
Bind resolved endpoint, allocation generation, server identity/readiness and artifact paths to the
validation/fixture evidence and recovery intent; backend profiles, client URLs and verifiers consume
that same binding. MAC-19/20 implement allocation and checks, not an independent schema bump.

Start from orchestration schema 48, run-state schema 4 and agent-instance schema 3 at 48e1577;
recheck the current numbers before allocating the coordinated next format.
Extend existing AgentExecution/AgentInstance and ControlledAgentDispatcher contracts; keep provider
BackendKind separate from host OS. Preserve frozen per-class account sources, accountBinding, effective
model settings, thread/continuation ownership, and existing turn-owner journal constraints.
Native host fields must accompany exact agent/turn generations as well as run/worker records.
Do not replace generation-owned execution with today's run runtimeConfiguration or mutable preferences.

Contract work may proceed independently of MAC-01 using proof obligations, not an assumed Darwin mechanism.

1. Introduce one platform adapter contract covering backend identity, capability probe, launch admission, stop observation, confined command construction, and file operations.
2. Keep RuntimeKind sdk/herdr unchanged; persist a distinct host execution binding.
3. Bind OS, architecture, host identity, backend/protocol version, helper identity, and qualified confinement profile to each new run.
Define host identity as a versioned stable installation binding plus native boot identity; process identity contains native generation/start identity and PID, never PID alone.
Anchor installation identity independently of run data at the canonical user application-support directory, Library/Application Support/epicd/installation.json, owner-only and outside all worker profiles.
Bind a random installation generation to a qualified native host observation; the initial candidate is gethostuuid, present since macOS 10.5 in the local SDK.
MAC-04 must qualify that observation on advertised hosts; a copied installation token without matching current native host observation is insufficient.
Store a domain-separated digest instead of exposing the raw native host identifier in status or model context.
Create the installation anchor only during explicit new-run setup after passive capability/repository/account
admission succeeds, but before active account-model discovery can create a host-bound intent/receipt.
Use exclusive creation and durable publication. A failed probe may leave this valid installation anchor
and its owned cleanup evidence even when no run is registered; do not delete/rebind them as rollback.
Doctor and resume never recreate, replace, or rebind a missing or mismatching anchor.
A missing anchor for existing state yields a bounded refusal; changing the state directory cannot establish new installation authority.
Historical receipts compare to the original launch host/boot binding, so a later reboot does not invalidate a valid retained exact receipt.
Live ownership checks compare current boot/process identity; reboot never manufactures a missing operation-stop receipt.
Specify all wire fields, nullability, maximum sizes, and canonical digest encoding in this task; adapters cannot defer them to MAC-21.
4. Carry the applicable execution binding into operation intents and receipts so evidence from another backend cannot be accepted.
5. Replace the literal bwrap-read-only-source-v1 domain assumption with a discriminated qualified profile identity.
6. Preserve distinctions between not_started, stopped, failed command, interrupted command, and unknown stop.
7. Keep processTreeStopped true as a proof obligation, not an optional field defaulted for Darwin.
8. Define typed capability errors with actionable native dependency diagnostics and bounded redacted details.
9. Use one coordinated next storage-format hard cut; do not independently bump the version in each downstream issue.
10. Reject missing bindings and unsupported older records without modifying state or releasing resources.
11. Define exact runtime handoff rules: SDK/Herdr may switch only through current guarded handoff; host binding cannot change silently.
12. Document the adapter interface with native and Linux examples that differ only in physical mechanism.

### Verification and adverse cases

- Preserve account snapshots and agent execution through serialization, resume and explicit SDK/Herdr handoff.
- Reject generation/turn/account/backend mismatches even when host identity matches.
- Keep current agent-dispatch, durable turn-ownership and runtime-handoff regressions passing.

- Reject a Darwin receipt attached to a Linux intent and vice versa.
- Reject helper/profile/version and host-identity mismatches before recovery or work admission.
- Decode current-format explicit not_started and unknown cases without inferring success.
- Open an older-format database read-only enough to reject it and verify its contents remain unchanged.
- Same installation with a different boot can consume an intact historical receipt while still requiring current live identity for new work.
- Another native host presenting copied run records and their copied installation token is rejected even when supplied paths and file identities look equal.

- Exercise SDK/Herdr switching while preserving the platform binding.
- Run existing pure guard and journal tests with an explicit Linux backend fixture.

### Acceptance criteria

- The domain has no Darwin native types or Bubblewrap command-line fields.
- New records require explicit execution identity; missing fields never acquire defaults that imply proof.
- Linux and Darwin adapters can satisfy the same typed contract without changing model capabilities.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-03 — Implement the bounded native helper protocol

Depends on: MAC-02.

### Scope and rationale

A small helper is necessary for descriptor-relative calls and native lifecycle APIs. A bounded protocol reduces the authority of that helper and keeps scheduling in TypeScript.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/worker-request.ts
- src/adapters/private-io-files.ts
- src/adapters/command-lifetime.ts
- package.json

### Implementation contract

Specify channel roles before choosing native descriptor numbers. Current command-lifetime.ts uses
outer stdin for a bounded 1,048,576-byte supervisor JSON request, fd 3 for cancellation, and optional
fd 4 for app-server streaming input. pid-namespace.ts separately maps extraInput to the immediate
target's fd 3: trusted fixed workers consume a socket-backed 65,536-byte strict UTF-8 JSON request
(worker-request.ts), while reviewer launch consumes verified immutable review-packet bytes.
These are distinct roles, not a general inherited control channel. Allowlist each role; preserve the
trusted-worker fd-3 socket API or update its sender/reader together. Only explicitly admitted data
descriptors survive into their intended trusted target. Arbitrary workloads receive neither supervisor
requests nor cancellation/helper/receipt authority; public output and interactive stdin stay separate.
Keep the existing bounds and strict decoding unless an explicit versioned change justifies new limits.

1. Add a C17 native source/build directory and a TypeScript transport adapter. The filesystem helper uses reviewed POSIX APIs and does not depend on MAC-01; any additional lifecycle mechanism is integrated later by MAC-04 after qualification.
2. Define a versioned request envelope with operation ID, generation, expected peer/host binding, bounded payload, and explicit reply type.
3. Expose only reviewed operations for file handles, lifecycle admission, policy installation, and observation; never arbitrary shell or syscall forwarding.
4. Use a private inherited channel for helper framing and peer verification. MAC-11 separately owns the required reconnectable operation-control endpoint; this task does not claim an endpoint fallback.
5. Keep directory and process handles opaque and local to the helper; never treat client-provided fd integers as authority.
6. Define maximum request, reply, path, and handle counts and reject over-limit input before allocation or work.
7. Make cancellation and EOF handling independent of stdout backpressure and controller event-loop progress.
8. Set close-on-exec for every control descriptor and demonstrate commands cannot inherit helper authority.
9. Separate public diagnostics from private requests; redact credentials and never log token-cache bytes.
10. Define helper crash behavior: outstanding operations become unknown unless exact independent evidence is retained.
11. Implement explicit graceful shutdown and handle cleanup without disposing registered workspaces or terminating unrelated processes.
12. Freeze the helper protocol version and binary digest in launch admission so replacements cannot answer old operations.

### Verification and adverse cases

- Component tests verify each declared descriptor role, oversized/invalid UTF-8 refusal, and EOF
  cancellation independent of interactive stdin and output pressure. MAC-06/08 own real worker/reviewer integration.

- Malformed, oversized, duplicate, unknown-version, and truncated requests are rejected without target effects.
- An unrelated same-user process cannot attach to or issue operations on an owned channel.
- A command attempts to enumerate/inherit descriptors and cannot obtain the helper control channel.
- Broken output pipes do not prevent cancellation or settlement.
- A stale opaque handle after helper restart cannot resolve to a new directory or process.
- A replaced helper binary or endpoint is rejected before dispatch.

### Acceptance criteria

- The helper component builds and passes on the observed development target with provisional target metadata; transport failures are bounded and typed.
MAC-18/MAC-25 own final qualification of every advertised target.
- A real helper test proves descriptor/channel isolation, generation binding, and crash behavior.
- The TypeScript interface contains operation-specific requests rather than a general native escape hatch.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-04 — Implement the qualified macOS process supervisor

Depends on: MAC-01, MAC-02, MAC-03, MAC-11.

### Scope and rationale

The macOS supervisor must preserve the existing independent lifetime and recovery evidence. Moving timeout or kill logic into the controller alone reintroduces the failure the Linux guardian was built to avoid.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/pid-namespace.ts
- src/adapters/command-lifetime.ts
- src/adapters/command-lifetime-cli.ts
- src/adapters/codex-launch-cli.ts

### Implementation contract

1. Implement precisely the positive mechanism established by MAC-01; do not substitute process-group cleanup if that proof used a stronger domain.
Implement the MAC-02 native identity observation primitive in this gated helper; MAC-21 integrates those observations into recovery and cannot change earlier wire schemas.
2. Create the guardian before releasing the admitted workload to execute.
3. Bind a one-use generation and private control channel to the complete admitted process domain.
4. Close launch admission on cancellation, deadline, controller EOF, or detected authority loss.
5. Enforce deadlines with a native monotonic clock outside the Node event loop.
6. Drain output separately from waiting for domain termination; inherited stdout must not prevent cleanup.
7. Report target exit status separately from domain stop and native supervision errors.
8. Persist stopped only after the exact domain has no possible remaining writers or descendants under the qualified mechanism.
9. Treat guardian loss, ambiguous membership, or failed termination as unknown; retain exclusions.
10. Implement never-started fencing so a replacement controller prevents a delayed launcher atomically.
11. Provide exact live identity signalling and never signal saved PID/group values without current operation binding.
12. Keep the Linux namespace adapter and its race protections intact behind the shared interface.

### Verification and adverse cases

- Run every positive/negative lifecycle fixture from MAC-01 against the production helper.
- Cancel before native guardian readiness and before command exec.
- Kill controller and guardian independently; verify different outcomes.
- Exercise repeated cancel calls, concurrent timeout, and normal exit without duplicate receipts.
- Hold stdout open in a descendant and suspend the controller event loop.
- Demonstrate delayed launch rejection after recovery fencing and rejection of another operation's receipt.

### Acceptance criteria

- Native production supervision satisfies the complete lifecycle contract with real subprocesses.
- Unknown stop cannot release a workspace, settle review eligibility, or authorize publication.
- Existing Linux namespace lifetime tests remain green with their physical implementation unchanged.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-05 — Implement native filesystem/network confinement profiles

Depends on: MAC-01, MAC-02, MAC-03, MAC-12, MAC-13.

### Scope and rationale

macOS does not provide Bubblewrap mounts or private network namespaces. Native policy must enforce actual required access restrictions rather than copy Linux flag names or open the user's home.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/sandbox.ts
- src/adapters/codex-confinement.ts
- src/adapters/codex-launch.ts
- src/adapters/fixture-bridge.ts

### Implementation contract

Replace Linux mount-view assumptions deliberately: sandbox.ts uses /workspace, /tmp/epicd-home,
synthetic /etc/passwd and private /tmp; fixture adapters use /epicd-* aliases. A native access profile
does not create these paths or virtualize their contents. Define actual admitted workspace/cwd, HOME,
TMPDIR and fixture-tool/socket paths in the native command binding, preserving relative check argv,
source/scratch separation and evidence identity. Do not create global root aliases or symlinks to imitate
mounts. Qualify tools that consult user databases instead of HOME, and reject unavailable isolation
rather than exposing the operator home or claiming a synthetic user exists.

Profiles must honor the exact frozen accountBinding: exclude all managed account source homes and
supervisor controls while exposing only the current agent's private refresh-free access-token projection.
Preserve principal, canonical home device/inode and binding continuity. Same-principal token rotation
remains valid; replaced principal/home identity requires new-run selection, never ambient credentials.
Define a separate neutral pre-run model-discovery profile without repository, source config, hooks,
plugins or sibling accounts. Its provider endpoint access must not broaden worker/service scope.

1. Implement capability-qualified native policy generation using the mechanism proved by MAC-01.
2. Separate worker, reviewer, coordinator, tracker, trusted kernel worker, and validation profiles.
3. Allow only registered source mode, scratch, provider artifacts, and pinned executable/resource roots.
4. Retain protection for .git, .beads, .epicd, .codex, AGENTS.md, configuration files, and launch receipts.
5. Keep model transport networking distinct from local tool networking using the pinned Codex permission profile and real nested-policy tests.
6. Deny user home credentials, controller state, control endpoints, undeclared sockets, Mach/XPC escape routes, and unrelated processes.
7. Admit macOS loader/framework/resource requirements narrowly and record why each is needed.
8. Do not claim Linux-like process or mount invisibility when the native backend only denies access; compare required information restrictions explicitly.
9. Freeze compiled policy/profile identity and reject mutation between preparation and launch.
10. Keep validation outbound and loopback denial separate from explicitly granted service endpoints.
11. Refuse unknown policy operations or failed profile installation rather than spawning unconfined.
12. Include read-only review evidence at a backend-owned path, with immutable digest binding and no private control directory exposure.

### Verification and adverse cases

- Run a relative-path repository check under a native workspace path containing spaces, with isolated
  HOME/TMPDIR and concurrent scratch roots; observe the bound paths and unchanged protected source.
- A tool bypassing HOME through user lookup must not gain operator-home access.

- Attempt writes to protected metadata and read-only source with native tools and direct syscalls.
- Attempt reads of outside sentinel files, auth cache, controller state, sibling workspaces, and launch records.
- Test symlink, hardlink, case alias, Unicode alias, and inherited-descriptor access paths.
- Test outbound sockets, arbitrary localhost listeners, Unix sockets, and IPC-mediated launches.
- Verify a legitimate pinned Node/toolchain process and Codex version probe function under their intended profiles.
- Run two simultaneous profiles and prove resources cannot cross between them.

### Acceptance criteria

- Every access restriction required by the shared contract has a real native positive and negative test.
- Policy construction cannot expose arbitrary host files merely to make a missing tool work.
- Backend qualification fails closed when a required macOS primitive or policy rule is unavailable.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-06 — Port all durable Git and workspace workers to host execution

Depends on: MAC-04, MAC-05, MAC-10, MAC-11, MAC-13.

### Scope and rationale

These trusted operations still spawn programs and hold resource exclusions. Native support must cover the entire operation lifetime, not only the final Git command or the outer model process.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/repository-io.ts
- src/adapters/workspace-creation-io.ts
- src/adapters/capture-io.ts
- src/adapters/commit-io.ts
- src/adapters/publication-io.ts
- src/adapters/workspace-inspection-io.ts
- src/adapters/validation-io.ts

### Implementation contract

Inventory deadline values and owners as well as launch call sites. repository-io.ts currently uses a
120,000 ms Node setTimeout and omits timeoutMs in startNamespaceProcess; a mechanical port would retain
an event-loop-dependent timeout. Admit that budget into MAC-04's native monotonic deadline before
releasing repository acquire/release work, including delayed guardian startup. Preserve existing budgets
for other families, including validation's min(2_147_483_647, check.timeoutMs + 120_000) bound.
Apply MAC-03's descriptor-role contract to real trusted workers: their bounded private request is not
repository stdin. Deliver only intended channels to the fixed worker and close them before arbitrary commands.

Port the generic startDurableCommand contract, including interactiveInput/forwarded stdin used by
pre-run account discovery. Inventory that consumer without implementing its app-server protocol here;
MAC-08 owns integration. Preserve independently retained synthetic-operation intents/receipts for work
that has no durable run row or controller lease yet. Do not manufacture a run to supervise such a probe.

1. Inventory every startNamespaceProcess and startDurableCommand consumer and record its native routing.
2. Route repository ownership acquire/release through the qualified backend without changing Git compare-and-swap guards.
3. Route workspace creation, candidate capture, commit construction, publication write/read, standalone inspection, and validation worker lifetimes.
4. Retain preflight, object writes, ref updates, postinspection, and stop receipt inside each operation's admitted lifetime.
5. Keep independently stopped write and inspection stages distinct where the current journal already distinguishes them.
6. Preserve private resource locations and canonical ownership bindings outside user checkout and Git metadata.
7. Disable inherited Git hooks, external filters, helpers, pagers, and configuration wherever the existing trusted-operation contract requires it.
8. Record a bounded, redacted native failure without repeating object construction or mutating the user index.
9. Ensure recovery discovers pending worker records directly rather than requiring the parent action to still be present.
10. Expose native launch and receipt identities through existing status readers without exposing private controls.
11. Keep completed-run refusal, controller authority, and exact workspace exclusion semantics unchanged.
12. Audit no remaining unconditional Linux command is reachable from a qualified Darwin operation.

### Verification and adverse cases

- Run a real fixed worker with non-ASCII request data through the native fd contract; a hostile
  descendant cannot inherit the request, helper or cancellation channel.
- Suspend the repository supervisor's JavaScript event loop after dispatch: its admitted native deadline
  still expires, preserves ownership exclusions on unknown stop and publishes only justified receipts.
  Delay guardian startup as a separate case; it cannot reset or bypass the operation budget.

- Kill each worker before binding, after dispatch, during its effect, and after effect before acknowledgement.
- Run exact-ref publication and repository ownership contention across independent state files.
- Race source replacement and changed index/checkout state with commit and publication.
- Recover a standalone inspection with no parent action and a failed parent with an already-settled child.
- Assert no duplicate Git effect and no user index or checkout mutation after recovery.
- Run actual Git subprocesses through the native helper rather than mocking supervision.

### Acceptance criteria

- All listed worker families execute and recover natively through one host contract.
- Stop evidence and physical effect observation remain separately represented.
- The Linux regression suites for the same worker families continue to pass.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-07 — Port confined Beads access and tracker delivery

Depends on: MAC-04, MAC-05, MAC-10, MAC-12.

### Scope and rationale

Run creation reads the epic graph before launching a model, so native Beads access is an early functional blocker. Tracker writes and export must retain the current scope and commit boundaries.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/kernel-beads.ts
- src/adapters/tracker.ts
- src/adapters/tracker-export.ts
- src/adapters/scope-closure.ts
- src/adapters/epic-delivery.ts
- src/adapters/tracker-commit-journal.ts

### Implementation contract

1. Replace Linux-only tracker command construction with the qualified native tracker profile.
2. Resolve and pin a native br executable and required runtime libraries without executing a shell shim.
3. Constrain reads/writes to the bound .beads directory and protected configuration according to the existing operation.
4. Preserve graph bounds, raw requirement identity, open-epic validation, and cancellation.
5. Implement read-only epic listing for the launcher without claims, exports, or status mutation.
6. Keep isolated SQLite backup and tracker export in a private copy, never flush the user's live JSONL as a side effect.
7. Preserve count/hash and later live-graph comparison checks for retained export content.
8. Route tracker commits and publication through the native durable worker contract, not direct shell calls from the orchestrator.
9. Retain guarded descendant/container/root closure and exact closed-task provenance.
10. Expose missing br or unsupported native tracker policy before durable run creation.
11. Do not use the planning workspace's actual issue graph as a destructive integration fixture.
12. Use disposable tracker repositories for all mutation and recovery tests.

### Verification and adverse cases

- Read an open epic graph natively without modifying database, JSONL, or dirty markers beyond explicitly admitted br behavior.
- Attempt tracker command access outside its bound .beads root.
- Cancel a tracker read/write and distinguish retained effect from independent stop evidence.
- Export a WAL-backed fixture and verify the live tracker remains unchanged.
- Publish a tracker-only commit and prove application tree lineage is retained.
- Close a disposable epic only after required descendant and final-review evidence.

### Acceptance criteria

- Native startup can discover valid Beads epics and native delivery can export/commit/close its test tracker.
- All side effects remain scoped to their exact admitted operation.
- No native code path substitutes broad br shell authority for the deterministic tracker interface.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-08 — Integrate native SDK and Herdr agent launch/recovery

Depends on: MAC-04, MAC-05, MAC-06, MAC-11, MAC-12, MAC-16.

### Scope and rationale

SDK and Herdr are distinct transports sharing launch ownership. Both must use the same native isolation and stop semantics or runtime choice would silently change the delivery contract.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/agent-journal.ts

- src/adapters/agent-dispatch.ts
- src/adapters/accounts.ts
- src/adapters/account-model-discovery.ts
- src/adapters/codex-settings.ts
- src/domain/agent-execution.ts
- src/domain/agents.ts

- src/adapters/controlled-launch.ts
- src/adapters/controlled-sdk.ts
- src/adapters/controlled-herdr.ts
- src/adapters/codex-launch.ts
- src/adapters/codex-native-state.ts
- src/orchestrator/sdk-source.ts

### Implementation contract

MAC-02/MAC-15 order first-install authority before this probe; do not create it inside passive discovery.
MAC-06 supplies durable command lifetime for pre-run model discovery. The probe freezes a synthetic
operation identity and cleanup intent before a run/controller lease/agent exists; request only the bounded
initialize/model-list protocol, never model turns or managed config. Preserve pagination, retry limits,
stop-finalizer precedence and cleanup-pending state; retain token-bearing storage while stop is unknown,
and reclaim it only when the original exact receipt validates (including late-stop observation).
Keep direct driver mismatch refusal before reservation/materialization and full journal launch-binding
validation for coordinator and worker turns; no run-wide driver may override a saved generation.
Preserve cold and explicit retained-coordinator handoff as distinct modes. Sharing a provider home/session
requires exact transfer lineage, same account binding and stopped source generation. Scratch/artifacts/
controls and launch confinement stay generation-local rather than inherited from old provider config.

Integrate through ControlledAgentDispatcher and the generation-owned AgentExecution/accountBinding.
Preserve account-bound launch manifests, per-turn auth projections, typed provider/usage-limit failures,
and the existing account-source selection policy; do not add implicit runtime/account fallback.
Port account-model-discovery.ts pre-run app-server supervision to the same qualified native launch,
confinement and stop mechanisms. Keep its bounded outputs, account-specific cache/read access,
explicit abort-and-drain lifecycle, private artifacts and failure cleanup; do not use an unconfined probe.
MAC-12 supplies executable/toolchain discovery; MAC-08 owns this actual supervised process integration.
Compose existing Effect v4 boundaries without losing the underlying failure or returning before drain.

1. Route ControlledLaunches through the host adapter while retaining each exact agent/turn generation.
2. Resolve the selected Darwin Codex installation and require its matching code-mode host/resources.
3. Keep the managed token cache outside agent storage and expose only the current admitted authentication mechanism.
4. Launch SDK streams through the real packaged native launcher; retain provider output and independent stop as different evidence.
5. Launch native Herdr Codex in an explicitly owned unfocused tab/pane with exact endpoint bindings.
6. Use bounded readiness handshakes published atomically; a terminal that appeared is not launch acknowledgement.
7. Keep review packet integrity and immutable configuration verification before execution.
8. Retain private transcript and control socket access through MAC-11's native file/control protocol.
9. Implement interruption, timeout, startup failure, controller loss, and current-format turn recovery for both transports.
10. Refuse stale endpoints, reused terminal IDs, changed native binary identity, and unknown launchers.
11. Do not close unrelated Herdr panes or infer process stop from pane absence.
12. Retain SDK/Herdr handoff checks and coordinator conversation rollover without changing host binding or worker contracts.

### Verification and adverse cases

- Exercise interactive model-discovery stdin and immutable reviewer-packet delivery through MAC-03's
  distinct native descriptor roles; neither input can be interpreted as a trusted worker/control request.

- Exercise distinct coordinator/worker/reviewer account selections, frozen resume and account-bound manifests.
- Native pre-run model discovery handles success, unavailable model, provider/usage-limit failure,
  cancellation and timeout without creating a run or leaking an unobserved process.
- Keep old-generation recovery on its recorded runtime after a run handoff, never today's default.

- Use deterministic provider fixtures for transport decoding while running real native launch and stop mechanisms.
- Start and cancel a real native Codex version/help probe under the admitted profile without a model request.
- Exercise failed readiness, replaced configuration, forged review evidence, and a stale stop receipt.
- Kill the controller during SDK and Herdr launch setup and inspect retained resource/turn state.
- Verify Herdr endpoint mismatch preserves user terminal sessions.
- Confirm two concurrent agents cannot read each other's launch controls or writable scratch.

### Acceptance criteria

- Native admission works with explicit model settings and with account-scoped model discovery.
- Current account selection, provider-failure classification and per-generation dispatch invariants survive the port.

- Both controlled transports use the qualified Darwin backend and preserve immutable turn contracts.
- Native lifecycle tests pass independently of authenticated whole-epic acceptance.
- No SDK wrapper is presented as native Herdr and no unconfined fallback exists.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-09 — Port native validation and exact-revision evidence

Depends on: MAC-05, MAC-06, MAC-12, MAC-13.

### Scope and rationale

A Mac port is useful only if repository checks run with the real macOS toolchain and still establish exact-source evidence. A successful command outside the native profile cannot certify delivery.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/validation.ts
- src/adapters/validation-io.ts
- src/adapters/sandbox.ts
- src/adapters/epic-delivery.ts
- src/domain/delivery.ts

### Implementation contract

1. Build native validation environments from frozen repository checks and admitted toolchain roots.
2. Preserve sourceMode, immutable candidate manifest, explicit writable scratch, cwd, environment bindings, and exact command argv.
3. Remove Linux-only profile literals from validation targets through the MAC-02 schema binding.
4. Keep preflight, confined execution, service preparation, postinspection, and result retention in one supervised validation worker.
5. Retain existing per-check timeout plus the bounded worker envelope rather than stretching timeouts to hide native failures.
6. Keep pre-commit and exact-revision checks separately bound and independently report their results.
7. Reject a source mutation, root replacement, policy change, or native profile mismatch even when the command exits zero.
8. Support ordinary native Node/npm and a compiled fixture without relying on Linux binary directories.
9. Treat missing optional fixture/service capability as an explicit check failure or unavailable capability, never a skipped pass.
10. Keep model diagnostic checks separate from required validation approval.
11. Retain bounded output, secret redaction, cancellation, and original result acknowledgement.
12. Revalidate the final published application/tracker lineage under the correct target instead of reusing an earlier success by filename.

### Verification and adverse cases

- Run passing and failing checks against a real disposable native repository.
- A check exits zero while modifying tracked source and is refused as evidence.
- A check retains a background writer; result cannot settle before the complete native domain stops.
- An exact-revision check against another SHA/profile/host cannot satisfy the target.
- Cancel while preflight or postinspection holds a workspace exclusion.
- Exercise Homebrew paths with spaces, native compiler resources, and missing libraries.

### Acceptance criteria

- Native required checks establish source, policy, profile, and process-stop evidence.
- Failure and unavailable capability remain visible to the orchestrator without automatic bypass.
- Linux exact-revision and independent-review gate behavior is unchanged.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-10 — Implement descriptor-relative native filesystem operations

Depends on: MAC-03.

### Purpose and rationale

Provide the native filesystem building block needed by private receipts, inspection, transcripts, and disposal.
`src/adapters/inspection-files.ts` currently traverses `/proc/self/fd/<fd>` and rejects non-Linux hosts.
`src/adapters/private-io-files.ts` and `src/adapters/workspace-disposal-files.ts` use the same technique.
Checking `realpath` and then reopening an absolute path would reintroduce the parent-replacement race the current code prevents.
Use helper-owned directory descriptors and relative operations so mutable names cannot redirect already-bound authority.
Keep domain APIs independent of a native descriptor integer, its platform flags, and helper process lifetime.

### Inputs and dependencies

Blocked by MAC-03, which specifies the helper wire protocol, handle ownership, error taxonomy, and bounded framing.
Before MAC-01 finishes, component tests run on the observed development target and record provisional OS/filesystem metadata.
Final advertised-matrix qualification is MAC-18/MAC-25; MAC-01 consumes these measurements without blocking independent filesystem work.
This task does not implement descendant containment, sandbox profiles, or kernel journal transitions.
Use `src/domain/state-file-identity.ts` as the existing path/device/inode identity contract.
Use `InspectionError` and existing inspection budget/error tests as behavior that must survive the port.

### Implementation contract

Add a narrow filesystem client adapter backed by the helper, with opaque handles scoped to one authenticated session.
Expose only operations actually consumed: open root, open child directory, open regular file, stat, bounded read, readlink, list, exclusive create, sync, link-no-replace, and close.
Absolute roots must be admitted through a canonical root descriptor walk; subsequent requests name one validated component or validated relative components.
Use `openat`, `fstatat`, `readlinkat`, `linkat`, `fdopendir`, and relevant platform flags only after verifying their Darwin contracts.
Reject NUL, empty interior components, `.` and `..`; do not interpret URL encoding, shell expansions, or backslashes as alternate paths.
Apply `O_NOFOLLOW` to every walked directory and to regular-file opens; never follow the final symlink when reading a link value.
Pin an opened descriptor and use `fstat` for type, owner, mode, device, inode, and link-count checks.
Retain 64-bit device/inode values losslessly as decimal strings across JSON and TypeScript boundaries.
For directory enumeration, duplicate the descriptor before `fdopendir` when needed to keep handle ownership explicit.
Define whether directory entry byte sequences that are not valid UTF-8 are rejected; never decode two names into the same replacement-character path.
Keep stream/read budgets enforced in the helper as well as the TypeScript caller so malformed requests cannot allocate unbounded native memory.
Preserve current inspection limits: 4 MiB default file, 32 MiB aggregate, 10,000 entries, 64 levels, and deterministic path sorting.
Preserve `.git` and `.codex` exclusions and single-link regular-file restrictions in inspection.
Check file size, modification/change times, and link count around reads, returning changed-file errors instead of partial certified observations.
Closing a session closes all owned descriptors; stale handles and handles from another session must fail before any filesystem operation.
Controller-owned read sessions close on controller disconnect.
An admitted operation uses a distinct supervisor-owned helper session that survives controller disconnect through cancellation, domain-stop observation, and terminal receipt publication.
Only that supervisor closes its receipt descriptors after settlement; MAC-11 must not give them to a controller-owned read session.
Cancellation stops further enumeration/reads and closes temporary descriptors; it does not claim an underlying supervised writer stopped.
Use POSIX error codes in structured helper failures and retain caller-specific domain error mapping.
Specify synchronization semantics separately for file contents and parent directory entries, with Darwin qualification tests.
If required durability is unavailable on a target volume, expose a capability failure instead of swallowing sync errors.
Linux continues using its current implementation until parity tests justify routing it through the shared interface.

### Adverse-case verification

Race replacement of each ancestor with a symlink while reading, listing, creating, and linking files.
Replace the named root after it is opened and verify the held root is not redirected and `assertRoot` detects the change.
Exercise FIFOs, devices, sockets, hard links, sparse large files, and symlink loops without hanging or escaping limits.
Send forged, stale, cross-session, duplicated-close, and high-volume handle requests.
Abort traversal after opening several levels; inspect helper descriptor counts for leaks.
Grow and truncate a file during bounded reads; reject inconsistent observations.
Test integer identities above JavaScript's safe integer range using protocol fixtures.
Exercise both default case-insensitive APFS and case-sensitive APFS qualified volumes.

### Acceptance and unblocks

Existing inspection semantics pass against the native implementation on the observed component target, with provisional OS/filesystem evidence.
MAC-18/MAC-25 expand this evidence to every advertised Darwin architecture before release.
A real race harness shows no read or write is redirected outside the held root.
Neither native production source nor tests implement descriptor confinement by `/dev/fd/<fd>/child` substitution.
Document supported sync behavior and the exact filesystems on which it was measured.
Unblocks MAC-11 private protocols, MAC-13 identity admission, MAC-14 disposal, and MAC-22 adversarial parity.

## MAC-11 — Port private receipts, launch control, and transcript ingestion

Depends on: MAC-03, MAC-10.

### Purpose and rationale

Move private protocols onto descriptor-relative I/O without weakening the evidence they retain.
Source anchors are `private-io-files.ts`, `codex-launch.ts`, `codex-launch-cli.ts`, and `codex-transcript.ts` in `src/adapters`.
`claimPrivateIO` uses exclusive `started.json`; `publishPrivateStop` retains a staging hard link and publishes without replacement.
Launch control currently binds and connects through `/proc/self/fd/<fd>/control.sock` to avoid long absolute socket paths.
Transcript ingestion is diagnostic only; provider task-complete messages cannot become stop or approval evidence.

### Inputs and dependencies

Blocked by MAC-03 helper protocol and MAC-10 descriptor-relative filesystem operations.
Coordinate MAC-04 supervisor stop-proof payloads through MAC-02's execution contracts; no circular dependency on an adapter implementation.
MAC-02 defines the complete host/boot/backend identity schemas, comparison rules, and required receipt fields before this task starts.
The gated MAC-04 helper provides qualified native identity observations; MAC-11 component tests may use immutable identity fixtures without claiming native process qualification.
MAC-11 serializes and validates those schemas; MAC-21 later integrates their native observation with recovery.
Retain `CodexLaunchSchema`, generation checks, journal bindings, and parser bounds unless MAC-02 explicitly versions their contracts.
Schema changes are a fresh-state hard cut, not an old-receipt decoder with optimistic defaults.

### Implementation contract

Support explicitly retained provider-home transcript custody only through the persisted transfer lineage;
same-path coincidence is not shared authority. Launch configuration, control paths and receipts remain
generation-specific even when an authorized continuation reuses provider home/session data.

Include src/adapters/accounts.ts and src/adapters/codex-credentials.ts in native path/custody review.
Preserve bounded owner-only single-link auth/preferences/projection files, source-home no-shared-write
checks, canonical overlap checks and read-once validation/projection. Never apply receipt two-link rules
to credentials. Managed refresh secrets and source home/config remain outside every agent profile.

Implement exclusive claim as native descriptor-relative creation, writing and syncing the full bounded record before acknowledging claim ownership.
A delayed duplicate launcher that loses claim must never publish any terminal receipt for the winner.
Retain immutable staging publication and no-replace final linking; validate owner-only mode, owner UID, regular-file type, size bound, and expected retained link count.
Preserve the existing 16,384-byte stop-receipt bound unless a reviewed versioned contract changes it.
Do not regenerate terminal outcomes when sync fails after publication; return uncertainty and preserve both paths.
Bind every read receipt to the operation, generation, directory identity, backend, and qualified host/boot identity required by MAC-02.
Separate native filesystem custody from the supervisor's authority to assert stopped; a successful file write does not establish process extinction.
Remove unchecked absolute `started.json` creation from both `codex-launch-cli.ts` and recovery-side `preventCodexLaunchStart` in `codex-launch.ts` when integrating the common private protocol.
For persistent launch control, implement a helper-owned AF_UNIX endpoint with a short basename relative to a pinned private directory.
Qualify Darwin bind/connect behavior using an isolated helper process that owns its current directory; never change cwd in the shared Node controller.
MAC-11 owns qualification of the reconnectable AF_UNIX server and client, while MAC-03 supplies framing/authentication primitives only.
If held-directory-relative bind/connect cannot meet custody, path-length, and replacement-controller requirements, keep MAC-11 blocked and revise its native design; there is no assumed fallback.
Retain private directory ownership/mode checks, generation fencing, 1,024-byte request bound, and bounded response/timeouts.
Persist the operation generation and recovery authentication material only in pinned owner-only supervisor storage outside all command profiles.
A replacement controller must pass the current lease check before the adapter obtains that operation capability; an old controller capability cannot issue a new launch.
Authenticate the exact endpoint/session per MAC-03; same UID by itself does not prove operation authority.
Socket replacement, launch-directory replacement, or helper restart invalidates the old endpoint generation.
Long state and runtime paths must work without placing a globally guessable socket outside operation custody.
A missing socket after an exclusive start claim remains unknown, not not-started or stopped.
The supervisor owns the claim/stop session and control-server lifetime; controller reconnection opens a separate read/control client.
Use a connection challenge bound to the exact operation generation in addition to peer UID checks.
A request to terminate a session must name the exact generation and cannot dispose another operation.
Expose inspect/interrupt operations through the existing adapter contract; arbitrary native RPC is never available to a model tool.
Open transcript parents and final files through MAC-10 and preserve read offsets, session matching, digest IDs, retry deduplication, and redaction.
Preserve `ControlledTranscript` gap recording when files are missing, changed, partial, or lack the exact submitted turn.
Do not transform a transcript tail position, final marker, or disconnected control channel into result admission.
Close controller-owned sockets, streams, handles, and read sessions on parse failure, timeout, and cancellation.
Keep the admitted supervisor's separate receipt custody alive through cancellation and settlement.

### Artifact-specific native file contract

The current code has two receipt protocols; this task must not conflate their link counts or byte limits.
Generic command/repository/worker receipts retain stopped.tmp plus stopped.json: final maximum 16,384 bytes, two hard links, owner-only regular files.
New-format Codex stop receipts deliberately adopt the same no-replace two-link publication, retaining their existing 2,048-byte payload limit unless MAC-02 proves its explicit fields require a bounded change.
Update Codex stop readers and writers together to that new-format rule; do not relax single-link requirements for manifests, configuration, auth projections, or transcripts.
Start gates use started.json, exclusive creation, one link, owner-only mode, and their existing bounded per-artifact JSON request schema.
The staging file begins with one link; successful no-replace publication has exactly two links.
A crash before publication retains staging evidence but no completed receipt; a published unsynced outcome stays uncertain until the durability contract settles it.
Preserve original generation/launch digests in each payload and reject a validly shaped file from another operation.
MAC-02 owns any single coordinated storage-format change; this is not a compatibility decoder for old Codex files.
Component acceptance covers native file/control custody with supplied typed payloads; MAC-04/MAC-06/MAC-08 own real supervisor/worker/Codex integration acceptance.
Never label a fixture payload as evidence that an actual process tree stopped.

### Adverse-case verification

Launch two contenders for one directory; exactly one claims and only its valid terminal record is accepted.
Crash between create/write/sync/link/directory-sync and verify recovery preserves uncertainty without replacing evidence.
Substitute symlinks, hard links, FIFOs, overlong JSON, wrong UID/modes, wrong generations, and truncated receipts.
Create state paths longer than a Unix socket absolute pathname budget and exercise inspect/interrupt successfully.
Replace socket names during connection establishment; reject stale or foreign endpoints.
Kill the control server after the start gate but before listening; no consumer infers not-started.
Replay transcript batches after diagnostic append failure; retained event IDs remain stable and deduplicated.
Replace or grow transcript files during reading and verify bounded diagnostics without evidence escalation.

### Acceptance and unblocks

Native component tests exercise dispatch files, Codex receipt serialization, transcripts, and control endpoints.
MAC-04, MAC-06, and MAC-08 add full supervisor, durable-worker, and real Codex integration tests; this packet does not wait on those later implementations.
No Darwin private-control path depends on `/proc` or `/dev/fd` child traversal.
Crash tests demonstrate immutable claim/terminal evidence and conservative unknown states.
Unblocks MAC-06 durable workers, MAC-08 agent integration, MAC-21 recovery, and MAC-22 parity.

## MAC-12 — Discover and admit native Codex and host toolchains

Depends on: MAC-02.

### Purpose and rationale

Remove Linux-only binary selection while preserving the operator's selected installation.
`src/adapters/runtime-discovery.ts` hardcodes `@openai/codex-linux-x64` in its Effect-native SDK and npm-shim resolution; bootstrap re-exports the public wrappers.
The installed `@openai/codex-sdk` already maps `aarch64-apple-darwin` and `x86_64-apple-darwin` targets.
`src/adapters/fixtures.ts` admits only ELF payloads and `ValidationServiceSchema.binDirectory` allows only `/usr/...`.
Native macOS tools commonly live behind canonicalized package-manager prefixes; broad read access to those prefixes is not automatically safe.

### Inputs and dependencies

Blocked by MAC-02 platform/capability contracts so executable admission returns a stable platform-neutral description.
Read the installed pinned SDK package and native package metadata before choosing package layouts; do not upgrade dependencies as part of discovery.
Coordinate read-only executable/dependency manifests with MAC-05 sandbox and fixture/service admission with MAC-19/MAC-20.
Native helper distribution is MAC-16 and must not create a discovery dependency cycle.

### Implementation contract

Keep resolution lazy at Effect execution time and preserve operation-tagged failures and original Promise
rejection values. Skip only expected PATH misses/denials; unexpected filesystem errors such as ELOOP
must not disappear behind another candidate. Never execute an npm shim to inspect its native payload.
Retain test/runtime-discovery.test.ts and bootstrap/doctor compatibility regressions.

Modify sdkNativeExecutableEffect/selectedCodexExecutableEffect and existing typed discovery errors
in runtime-discovery.ts, preserving public Promise wrappers and the pinned Effect v4 API.
Supply the same selected-installation result to per-account model discovery via codex-settings.ts.
Do not embed a second resolver in bootstrap, doctor, the account editor or native launch adapters.
MAC-08 owns the actual pre-run supervised app-server port; this task can close on executable/resource
discovery evidence without falsely claiming account model discovery runs natively.

Add a small explicit target table for existing Linux x64 and qualified Darwin arm64/x64 package names and triples.
Use `process.platform` and the running Node architecture, and explicitly report Rosetta translation if detected by qualified native probing.
Do not silently claim a translated x64 process is a native arm64 execution qualification.
For SDK mode without an override, resolve its pinned platform dependency from the SDK's own installation context.
For an explicit Codex npm launcher, validate its package name/bin mapping and resolve its native dependency from that exact installation.
Never fall back from an incomplete explicit installation to another Codex on PATH or the SDK copy.
For a directly selected native executable, canonicalize once and inspect the payload before launch; do not infer format from extension or basename.
Recognize qualified thin and universal Mach-O binaries with a matching supported slice, and continue recognizing Linux ELF on Linux.
Reject shell wrappers for security-sensitive provider executables just as current fixture admission does.
Distinguish regular executable, unsupported binary format, architecture mismatch, missing native dependency, and failed version probe.
Record canonical path, device/inode, digest, selected architecture, and version wherever the current authority contract already pins executable identity.
Revalidate pinned identity at launch/admission boundaries; a package-manager upgrade cannot silently substitute a newly trusted executable.
Keep argument arrays and shell:false execution; filenames containing spaces or metacharacters remain literal data.
Use the platform path delimiter in generic resolution code instead of embedding a colon in reusable helpers.
Resolve Git, Beads, Node, Codex, and declared PostgreSQL/PgBouncer binaries deliberately; do not inherit an unrestricted interactive shell environment.
Have MAC-05 construct a minimal runtime search path from admitted binaries rather than hardcoding `/usr/bin:/bin` for all macOS checks.
Canonicalize `/opt/homebrew`, `/usr/local`, `/var`, and other symlink prefixes before authority is frozen.
Replace the `/usr`-only validation-service schema regex with bounded absolute canonical-path admission enforced by the kernel.
Separate schema syntax validation from platform-specific filesystem/executable checks so policy hashes remain deterministic.
Never automatically grant an entire Homebrew Cellar, user home, or writable package-manager tree as trusted read/write scope.
Derive and qualify necessary dynamic-library/framework/resource access for selected binaries through MAC-05; Mach-O detection alone does not establish runnable confinement.
Keep fixture management binaries and credentials distinct from repository-visible validation tools.
Include native-path examples for both Apple Silicon and Intel in MAC-25 documentation inputs.

### Adverse-case verification

Test both Darwin target table entries using package fixtures and exercise real payload selection on matching hosts.
Use two different Codex installations; an incomplete explicitly selected one must fail without substitution.
Test npm symlinks, paths with spaces, missing executable bits, invalid manifests, missing optional dependencies, and architecture mismatch.
Test universal Mach-O selection and thin wrong-architecture rejection without invoking an emulation fallback.
Replace a canonical executable between discovery and launch; retain an identity-change error.
Validate declaration paths under canonical Homebrew versions without accepting `..`, NUL, shell wrappers, or writable-root broadening.
Keep Linux selected-installation tests passing and verify no Linux package is chosen on Darwin.

### Acceptance and unblocks

Pinned SDK `codex --version` and explicit selected-installation verification pass natively on each qualified Darwin target.
Errors tell the user exactly which installation/path failed and how to repair it without mutating their installation.
Validation service declarations can represent admitted native macOS tool paths without weakening policy binding.
Unblocks MAC-05 sandbox toolchain scopes, MAC-08 runtimes, MAC-15 doctor, MAC-19 fixtures, and MAC-20 services.

## MAC-13 — Enforce macOS filesystem identity and APFS path safety

Depends on: MAC-02, MAC-10.

### Purpose and rationale

Protect physical repository and state identity when aliases and filesystem comparison rules differ from Linux defaults.
`src/bootstrap.ts` checks state-outside-repository using canonical paths and `relative`.
`src/adapters/publication-git.ts` binds repository root and physical common Git directory.
`src/adapters/store.ts` binds canonical state path/device/inode; `StateFileIdentitySchema` stores numeric identities as strings.
Default macOS volumes may be case-insensitive and names may differ in Unicode normalization; string lowercasing is not a complete filesystem comparator.

### Inputs and dependencies

Blocked by MAC-02 identity contract and MAC-10 native descriptor operations.
Coordinate host/boot identity additions with MAC-21; inode identity must not be treated as globally stable across hosts or copied state.
MAC-01 qualifies which local filesystem configurations are admitted and their durability behavior.
Do not require users to move their repository into a VM or change their whole disk format.

### Implementation contract

Include src/adapters/accounts.ts and src/adapters/codex-credentials.ts in native path/custody review.
Preserve bounded owner-only single-link auth/preferences/projection files, source-home no-shared-write
checks, canonical overlap checks and read-once validation/projection. Never apply receipt two-link rules
to credentials. Managed refresh secrets and source home/config remain outside every agent profile.

Define a single canonical physical-root admission path for repository, common Git directory, state, private resources, workspaces, and tool roots.
Resolve input aliases before freezing identities; persist canonical path plus device/inode, then revalidate identity through held descriptors at sensitive operations.
Accept ordinary user aliases such as `/var` and `/tmp` at the external boundary and freeze their canonical `/private/...` spelling.
Keep mutable relative path text separate from directory authority; a path alone must never become permission to adopt a replacement directory.
Inspect actual volume capabilities using qualified native APIs rather than inferring case sensitivity from OS name or APFS label.
Check state/private resource ancestry against the repository by canonical component/physical identity rules, including case and symlink aliases.
Reject state stored inside delivery content even if its caller spelling uses different case or Unicode normalization.
Preserve shared-common-directory contention for linked Git worktrees and independently chosen SQLite state paths.
Inspect Git tree/index names for checkout collisions under the destination filesystem's actual comparison rules before materialization/publication.
Define a bounded probe in owned scratch storage when no documented comparison API establishes exact behavior; classify uncertain names conservatively.
Never lowercase or normalize the names being committed; Git object names and file contents remain byte-preserved.
Report colliding path pairs and the destination volume limitation; do not rename source files, overwrite one path, or silently select a winner.
Apply metadata exclusions to aliases of `.git` and `.codex` under the destination's effective comparison behavior.
Detect case-only and normalization-only rename transitions explicitly; verify the resulting Git tree exactly rather than relying on directory listings.
Keep hard-link restrictions for inspection and ensure alternate link names cannot expose authority-bearing state or provider files.
Treat APFS clones as distinct objects unless their device/inode identity actually matches; content equality does not prove common authority.
Record filesystem qualification required by operations; volumes lacking required rename/link/sync behavior must fail admission before dispatch.
Retain current path-size and byte-budget bounds, accounting for UTF-8 bytes where native APIs have byte-based limits.
Do not demand Full Disk Access automatically; propagate genuine permission/TCC failures with the affected admitted path.
Ensure read-only status can describe unsupported/moved state without repairing or reattaching it.
Keep schema changes explicitly coordinated with the final hard-cut version and tests rejecting old formats without mutation.

### Adverse-case verification

Run the same repository cases on case-sensitive and default case-insensitive APFS volumes.
Use `Foo`/`foo`, composed/decomposed Unicode pairs, case-only renames, and metadata-directory aliases.
Open the same repository through multiple symlink/case aliases and linked worktrees; ownership remains singular.
Attempt state paths under aliased repository descendants and reject before run registration or publication.
Replace roots, remount a volume, move/copy the SQLite file, and present matching-looking paths from another host.
Exercise Permission Denied/TCC failures without retry loops, broadening permissions, or claiming corruption.
Verify failure reports preserve all files and identify collision/identity causes without dumping private contents.

### Acceptance and unblocks

Native delivery either preserves an exact Git tree on the admitted filesystem or rejects it before destructive/materializing work.
No case-folding workaround creates alternate ownership records or lets private state enter delivered content.
Existing physical-common-directory ownership tests run on macOS with alias cases added.
Unblocks MAC-14 disposal, MAC-15 preflight, MAC-21 host-aware recovery, and MAC-22 filesystem parity.

## MAC-14 — Retain disposed workspaces with native no-replace rename

Depends on: MAC-06, MAC-10, MAC-13.

### Purpose and rationale

Replace GNU `mv` dependence while retaining disposal's evidence and recovery behavior.
`src/adapters/workspace-disposal-files.ts` currently invokes `/usr/bin/mv --no-copy --no-clobber --no-target-directory`.
The source and archive descriptors are inherited and accessed through `/proc/self/fd`.
Disposal means atomic retention of the complete old workspace, not recursive deletion or disk reclamation.
A naive `rename` can replace an occupied destination; copy/delete changes identity and can lose ignored output.

### Inputs and dependencies

Blocked by MAC-06 supervised durable worker integration, MAC-10 native file operations, and MAC-13 identity admission.
Read `src/kernel/workspace-disposal.ts`, `src/domain/workspace-disposal.ts`, and `src/adapters/workspace-disposal-journal.ts` before implementation.
MAC-01 must qualify a Darwin descriptor-relative no-replace rename primitive, proposed `renameatx_np` with `RENAME_EXCL`.
If the primitive or target filesystem cannot satisfy the contract, disposal is unavailable there; never emulate with precheck-plus-overwriting-rename.

### Implementation contract

Open source parent and archive directory through MAC-10 and validate the exact registered device/inode identities.
Validate source and destination basenames as single literal path components.
Recheck current authority immediately before asking the supervised worker to perform the irreversible name transition.
Invoke the qualified native no-replace rename using held parent descriptors and prohibit all copy/delete fallbacks.
Require source and archive to be on the same admitted volume and report EXDEV as preserved-not-moved/unknown according to observed outcome.
Preserve complete directory contents, ignored files, symlinks, executable bits, xattrs, and resource forks by retaining the directory object itself.
Do not traverse content to decide what to retain and do not follow any symlink inside the workspace.
Sync both affected parent directories under the qualified durability contract before acknowledging the move.
Record native operation completion separately from independent worker stop, matching existing journal semantics.
Inspect physical outcome only after independent stop is proven; a reply from rename alone must not release workspace authority.
Retain the three outcomes: retained exact original in archive, exact original not moved, or conflict requiring preservation and inspection.
If the source name is occupied after a successful move, preserve that new occupant and never adopt or delete it.
If acknowledgment is lost after rename, recover by identities in source/archive and sync observed entries before journaling retention.
An uncertain or failed sync preserves files and unresolved authority; it must not initiate a reverse rename or replacement receipt.
Never reuse the original workspace identity for execution after retirement, even if the original pathname becomes free.
Retain historical approval semantics already encoded in the kernel; retention is not new validation evidence.
Close helper handles on every outcome and preserve the operation directory/receipt evidence required for subsequent inspection.
Keep the Linux GNU path or replace it only with separately verified equivalent semantics; macOS work must not regress Linux retention.
Preserve read-only retained-workspace inspection resolution so old run references continue identifying the archived original.

### Source-entry replacement contract

Holding source and destination parents prevents ancestor redirection but does not freeze the source basename.
Immediately before rename, compare the source entry to the registered workspace device/inode/type.
After independently proven worker stop, compare the archived directory identity to the same registration.
If the moved entry differs, record conflict and preserve the archive plus all remaining source occupants.
Do not certify the expected workspace as retained, delete the unexpected occupant, or attempt an automatic compensating move.
A physical postcheck is evidence of the observed move; it cannot retroactively make a replaced entry the registered workspace.

### Adverse-case verification

Use a barrier to replace only the source basename between the final precheck and rename; assert conflict, preservation, and no false retained identity.


Race a new destination into place between validation and rename; the native primitive must not overwrite it.
Replace or rename source parents and archive ancestors; held descriptor custody must prevent redirection.
Crash immediately before rename, after rename, before either sync, after one sync, and before journal acknowledgment.
Recreate the old source pathname after successful retention and verify both original retained data and new occupant survive.
Attempt cross-volume disposal; verify no partial copy, source deletion, destination replacement, or false retained outcome.
Populate symlinks to outside sentinels, FIFOs, ignored build files, xattrs, and nested directories; retention preserves them without content traversal.
Lose supervisor contact while rename may still be executing; no inspection-based release occurs before stop proof.
Replay old disposal attempts and verify generation/retired-authority rejection.

### Acceptance and unblocks

`test/workspace-disposal.integration.test.ts` exercises real native rename and recovery on macOS.
Source and archive device/inode assertions demonstrate preservation of the original directory object.
No Darwin execution depends on GNU `mv` flags or recursively deletes disposed workspace contents.
Unsupported volumes produce an actionable conservative error and preserve both paths.
Unblocks MAC-18 CI completion, MAC-21 recovery cases, and MAC-25 native acceptance/documentation.

## MAC-15 — Replace the Linux gate with capability-based preflight and doctor

Depends on: MAC-01, MAC-04, MAC-05, MAC-11, MAC-12, MAC-13, MAC-16, MAC-21.

### Purpose and rationale

Make a native run either start through a qualified backend or explain the actual missing capability before durable work begins.
`createRun` in `src/bootstrap.ts` currently rejects every host except Linux x64 before repository inspection.
`src/doctor.ts` currently verifies executable versions and Herdr endpoint discovery only and explicitly disclaims confinement proof.
Deleting the platform guard would merely move failures later, potentially after state, ownership, or private resources are created.
Keep diagnosis and admission shared so doctor cannot certify a configuration that run immediately rejects for a known prerequisite.

### Inputs and dependencies

Blocked by MAC-01 qualification decisions, MAC-04 supervisor, MAC-05 sandbox, MAC-11 private protocols, MAC-12 discovery, MAC-13 identity, and MAC-16 packaging.
Use MAC-02 capability contracts instead of importing low-level sandbox implementation flags into bootstrap or UI code.
Coordinate resume and handoff checks with MAC-21 and `handoffRuntime` in bootstrap.
Keep preflight and doctor read-only: no automatic installation, policy writes, migration, authentication or privilege escalation.
Preserve confirmed Start's delayed atomic default-policy initialization after successful admission;
missing policy may use the current read-only defaults preflight, while malformed existing policy fails unchanged.
Explicit account-default Save is an operator action separate from passive startup inspection.

### Implementation contract

Run passive native capability/repository/account admission first, then ensure MAC-02's installation anchor
is durable during explicit new-run setup, then allow active default-model discovery to create its host-bound
intent. Freeze existing anchors rather than replacing them. Passive doctor/browse creates neither anchor
nor probe and never calls model/list.
An explicit model still avoids that discovery; unavailable defaults produce a bounded error, not a hardcoded model.
Preserve account selector precedence, class inheritance and canonical draft validation; reject conflicting draft
and CLI selectors. Preserve handoff lease-finalizer error precedence and serialized settlement on interruption.
Keep test/bootstrap.test.ts, test/doctor.test.ts and Effect/runtime-handoff regressions passing.

Separate historical host/record identity checks from new-launch readiness. Lost HERDR_ENV, unavailable
current accounts or other launch-only prerequisites must not block intrinsically settled history or safe
retained-proof reconciliation. Unsettled work still requires its exact recorded adapter/receipt contract;
missing evidence preserves uncertainty. Recovery never requires fresh login or a new model request.

Reuse createRunEffect's staged admission, frozen per-class accounts and codex-settings model resolution.
MAC-08's native pre-run model discovery is a prerequisite through MAC-21; do not bypass it by forcing a model.
Keep discovery/doctor Effect v4 composition, typed failures, observable sequencing and explicit process drain.
Verify account source/private projection storage and selected runtime requirements before durable registration;
discovery/selection failures must retain their category and cannot start a fallback account or transport.

Separate pure environment discovery from probes and from state-changing admission.
Retain normal `doctor` as read-only availability inspection with bounded version/endpoint checks and explicit qualification results.
Expose active disposable native contract probes only through an explicit doctor option or test command, with owned scratch storage and documented cleanup.
A passive doctor must label untested dynamic guarantees unknown; installed helper version alone cannot certify runtime containment.
Return structured checks with stable identifiers, supported/unsupported/unavailable/unknown status, concise detail, and a concrete remediation where one exists.
Report OS version, executing architecture, translation state, helper build/protocol/backend, binary selection, required primitives, and volume capabilities.
Never print auth tokens, provider home contents, private control tokens, SQL connection strings, or raw environment snapshots.
Make createRun require successful native backend admission for the selected runtime and declared policy capabilities.
Fail missing helper, protocol mismatch, unsupported macOS, unavailable native primitive, invalid tool identity, and unsupported volume before registering runnable work.
Separate repository/state-owner binding checks from benign capability inspection; probing must not acquire workflow ownership accidentally.
After admission and before dispatch, revalidate mutable identities needed by the frozen configuration.
Resume revalidates the recorded backend and host identity instead of silently selecting today's platform backend.
Handoff preserves its read-only preflight and operator-requested version fence; it must not replace a run's execution backend or bypass stop uncertainty.
SDK and Herdr report their own endpoint/runtime requirements while sharing the same native kernel checks.
Policies that request unimplemented fixture/service capabilities receive an exact capability failure, not a blanket claim that all macOS execution is unsupported.
Headless commands write machine-readable requested output only to stdout; user-facing failures go to stderr with a nonzero exit code.
Keep help and version usable without opening SQLite, probing authentication, or requiring native helper availability.
Do not advise a Linux VM, Docker, sandbox bypass, or root as the repair path for native-only admission failures.
Do not silently set permissions, grant Full Disk Access, create PostgreSQL roles, or install Homebrew dependencies.
Keep old-format state failures explicit and non-mutating; recommend a fresh state path where the branch's hard-cut policy requires it.

### Adverse-case verification

Test missing-policy success through read-only preflight then delayed Start initialization. Failures or
cancellation before policy publication leave policy untouched. Once the atomic policy publication succeeds,
a later failure/cancellation before store.create may leave valid defaults, as on master; do not promise a
cross-filesystem/SQLite rollback or remove an operator-visible policy. Test both sides of this boundary.
Test explicit model and account-model discovery paths;
resume/handoff retain saved generation/account bindings after machine defaults change.
Interrupt first-install model discovery before run persistence: retain its anchor/intent with no run row
or policy publication, then demonstrate exact late-stop cleanup without inventing workflow ownership.

Inject each capability failure separately and assert no run, ownership ref, worker, model request, Beads mutation, or fixture is created.
Remove or replace the helper after passive doctor success; run revalidation detects the change.
Test bad signatures/permissions as applicable to MAC-16 packaging without treating all execution errors as missing files.
Check supported/unsupported OS and architecture combinations through fixtures and real qualified hosts.
Use malformed policy, state-inside-repo, missing br, incomplete Codex install, and inaccessible tool roots.
Run doctor outside a repo and on foreign/unsupported state without mutation.
Exercise redirected stdin/stdout and verify structured JSON remains parseable and progress text stays out of it.

### Acceptance and unblocks

Qualified native macOS is admitted and known missing capabilities are identified before dispatch.
Doctor's output distinguishes discovery, tested native capabilities, and unverified end-to-end model delivery.
CLI tests cover passive side-effect boundaries and exact run/resume/handoff admission behavior.
Unblocks MAC-17 default startup TUI, MAC-18 CI, MAC-23/MAC-24 live acceptance, and MAC-25 release docs.

## MAC-16 — Build, package, and verify the native helper

Depends on: MAC-03.

### Purpose and rationale

Deliver the native implementation with the npm CLI so `npm link` and packed installation select the same verified helper.
`package.json` currently builds TypeScript only and publishes `dist`, README, and LICENSE.
The helper must be available after installation without compiling repository-controlled source at run time or downloading arbitrary executables.
A helper that runs in a developer checkout but is omitted from the tarball is not macOS support.
Keep the helper an ordinary user process; packaging must not introduce a privileged daemon or installer.

### Inputs and dependencies

Blocked by MAC-03 helper protocol, native source layout, entrypoint roles, and build identity contract.
Package the C17 component helper for the proposed targets with provisional build metadata; no runtime admission is enabled by this task.
MAC-01 establishes the final minimum OS and lifecycle constraints; MAC-04/MAC-05 must include any later payload in this build contract, and MAC-18/MAC-25 qualify the final artifact.
Coordinate the resolved binary description with MAC-12 without requiring Codex discovery to locate the helper.
MAC-04/MAC-05 add implementation payloads to the build; this task owns reproducible delivery and verification, not proof of their security behavior.

### Implementation contract

Add a deterministic native build command with compiler warnings treated as errors and explicit Darwin deployment target.
Keep native sources in a clearly owned directory and generated helper artifacts outside source paths.
Build the required arm64 payload on a native builder.
Build and execute an x64 payload on a suitable native builder only if Intel support will be advertised; no Rosetta result substitutes for qualification.
Use separate artifacts or a qualified universal binary with every advertised slice verified.
Use immutable platform artifact names plus a manifest containing helper version, protocol version, target, minimum OS, and digest.
Resolve the helper relative to the installed epicd package, not cwd, PATH, a repository-specified setting, or an unverified cache.
Verify package-relative containment, canonical executable identity, architecture, and protocol handshake before use.
Treat missing optional platform artifacts or mismatched helper protocol as actionable install failures, never permission to spawn an unconfined child.
Bundle required helper resources/profile templates with explicit package file inclusion and digests where MAC-03 requires identity binding.
Make development `npm run build` produce the matching native payload on supported hosts or report precisely which native build prerequisite is missing.
Retain a documented cross-platform TypeScript-only development mode only if it cannot masquerade as runnable native support.
Ensure `clean` removes generated artifacts without deleting native sources, retained state, or user resources.
Preserve executable bits through npm packing and installation; test actual tarball contents with `npm pack --dry-run` and a temporary installation.
No network fetch or source compilation occurs on the first `epicd` run; install/build-time behavior is explicit and reproducible.
Document compiler/SDK requirements for source contributors separately from requirements of users installing a released tarball.
Qualify macOS signing/notarization/quarantine behavior for the actual distribution route; do not assume ad-hoc signing bypasses Gatekeeper or grants sandbox capabilities.
If release signing is required, define its CI secret boundary and verify signatures after packaging without embedding credentials in logs or artifacts.
Reject elevated privileges, setuid bits, mandatory launch-daemon installation, and persistent global agents unless separately approved by the native design; the current plan assumes none.
Publish or retain build metadata sufficient to reproduce a failing architecture/minimum-OS artifact.
Keep Node engine compatibility aligned with the existing `>=22.12.0` package contract and test SQLite's native dependency in installed-package smoke tests.
Preserve symlink-aware CLI entry detection so `npm link` executes the package entrypoint exactly once.

### Adverse-case verification

Install a packed tarball in a clean path containing spaces and run help, version, doctor, and helper handshake.
Use `npm link` from a clean rebuild and verify the helper is resolved from that package installation.
Remove, truncate, replace, chmod, and architecture-swap the helper; errors remain explicit and no fallback process starts.
Run a package without development dependencies/compiler access; the shipped native payload is sufficient for qualified operation.
Inspect arm64/x64 deployment metadata and execute on each advertised architecture/minimum-OS validation environment.
Test a deliberately mismatched protocol manifest and a stale helper surviving a TypeScript rebuild.
Verify packaging does not contain auth caches, state databases, test secrets, user paths, or temporary signing material.

### Acceptance and unblocks

Both packed-install and local-link smoke tests reach the same native backend and report the same build/protocol identity.
Published contents include all required binaries/resources and no compile-at-first-run surprise.
The installation failure matrix is covered without unconfined or PATH-based helper fallback.
Unblocks MAC-15 preflight, MAC-18 CI, MAC-23/MAC-24 live package runs, and MAC-25 release delivery.

## MAC-17 — Integrate and qualify the existing epic browser/account setup on native macOS

Depends on: MAC-07, MAC-08, MAC-15, MAC-21.

### Purpose and rationale

Master already routes bare interactive `epicd` to browse and provides pagination/search, account selection,
Start/Resume/Control routing, scoped Ink lifecycle and the installed-symlink entrypoint fix.
Native integration remains open because its Git/Beads/runtime dependencies are Linux-bound.
Start from src/cli.tsx, src/epic-browser.ts, src/tui/epic-picker.tsx, src/tui/epic-picker-session.tsx,
src/tui/account-editor.tsx, src/tui/account-editor-session.tsx, src/tui/ink-lifecycle.ts,
src/tui/run-view.tsx, src/tui/operator-view.tsx and docs/epic-browser-contract.md.
Browsing currently opens StateStore eagerly; avoiding state creation on browse/cancel is still new work.

### Inputs and dependencies

Blocked by MAC-07 safe Beads discovery, MAC-08 current runtime integration, MAC-15 preflight, and MAC-21 current-format resume validation.
Use the existing state path default and provide explicit repo/state selection without accepting repository-local private state.
Retain explicit `run`, `resume`, `status`, `control`, help, and version commands as scriptable interfaces.
This task does not resurrect old configuration fields, automatic migrations, legacy unsafe access modes, or old per-phase engines.

### Implementation contract

Preserve bounded pagination, global search, incomplete-detail states, off-page owning-run visibility and
stale-confirmation rejection. Tracker metadata must not override journal-backed Resume/Control authority.
Use MAC-06/MAC-07 confined Git/Beads discovery, never an unconfined browsing shortcut.
Retain existing Effect v4 scoped Ink lifetimes, signal ownership and account-operation draining;
component unmount or fiber interruption cannot stand in for adapter settlement.

Preserve existing no-subcommand and explicit browse routing on interactive stdin/stdout.
Discover the canonical repository from cwd/explicit option and show a usable error/back/quit state if none exists.
List open Beads epics using the kernel's bounded read-only discovery contract, with title, ID, and run availability.
Show current-format resumable runs and distinguish resume/controller engagement from opening the separate operator console.
Respect the repository's existing workflow owner; never create a second run merely because another state path was selected.
Retain current CLI configuration surfaces and account editor/default/per-class selectors; do not add a new
model/reasoning/runtime wizard as a prerequisite of native support. Preserve frozen selections on Resume.
Default to the existing SDK runtime unless the user explicitly selects Herdr and the caller endpoint passes discovery.
Show the chosen repository, epic, runtime, state location, and actionable admission failures before engaging the controller.
Keep authentication, fixture grants and risky operator controls out of implicit startup.
Preserve delayed atomic default-policy initialization on confirmed Start after admission.
An explicit account-default Save may persist preferences; passive browsing/cancel without Save may not.
Selecting Start calls the same `createRun` and `OrchestratorController` path as explicit `run`; selecting Resume uses the same versioned resume admission.
Opening Control attaches `RunOperator` only and visibly identifies that no new controller is started.
Read-only browsing and cancellation before Start must not create a run, mutate Beads, acquire a workflow reservation, or start a model/pane.
Implement noncreating state inspection for absent default/custom state paths, deferring writable opening
until Start/Resume/Control; current withStore eagerly creates it. Retain ownership rechecks across that boundary.
Guard async selection against double submission, stale list responses, unmount, and repeated Enter; exactly one accepted launch occurs.
Keep preflight cancellation distinct from interrupting an already-started operation; await the relevant adapter/controller settlement before closing state.
After a recoverable preparation failure, show a concise cause and allow back/retry without stale selected-run state.
Wire terminal signals and raw-mode cleanup so exiting startup or run view restores terminal state even when an async action fails.
Use current `RunView` for active runs and current `OperatorView` for attachments; do not fork a second status interpretation.
For no arguments or browse without a TTY, preserve help on stderr and exit 1 without prompting, launching or opening state.
Help and version bypass discovery, native checks, database opens, and Ink mounting.
Preserve the repaired symlink entrypoint behavior and existing headless command stdout/stderr contracts.
Support small terminals, keyboard navigation, clear selection focus, and a visible quit/back hint using existing Ink patterns.

### Adverse-case verification

Use PTY integration tests for bare `epicd`, selection, configuration, startup errors, cancel, resume, and control attachment.
Test npm-linked and packed-installed entrypoints in a real PTY, not only direct `createProgram` invocation.
Test empty/search/paged epic lists, oversized/partial tracker details, valid off-page saved runs,
unavailable tracker, malformed/current-incompatible state, missing-policy onboarding and native admission failure.
Verify absent default/custom state stays absent after browse/cancel, and explicit Save changes only defaults.
Race two Enter events and a cancellation against slow preflight; no duplicate runs/controllers are created.
Replace repository ownership between listing and selection; admission preserves the existing owner and reports the conflict.
Redirect stdin or stdout and verify no raw mode, hidden prompt, spinner, or silent exit occurs.
Assert Ctrl-C and thrown async errors restore terminal state and settle resources before the state store closes.

### Acceptance and unblocks

A user in an admitted macOS repository can type `epicd`, choose an epic/configuration, and reach the current run TUI.
Existing current-format runs can be resumed or inspected without recovering legacy engine behavior.
No-argument/browse noninteractive invocation preserves stderr help and exit 1 without state creation.
Unblocks MAC-18 native CI, MAC-23/MAC-24 user-journey acceptance, and MAC-25 usage documentation.

## MAC-18 — Run native macOS integration, packaging, and UI CI

Depends on: MAC-09, MAC-14, MAC-15, MAC-16, MAC-17, MAC-19, MAC-20, MAC-21.

### Purpose and rationale

Replace the misleading two-file macOS smoke signal with native execution coverage matching the supported product claims.
`.github/workflows/ci.yml` currently runs fast validation plus four Ubuntu integration shards and only codex-process/store-process tests on macOS and Windows.
Many confinement and delivery tests currently skip non-Linux hosts; green macOS smoke tests do not establish that an epic runs.
Keep fast platform-neutral feedback while requiring real native contract suites for a native macOS release.

### Inputs and dependencies

Blocked by MAC-09 validation integration, MAC-14 disposal, MAC-15 admission, MAC-16 packaging, MAC-17 TUI, MAC-19 fixture integration, MAC-20 services, and MAC-21 recovery.
MAC-18 creates native CI jobs and runs the suites delivered by its listed prerequisites.
MAC-22 owns adding its later adversarial/full-delivery cases to these jobs and proving the complete matrix.
MAC-18 closure does not require MAC-22 to exist; final release does.
MAC-23/MAC-24 provide live SDK/Herdr evidence, which requires explicit credentialed jobs rather than pretending fakes prove provider compatibility.
Verify current GitHub-hosted runner architectures/labels before choosing the matrix; label names alone are not an architecture contract.

### Implementation contract

Run account-model-discovery.integration and account-model-discovery-cleanup cases through the real native
supervisor, including stdin protocol, delayed stop and retained pre-run resources. Include current accounts,
account-preferences-effect, account-routing, agent-dispatch and runtime-handoff regression inventories.

Extend npm run test:fast and test:integration with the native inventory; retain the four Ubuntu shards
and bounded parallelism (currently --maxWorkers=3 per shard, Vitest default six workers/30 seconds).
Give parallel tests unique owned directories, process domains and endpoint/port allocations; do not restore
a monolithic serial suite or raise global timeouts to conceal races. Keep Node >=22.12.0 minimum coverage.
Port existing epic-browser/account-selection/operator-console PTY harnesses: GNU script flags and Linux
/workspace fixture assumptions do not work on macOS. Supply a native-compatible owned PTY adapter and
admitted canonical fixture paths, retaining key input, late cancellation and terminal-restoration assertions.
Fix the two CLI recovery-test expectation failures observed on this Mac at 48e1577 (/var/tmp versus
/private/var/tmp) by deriving canonical fixture paths, retaining exact diagnostics and non-mutation checks;
do not weaken production path identity or remove those recovery assertions.

Add native macOS arm64 and x64 matrix jobs for every target advertised by the release.
If hosted runners cannot cover an advertised target/minimum OS, provision an explicit test environment or withhold the corresponding claim.
Print OS build, CPU/process architecture, translation state, Node version, helper identity, filesystem type, and qualified capability results.
Run clean dependency installation, native build, TypeScript build/typecheck, relevant formatting, and native contract tests.
Use explicit capability selection in shared integration tests rather than blanket `process.platform !== linux` skips.
Track expected test inventory per native suite and fail if a required Darwin test is skipped or absent.
Do not weaken Linux assertions to make macOS green; retain Ubuntu full regression and existing Windows limited-support tests.
Exercise process supervision, isolation, durable workers, Beads snapshot/export, both runtime adapters with fakes, receipts, transcript, inspection, publication, and disposal.
Run recovery tests with controller/helper/worker termination at named failpoints and assert retained authority/unknown-stop behavior.
Exercise default case-insensitive APFS plus a qualified case-sensitive volume fixture where required by MAC-13.
Provision PostgreSQL/PgBouncer only in isolated test resources under declared native paths; do not rely on a developer host service.
Run each service/fixture test against the intended native sandbox and network contract, not an unconstrained fake executor.
Add packed-tarball installation and `npm link` smoke cases from MAC-16 with no development compiler on the runtime path.
Add PTY tests from MAC-17 for bare startup, explicit commands, cancellation, and terminal restoration.
Run malicious path/filename, descendant, network denial, receipt, and endpoint component cases already supplied by prerequisites.
Provide the required native-suite entrypoint that MAC-22 will extend with its later adversarial/parity/full-delivery cases.
Use bounded timeouts with teardown that records unresolved resources and fails the job instead of assuming all descendants disappeared.
Upload sanitized logs, helper build metadata, test inventories, and crash evidence necessary to reproduce failures; exclude state auth/provider secrets.
Separate credential-free required PR jobs from opt-in/manual live provider jobs and clearly label what each establishes.
Retain native live acceptance results for the release candidate artifact, not merely the source checkout or earlier helper build.
Make aggregate branch-protection checks require all advertised native target results without allowing cancelled/skipped jobs to count as success.
Keep supported Node minimum coverage and add one current production Node line only after confirming native SQLite/helper packaging compatibility.
Document test duration based on measurements; avoid invented performance thresholds or unlimited integration jobs.

### Adverse-case verification

Intentionally remove a native artifact and skip one required Darwin test; the aggregate check must fail in both cases.
Corrupt a receipt/helper manifest and confirm CI exercises the real conservative error path.
Run architecture assertions under an intentionally mismatched/translated process and reject false native qualification.
Run with no provider credentials and verify fake-driver suites pass while live suites are clearly unexecuted, not reported as proven.
Break a Linux invariant in a test fixture and confirm the existing Linux job still detects it.
Inspect job artifacts for private tokens, SQL URLs, auth.json contents, and user-specific paths before enabling uploads.
Cancel during a crash test and verify cleanup/reporting has a bounded path without changing domain stop-proof assertions.

### Acceptance and unblocks

Required native PTY and canonical-path recovery cases run without blanket Darwin skips.
The aggregate result includes every required native target and integration shard; cancelled/skipped lanes
cannot certify support. Linux fast/sharded coverage and its ownership/failure regressions remain intact.

The CI summary names the actual native architectures, filesystems, backend build, executed suites, and required skip count of zero.
A release candidate cannot advertise native macOS support solely from mocks or two generic process tests.
Packed and linked commands work in the same environments that passed native execution contracts.
Unblocks MAC-25 release acceptance and supplies durable validation evidence for the one native macOS epic.

## MAC-19 — Port native PostgreSQL fixture management and restricted access

Depends on: MAC-04, MAC-05, MAC-09, MAC-12.

### Scope and rationale

Native psql is Mach-O and native sockets are host resources. Supporting them requires precise executable and endpoint admission while keeping management grants and validation grants separate.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/fixtures.ts
- src/adapters/fixture-creation.ts
- src/adapters/fixture-validation-provider.ts
- src/adapters/fixture-bridge.ts
- src/kernel/fixtures.ts
- src/domain/repository-policy.ts

### Implementation contract

Port trusted orchestration as well as executable selection: fixture-bridge.ts uses /bin/bash wait -n -p,
which the observed macOS system Bash 3.2 does not support. Use the native supervisor's bounded child
completion events (or another explicitly admitted qualified implementation), preserving early-broker-death
failure, command exit status and complete stop observation. Do not require Homebrew Bash implicitly.
Replace /epicd-pg, /epicd-upstream, /epicd-psql and related mount aliases with MAC-05's admitted native
socket/tool paths. Never create them at the host filesystem root; management socket/config remains
inaccessible to validation and agent profiles.
Consume MAC-02's requested/resolved endpoint contract for native broker listenPort allocation and URL
construction. Persist exact allocation identity before client admission; evidence cannot reuse another
check's endpoint after restart. MAC-20 reuses this binding for check-local servers and browsers.

1. Admit bounded native Mach-O executables for the qualified architecture, including validated universal binaries.
2. Continue rejecting shell wrappers, replaced binaries, non-executable files, and unqualified interpreter chains.
3. Bind PostgreSQL socket directory and endpoint identity without assuming a Linux filesystem alias.
4. Construct native management profiles allowing only the declared socket and fixed SQL operation.
5. Keep fixture definition, operator grant, role, expiry, database provenance, and operation binding independent.
6. Port the restricted validation broker without exposing admin credentials or the management socket to tests or agents.
7. Scope loopback access to the exact admitted broker endpoint; do not allow all localhost connections.
8. Preserve separate local-client stop and PostgreSQL backend-quiescence observations.
9. Use independent bounded SQL statements where current recovery separates backend stop from catalog state.
10. Retain grant revocation and interrupted-operation recovery without repeating database creation.
11. Keep currently unimplemented reset/cleanup unavailable; native portability must not claim to implement them.
12. Represent missing psql/PgBouncer/native endpoint-isolation capability explicitly in doctor and model capabilities.

### Verification and adverse cases

- On a host with only the system shell, terminate the broker before the check and confirm failure,
  bounded cleanup and retained uncertainty where appropriate; no wait-option error masquerades as success.
- Concurrent native fixture checks preserve distinct bound endpoints and cannot use each other's URLs,
  socket paths or evidence. Tampering with an endpoint binding invalidates validation eligibility.

- Accept a pinned native psql binary and reject a script, changed Mach-O, or wrong architecture.
- Run fixed catalog/create operations only against a disposable test-owned PostgreSQL instance.
- A validation role cannot reach another database, admin socket, credential file, or undeclared loopback listener.
- Revoke or expire a grant while a client is running and retain remote-stop uncertainty correctly.
- Crash after database creation before acknowledgement and reconcile without duplicate creation.
- Verify ordinary worker profiles still cannot access the granted fixture endpoint.

### Acceptance criteria

- Native fixture inspect/create and restricted validation demonstrate the existing grant boundaries.
- Remote database activity is never considered stopped solely because a native client exited.
- No host database or privilege is adopted implicitly during setup, testing, or recovery.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-20 — Qualify native check-local PostgreSQL and browser services

Depends on: MAC-05, MAC-09, MAC-19.

### Scope and rationale

Linux check services rely on private network namespaces. Native loopback isolation needs its own qualified design so browser tests do not gain general host-service access.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/validation-services.ts
- src/adapters/fixture-bridge.ts
- src/domain/repository-policy.ts
- test/fixtures/browser-incident.ts
- test/fixtures/browser-project/browser-check.sh

### Implementation contract

Implement MAC-02's policy-versus-resolved endpoint binding through src/domain/delivery.ts,
src/adapters/delivery-journal.ts and validation-services.ts. Current verification hashes the exact frozen
service definition; do not overwrite definition.port or its digest merely to fit a host-available port.
Bind any explicitly authorized native allocation once per check before readiness/client launch, and use
it consistently in sandbox admission, DATABASE_URL, browser baseURL and recovery/evidence verification.
Account for current initdb trust authentication and PgBouncer auth_type=trust: Linux private namespaces
provide their boundary today. A host listener is not equivalent. Qualify native endpoint isolation and
any required per-check authentication against the stated threat model before exposing a ready endpoint;
credentials alone do not establish connection isolation.

1. Replace /usr-only validation service path assumptions with canonical admitted native toolchain bindings.
2. Implement the native service environment using the mechanism proved for restricted endpoints in MAC-01/MAC-05.
3. Give each check a unique service identity, scratch data root, credential scope, and endpoint allocation.
4. Keep the service inaccessible to ordinary worker profiles and unrelated concurrent checks.
5. Avoid fixed global ports where allocation could race another user or test service.
6. Bind every server, broker, and browser descendant to the complete supervised validation lifetime.
7. Never terminate an existing process merely because it owns a desired port or socket.
8. Use native browser artifacts selected for the qualified architecture rather than chrome-headless-shell-linux64.
9. Retain an explicit distinction between a check-local disposable service and an operator-granted host fixture.
10. Exercise the existing failed-authentication-then-repair browser scenario without weakening worker networking.
11. Fail capability admission if the native mechanism cannot protect the required endpoints; no shared-network fallback.
12. Record native server readiness, teardown, and residual-resource evidence under exact check identity.

### Qualified service design handoff

MAC-01/MAC-05 must amend this packet with the exact qualified transport/profile/helper operations before MAC-20 becomes ready.
If endpoint isolation cannot be established, this task and its consumers stay blocked; a diagnostic is not implementation acceptance.
The acceptance boundary includes hostile repository code in any epicd worker/check and excludes a privileged host administrator.
Do not assume other unsandboxed same-user applications are confined by Seatbelt.
Document separately whether they can connect and whether per-check credentials reject access; credentials are not connection isolation.
If the frozen Linux-equivalent threat model requires their connections to be impossible, qualify that property or leave the gate blocked.
Define allowed endpoint pairs: browser to its application, application to its scoped database/broker, trusted management client to its declared admin socket.
All other worker/check pairs, unrelated loopback listeners, undeclared Unix sockets, external IPv4/IPv6, redirects, and DNS remain denied unless the exact policy declares them.
Bind a unique endpoint lease, check generation, server identity, and readiness nonce before releasing a check.
Prefer actual server binding to port zero with identity-bound discovery where supported; PostgreSQL requires a bounded candidate-port allocation protocol.
Use at most 16 candidate allocation attempts within an explicit bounded native allocation budget and
the enclosing check deadline; EADDRINUSE retries never signal the occupant. Do not call 10 seconds an
existing general fixture deadline: validation-services.ts uses pg_ctl --timeout=20, fixture-bridge.ts
uses at most 50 bounded readiness probes, and the browser webServer has its own 10-second limit.
Retain distinct stage limits and account for them in the enclosing deadline; justify any changed limit
with native measurements. Retries must not reset the whole operation deadline.
Publish readiness atomically only after the exact server responds with its generation-bound health state; close all admission if the deadline expires.
Do not publish a reserved port as ready before the real service successfully owns it.
A task-owned supervisor owns PostgreSQL, broker, application, browser, socket paths, credentials, and scratch for this check.
Store their identities and stop/teardown evidence with the existing validation operation; resume neither reuses an uncertain port nor deletes uncertain scratch.

### Runnable fixture contract

Adapt test/fixtures/browser-incident.ts and the browser-project fixture rather than inventing a second acceptance application.
Resolve native Node/PostgreSQL/PgBouncer artifacts through MAC-12 and matching Chromium through the installed Playwright browsers.json revision.
Do not download executables while a confined validation check runs.
The required repository command remains /bin/sh tools/browser-check.sh from the fixture root.
Preserve EPICD_BROWSER_SOURCE_ROOT, EPICD_PLAYWRIGHT_ROOT, EPICD_BROWSER_NODE, EPICD_BROWSER_EXECUTABLE, and EPICD_BROWSER_OUTPUT.
Only the kernel-supplied DATABASE_URL grants the declared disposable database path; missing URL must reproduce failed authentication.
Change the Linux-only executable bundle layout and fixed 4173 baseURL to the admitted native artifact and endpoint lease.
Use the existing Playwright webServer readiness limit of 10 seconds and keep test assertion/time limits unchanged unless separately justified.
Run npm test -- test/browser-fixture.integration.test.ts test/fixture-bridge.integration.test.ts against the task-owned native fixture.
MAC-18 wires its native capability gate so those suites fail or report blocked prerequisites instead of silently skipping Darwin.


### Verification and adverse cases

- Keep frozen policy bytes/digest unchanged through dynamic endpoint admission, and reject swapped,
  stale or tampered runtime allocation records before accepting evidence or reusing resources.
- Test broker/database/browser readiness failure separately and prove allocation retries remain inside
  the enclosing deadline, with no global host alias or scratch collision between concurrent checks.

- Two concurrent checks cannot connect to each other's database or reuse each other's credentials.
- A preexisting listener causes a bounded allocation failure without being signalled.
- A failed server startup cleans only task-owned scratch after complete domain stop.
- A browser/DB child survives its immediate parent attempt and is covered by supervisor qualification.
- A worker cannot reach a local unrelated sentinel listener even while a service-enabled check runs.
- The browser incident reaches a real failed login and then a green required check with the admitted fixture.

### Acceptance criteria

- The native browser/service contract passes with real native executables and scoped endpoints.
- Every residual process or uncertain teardown remains visible and excluded from reuse.
- Native service support is not advertised on an OS/filesystem where qualification was skipped.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-21 — Bind macOS host/process identity and recovery invariants

Depends on: MAC-02, MAC-04, MAC-06, MAC-08, MAC-13.

### Scope and rationale

PID-only ownership is not adequate for resuming native operations. Recovery must identify the same host/backend and consume historical evidence without adopting unrelated processes or copying state across platforms.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- src/adapters/agent-journal.ts

- src/adapters/agent-dispatch.ts
- src/domain/agent-execution.ts
- src/domain/agents.ts
- src/adapters/orchestration-journal.ts

- src/adapters/store.ts
- src/controller.ts
- src/kernel/reconcile.ts
- src/kernel/repository-admission.ts
- src/adapters/runtime-handoff.ts
- src/domain/state-file-identity.ts

### Implementation contract

Recover abandoned pre-run account-discovery resources by their own retained intent/receipt and host binding,
including cases where no run row was created. Reading valid old stop evidence must not recreate credentials.
Preserve continuation transfer claim/consume/abandon recovery and retained workspace exclusions.
Unreadable unrelated historical owners cannot block intrinsically settled history; an unreadable submitted
owner cannot authorize continued work. Cover current agent-dispatch and runtime-handoff regression cases.

Separate historical host/record identity checks from new-launch readiness. Lost HERDR_ENV, unavailable
current accounts or other launch-only prerequisites must not block intrinsically settled history or safe
retained-proof reconciliation. Unsettled work still requires its exact recorded adapter/receipt contract;
missing evidence preserves uncertainty. Recovery never requires fresh login or a new model request.

Preserve master’s generation-owned backend/runtime/execution/account records and exact durable turn ownership.
Dispatch recovery, inspect and interrupt through the recorded AgentExecution, even after the run changes
runtime. Keep caller/runtime handoff fences, coordinator rollover, and explicit continuation transfer rules;
do not automatically transfer credentials, threads or unknown work to a replacement generation.
Machine account defaults, new executable discovery and current run runtime must not rewrite old ownership.

1. Consume MAC-04 qualified native observations and integrate them into ownership/recovery using MAC-02 schemas; distinguish unavailable identity from absent process. MAC-21 must not introduce a duplicate provider or fields that earlier receipt tasks needed to serialize.
2. Use exact live identity only for ownership checks; keep operation-stop proof in the supervisor protocol.
3. Bind host identity and helper/profile version before allowing resume, handoff, or reconciliation.
4. Refuse a copied/moved state database whose existing canonical path/device/inode contract no longer matches.
5. Refuse Linux records, another Mac's records, or unsupported format without mutating them.
6. Recover native pending workers from their own records even when the parent action was interrupted twice or absent.
7. Keep late old-generation launchers fenced after a replacement controller acquires authority.
8. Preserve repository run-owner contention across linked worktrees and separate state paths.
9. A stale PID marker cannot revoke or signal an unrelated live process.
10. A helper upgrade must either retain a verified compatible reader for the same current proof contract or refuse recovery with an explicit mismatch.
11. Do not convert old evidence, auto-upgrade records, or infer cleanup from a missing process/endpoint.
12. Report unresolved resources and the exact operator-visible reason through status/control views.

### Verification and adverse cases

- Retain account-routing, agent-dispatch, runtime-handoff and durable turn-owner regression cases on Linux
  and add native equivalents with saved execution differing from the run's current runtime.
- Changing account defaults after run creation cannot change resumed credential identity or thread ownership.

- Kill and replace controllers across every admitted worker family with actual native receipts.
- Simulate PID reuse without sending signals to an unrelated process.
- Copy state to a second path/host binding and verify resume refusal preserves bytes and resources.
- Attempt SDK/Herdr handoff with live or unknown work and require refusal.
- Recover a completed run's pending repository-owner release without starting a model.
- Test a missing receipt, replaced private directory, and changed helper after restart.

### Acceptance criteria

- Current-format native restart, interruption, and reconciliation preserve existing exclusions and authority.
- Foreign or unsupported state is never silently adopted or repaired.
- Process liveness, operation stop, physical outcome, and review eligibility remain distinct in status.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-22 — Run adversarial native parity and deterministic whole delivery

Depends on: MAC-06, MAC-07, MAC-08, MAC-09, MAC-14, MAC-18, MAC-19, MAC-20, MAC-21.

### Scope and rationale

Portability claims must be established by the real macOS mechanisms. Deterministic model fixtures allow repeatable whole-kernel delivery while native subprocesses, file operations, and tracker effects remain real.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- test/namespace-lifetime.integration.test.ts
- test/workspace-isolation.integration.test.ts
- test/repository-inspection.integration.test.ts
- test/delivery.integration.test.ts
- test/epic-delivery.integration.test.ts

### Implementation contract

1. Map every existing Linux confinement/lifetime/recovery assertion to a native equivalent or an explicit unsupported release blocker.
2. Run the complete adversarial fixture matrix against packaged native helpers and real subprocesses.
3. Replace blanket non-Linux skips with capability-specific suites whose required macOS job fails if capability is missing.
4. Keep provider decisions deterministic while exercising actual Git, br, helpers, validation commands, publication, and closure.
5. Drive a disposable epic from open tasks through independent reviews, exact-SHA checks, tracker export, final review, and root closure.
6. Include an implementation failure, diagnostic action, corrective work, and an independent reviewer rejection.
7. Inject controller/guardian death at durable barriers and resume only from retained evidence.
8. Test APFS aliases, replaced parents, hard links, receipt spoofing, process escape, endpoint misuse, and concurrent runs.
9. Check no user checkout/index mutation and no task-external process signal or filesystem write.
10. Record pass/fail/skip counts, platform inventory, artifact digest, and retained failed-run locations.
11. Compare Linux regression behavior and refuse a platform abstraction that weakens its existing guarantees.
12. Do not mark this complete from mocked stop receipts or helper unit tests alone.

### Verification and adverse cases

- All Tier B-D required suites run on native arm64 and qualified Intel without blanket platform skips.
- A full deterministic delivery completes with real published refs and a closed disposable tracker root.
- Every adverse fixture either is denied or yields the expected explicit unknown/failure with exclusions retained.
- Two concurrent disposable runs remain isolated and contention works for the same physical Git repository.
- Interrupt and recover validation, agent launch, tracker mutation, and publication independently.
- Inspect test cleanup for residual task-owned processes and preserve uncertainty instead of deleting evidence.

### Acceptance criteria

- Credential-free native full delivery and crash recovery pass through real platform adapters.
- The recorded matrix identifies every required feature and contains no skipped release requirement.
- Linux equivalent suites pass at the same implementation revision.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-23 — Prove authenticated native SDK whole-epic delivery

Depends on: MAC-15, MAC-16, MAC-17, MAC-22.

### Scope and rationale

A deterministic model fixture proves the kernel but not the pinned Codex integration. The SDK release gate must use the actual native provider and the complete delivery path.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- test/model-led-delivery.integration.test.ts
- test/controlled-sdk.integration.test.ts
- src/orchestrator/sdk-source.ts
- README.md

### Implementation contract

Use current ORCHESTRATOR_MODEL and resolveAgentRoleSettings as authority for requested/effective
role settings; no port-specific model fallback. Include explicit/default worker-model paths, multiple
frozen account classes, an explicit retained-conversation handoff and restart in native acceptance.

Exercise current default/per-class account selections and recorded per-generation execution dispatch.
Change machine defaults after run creation and verify Resume retains frozen accounts/backend identity.
Provider/usage-limit failures retain their classification and existing source-selection policy, without an
unapproved account/runtime fallback. Keep real account-routing and runtime-handoff evidence in the report.

1. Run a bounded authenticated acceptance in a disposable repository and tracker, with explicit test-owned state outside the checkout.
2. Use the pinned native Darwin Codex executable and the current coordinator model/settings contract.
3. Start through the installed CLI/TUI path and separately exercise explicit headless startup.
4. Use an epic with multiple dependent tasks, independent review, exact-revision checks, and final root verification.
5. Include a repairable validation failure and a reviewer finding rather than only a happy-path file edit.
6. Exercise pause, controller termination, current-format resume, and a correlated user response.
7. Require real native fixture/browser recovery for the service scenario qualified by MAC-20.
8. Inspect actual Git publication, tracker-only commit lineage, closed descendants, closed root, and completed-run state.
9. Verify repository ownership is released only through the completed-run release boundary.
10. Retain model transcript references and redacted evidence without copying authentication material into the report.
11. Use explicit decision/time budgets; a timed-out or partial run is a failure, not an accepted demonstration.
12. Re-run only affected acceptance after a relevant implementation change and record the tested commit/helper identity.

### Verification and adverse cases

- The actual native model reaches complete delivery and not merely a successful turn.
- Pause/resume and controller loss retain exact agent and operation identities.
- Final approval references the correct published revision and complete evidence packet.
- The installed artifact is used rather than source-only imports or an untracked helper.
- No arbitrary host credential or undeclared service access is required.
- All task-owned resources have known stop or retained explicit uncertainty at test end.

### Acceptance criteria

- The retained SDK acceptance report proves the native end-to-end user workflow and required incident recovery.
- No required check, review, publication, closure, or completion step was simulated or skipped.
- Missing auth/model access is recorded as a blocked live test, never a passing release result.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-24 — Prove authenticated native Herdr whole-epic delivery

Depends on: MAC-15, MAC-16, MAC-17, MAC-22.

### Scope and rationale

Herdr has additional endpoint and shell readiness semantics. An SDK success cannot prove native TUI delivery, and launching a tab alone does not prove a controlled Codex turn.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- test/model-led-herdr-delivery.integration.test.ts
- test/controlled-herdr.integration.test.ts
- src/adapters/controlled-herdr.ts
- docs/operator-console.md

### Implementation contract

Use current ORCHESTRATOR_MODEL and resolveAgentRoleSettings as authority for requested/effective
role settings; no port-specific model fallback. Include explicit/default worker-model paths, multiple
frozen account classes, an explicit retained-conversation handoff and restart in native acceptance.

Exercise current default/per-class account selections and recorded per-generation execution dispatch.
Change machine defaults after run creation and verify Resume retains frozen accounts/backend identity.
Provider/usage-limit failures retain their classification and existing source-selection policy, without an
unapproved account/runtime fallback. Keep real account-routing and runtime-handoff evidence in the report.

1. Run acceptance from a real Herdr-managed caller on macOS with compatible protocol discovery.
2. Create only test-owned named resources and retain exact session/workspace/tab/pane/terminal bindings.
3. Launch actual native Codex TUIs through the qualified helper without substituting SDK workers.
4. Exercise a dependent multi-task epic, independent reviews, exact-SHA checks, final publication, and tracker root closure.
5. Include readiness failure, user response, pause/resume, and controller loss during a native agent turn.
6. Include the native fixture/browser repair scenario without exposing management sockets to agents.
7. Demonstrate runtime endpoint inspection refuses a reused or foreign terminal identity.
8. Do not close existing user tabs or claim pane closure proves process-domain stop.
9. Record the native protocol version, Codex version, helper identity, and full delivery outcome.
10. Keep failed runs and endpoint evidence available for diagnosis without collecting unrelated user terminal contents.
11. Compare SDK and Herdr journal outcomes for the same required workflow.
12. Require all final completion and ownership-release checks at the actual published revision.

### Verification and adverse cases

- Observe real native Codex readiness and final output under exact launch binding.
- Controller death cannot abandon unobserved native descendants as a successful stop.
- A foreign/reused pane is preserved and rejected.
- Independent reviewers and fixture checks execute through the same native platform boundary.
- The epic reaches verified root closure and completed-run ownership release.
- A deliberate failed launch remains a failed/unknown operation with retained evidence.

### Acceptance criteria

- A native Herdr report establishes the full TUI workflow rather than a transport smoke test.
- No SDK substitution, fake stop receipt, or user-pane cleanup is used to finish the test.
- Required endpoint, recovery, and service incident cases pass on the qualified release matrix.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.

## MAC-25 — Publish native support documentation and close the acceptance matrix

Depends on: MAC-10, MAC-11, MAC-12, MAC-13, MAC-14, MAC-15, MAC-16, MAC-17, MAC-18, MAC-19, MAC-20, MAC-21, MAC-22, MAC-23, MAC-24.

### Scope and rationale

Users need a truthful supported installation and startup path, while maintainers need one final gate that accounts for every task and test. Documentation must not advertise native completion from partial platform work.

This task belongs to the native macOS epic and ports the current persistent controller.
Native execution excludes a Linux VM and preserves independent review and exact operation identity.
Unsupported older state is retained without migration; current-format restart remains required.

### Code starting points

- README.md
- docs/operator-console.md
- package.json
- .github/workflows/ci.yml
- docs/plans/macos-support/plan.md

### Implementation contract

Document the existing bare epicd/browse, -C/--repo, --worker-model, default/per-class Codex-home
selectors and explicit run/resume/control interfaces. Explain intentional first-run policy initialization,
explicit account-default Save and frozen resume accounts. Noninteractive bare/browse prints stderr help
and exits 1. Native helper/platform diagnostics extend this shipped workflow; the TUI is not missing.

1. Replace Linux-only requirements with the exact qualified native and Linux support matrix.
2. Document ordinary native installation, optional toolchains, selected Codex resolution, and helper integrity diagnostics.
3. Show the default epicd TUI flow, explicit run/resume/control commands, and doctor output for common failures.
4. Explain state location, current-format-only recovery, and cross-host refusal without requiring users to understand backend implementation.
5. Document optional feature prerequisites and distinguish implemented native features from preexisting unavailable reset/cleanup.
6. List the actual minimum OS and architecture qualification, including any unsupported Intel/OS combinations.
7. Verify the packed npm artifact and npm link both resolve the correct entrypoint and native helper.
8. Review every child task's acceptance evidence and reconcile the Beads dependency graph with the final implementation.
9. Require MAC-01's positive feasibility result and no unaddressed structural review findings.
10. Require deterministic delivery plus authenticated SDK and native Herdr completion reports at qualified revisions.
11. Do not publish a native support claim if a required test was skipped, a live run timed out, or resources have unaccounted stop.
12. Record remaining unrelated product limitations accurately and close the epic only when every required child is complete.

### Verification and adverse cases

- A fresh native checkout or packed install follows the documented commands successfully.
- A missing helper, unsupported OS, stale state, and missing toolchain each produce the documented actionable outcome.
- Help/version are offline and non-mutating; noninteractive root invocation cannot hang.
- An independent reviewer verifies all task evidence and actual blocking edges.
- Check source and JSONL descriptions agree on final scope, support floor, and backend contract.
- Run package formatting/typechecking and the required CI/release matrix once for the final change set.

### Acceptance criteria

- One native macOS epic can be closed with complete child evidence and a passing installed user workflow.
- The support statement matches measured platforms and actual SDK/Herdr delivery results.
- No Linux VM, unconfined fallback, hidden privilege installation, or legacy-engine restoration is part of the release.

### Evidence and handoff

Retain exact commands, tested revision, host/architecture, native helper identity, and results.
Report skipped or blocked checks explicitly; they do not satisfy this task's acceptance.
Update its Beads description if implementation changes the contract or dependencies.
The final MAC-25 acceptance task consumes this result directly or through its dependents.
