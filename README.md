# epicd

`epicd` runs a Beads epic one dependency-safe task at a time. It claims a task and hands it to a Codex implementation agent. A second session reviews the diff. If review passes, epicd commits the work and gives the exact commit SHA to a fresh verifier. The task closes after verification.

Review findings return to the original implementation session, and the same reviewer checks the repairs. SQLite records the current phase, task, findings, session IDs, repair budget, and Git revisions, so a run can resume after epicd, its terminal, or an agent process stops. If Beads contains dependency-safe `in_progress` work with no owner, epicd can adopt it atomically; assigned work remains with its owner.

Direct Codex SDK threads are the default. Herdr mode opens the agents in separate tabs for inspection and terminal recovery. Both modes use the same saved workflow, and a paused run can switch between them with a cold handoff. Epicd creates local commits but never pushes them.

## Quick start

You need Node.js 22.12 or newer, an authenticated Codex session, `br` (`beads_rust`), `bv` (`beads_viewer`), Git author details, and a clean Git repository containing `.beads`.

Build and link this checkout:

```bash
cd ~/Documents/epicd
npm install
npm run build
npm link
```

If npm reports pending install scripts, review and approve `better-sqlite3` and `esbuild`, then rerun the install:

```bash
npm approve-scripts better-sqlite3 esbuild
npm install
```

Check the target repository before the first run:

```bash
epicd doctor -C /path/to/repository
```

Start the interactive epic picker:

```bash
epicd -C /path/to/repository
```

Or start a known epic directly:

```bash
epicd run my-project-epic-id -C /path/to/repository
```

Without `npm link`, replace `epicd` with `node ~/Documents/epicd/dist/cli.js`.

## Two runtime modes

Both runtimes use the same controller and saved state. SDK is the simpler option. Herdr adds visible, recoverable terminal sessions.

|          | SDK                                | Herdr                                                    |
| -------- | ---------------------------------- | -------------------------------------------------------- |
| Flag     | `--runtime sdk`                    | `--runtime herdr`                                        |
| Sessions | SDK-managed Codex threads          | Codex agents in separate, unfocused Herdr tabs           |
| Requires | An authenticated Codex SDK runtime | Herdr, its Codex integration, and the system `codex` CLI |

SDK is the default. Herdr commands must run from a Herdr-managed pane:

```bash
epicd doctor --runtime herdr -C /path/to/repository
epicd run my-project-epic-id --runtime herdr -C /path/to/repository
```

The runtime is part of the saved run. Omit `--runtime` on resume to keep it, or request a cold handoff:

```bash
epicd resume my-project-epic-id --runtime herdr -C /path/to/repository
epicd resume my-project-epic-id --runtime sdk -C /path/to/repository
```

A cold handoff keeps the task, lifecycle phase, findings, repair budget, Git revisions, and role settings. It discards runtime-specific sessions and starts replacement agents with the saved workflow context after acquiring the run lease.

The epic picker checks repository and Beads prerequisites before opening, then checks the selected run's saved runtime after selection. An explicit `--runtime` remains a cold-handoff request. This prevents an SDK installation problem from hiding an otherwise recoverable Herdr run, and vice versa.

## The delivery contract

For each concrete task, epicd performs this sequence:

1. Refresh the epic, descendants, ready set, blocked set, and `bv` graph advice.
2. Add dependency-safe recovery candidates already owned by the run or marked `in_progress` without an owner.
3. Ask the persistent coordinator to select one concrete task. Its contract forbids file and Beads mutations, and epicd rejects the selection if the working tree changes.
4. Recheck the selected issue and acquire it with Beads' atomic `--claim`. Unowned recovery uses the same atomic ownership gate; dependency or ownership races fail closed.
5. Open an implementation session with the exact task, acceptance criteria, epic context, and repository instructions. Epicd keeps Beads and Git history mutations out of the implementation contract.
6. Review the uncommitted application diff in a separate session.
7. Return every finding to the implementation session, then ask the same reviewer to verify the repairs and any repair-caused regressions.
8. Commit the approved application tree without staging `.beads`.
9. Give a fresh verifier the exact commit SHA, required checks, and acceptance evidence.
10. Close and sync the task, commit tracker-only changes, refresh the graph, and select again.

After all concrete descendants close, a fresh final review checks the whole epic at the current revision before epicd closes the root container.

The controller enforces these boundaries:

- Beads remains authoritative for task status and dependencies.
- Implementation prompts forbid claim, close, sync, stage, commit, amend, reset, checkout, and push operations.
- Review prompts are read-only. Sandboxed reviewers lack write access, and epicd detects working-tree mutations in every permission mode.
- A task closes only after exact-revision verification.
- Nested epic containers close only after their descendants.
- Tracker changes receive their own commits, keeping the next application baseline clean.
- Only one unfinished epicd run may own a repository.
- Epicd never pushes.

## Models and reasoning by role

`--model` and `--reasoning` set fallbacks for all roles. Each role can override either value:

```bash
epicd run my-project-epic-id \
  --runtime herdr \
  --model gpt-5.6-sol \
  --orchestrator-reasoning high \
  --implementation-model gpt-5.6-terra \
  --implementation-reasoning high \
  --review-model gpt-5.6-sol \
  --review-reasoning xhigh \
  -C /path/to/repository
```

Without model flags, Epicd resolves the effective Codex SDK model when it opens a new SDK thread, then persists and replays that concrete model and reasoning effort on every resume. Each model-less thread performs fresh, short-lived discovery so changes to local Codex configuration apply to new threads without changing existing ones. New Herdr agents delegate model selection to their Herdr-managed Codex process, which remains alive for later turns. Coordinator and implementation reasoning default to `high`; review defaults to `xhigh`. Available values are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. Model support varies, so Codex rejects unsupported combinations.

SDK agent turns let `@openai/codex-sdk` select its own exactly pinned runtime. Model discovery launches that pinned package's public Codex CLI entry point, so Epicd does not duplicate the SDK's private platform-package or vendor-layout rules. Each launcher remains responsible for its own internal environment setup; Epicd pins the package version and effective model contract rather than promising byte-identical process environments. Dependency updates are proposed weekly and remain explicit, testable changes rather than silently replacing the runtime underneath a saved run. Normal SDK run and resume preflight executes the selected runtime's version command; `epicd doctor` additionally probes live model discovery. If a new SDK session needs model discovery and Epicd cannot resolve a concrete effective model after retrying, the run blocks before opening that thread and asks for an explicit model or a Codex configuration repair. It does not silently create an unpinned thread whose execution contract could change on resume. For local SDK development or recovery from a damaged package installation, `--codex-path <path>` selects a specific Codex executable for both discovery and agent turns. The override applies only to `--runtime sdk`; Herdr owns its Codex process.

Role settings persist for the run. Run-wide model and reasoning values remain fallbacks; explicit per-role values remain overrides when the fallback changes. While the run TUI is open, press `c` to edit the model and reasoning effort for each role. Saving changes updates the preferences for future threads immediately; an existing implementation or review thread remains pinned to the settings it started with. Because the coordinator normally spans the whole run, a changed coordinator is retired at the next task-selection boundary and its replacement starts with the new settings. This avoids silently changing a thread's execution contract halfway through its work. Use `x` to return a role to the run-wide model, and `r` to return its reasoning effort to the run-wide or built-in role default. SDK defaults are resolved at thread creation so later local configuration changes cannot alter an existing thread; Herdr agents inherit the configuration of their long-lived Herdr-managed Codex process. If settings change while a new session contract is being prepared, Epicd makes at most three preparation attempts. The final prepared contract is then pinned as the new session's creation boundary; a later save applies to the following session instead of keeping the current open operation alive indefinitely.

Model and reasoning flags supplied to `resume`, or to `epicd <epic-id>` when it finds recoverable work, change defaults for future threads. `--model` changes only the run-wide fallback and preserves explicit per-role model overrides; a role-specific model flag changes that role. Use `--model-inherit` to return model selection to the provider and `--reasoning-inherit` to return reasoning to Epicd's built-in role defaults. In the live editor, `x` explicitly resets a role to the run-wide fallback. Active implementation and review threads keep their pinned settings, while a changed coordinator rotates at the next selection boundary. This gives headless resumes the same behavior as the live editor. Each review gets three implementation fix passes by default. Set another positive limit when creating the run:

Headless resumes can also clear role overrides. Use `--review-model-inherit` or `--review-reasoning-inherit`, with equivalent `--orchestrator-*` and `--implementation-*` flags. Each reset flag conflicts with the corresponding concrete override flag.

```bash
epicd run my-project-epic-id --max-review-passes 6 -C /path/to/repository
```

The limit also persists. Approval resets it before exact-revision verification.

## Permissions

Agents run sandboxed by default. If required validation needs host services such as the Docker socket, you can explicitly disable Codex approvals and sandboxing:

```bash
epicd run my-project-epic-id \
  --runtime herdr \
  --dangerously-bypass-approvals-and-sandbox \
  -C /path/to/repository
```

This grants every coordinator, implementation, and review agent unrestricted host and network access. Docker socket access is effectively root-equivalent. Use it only with repositories and instructions you trust.

The TUI displays `FULL HOST ACCESS` prominently when that policy is active. Adding the flag while resuming a paused or blocked sandboxed run performs a cold permission handoff: epicd retires the old sessions, preserves workflow and Git state, and starts replacement agents with full access.

```bash
epicd resume my-project-epic-id \
  --dangerously-bypass-approvals-and-sandbox \
  -C /path/to/repository
```

## Operate a run

Stream events instead of opening the TUI:

```bash
epicd run my-project-epic-id --no-tui -C /path/to/repository
```

Inspect or resume saved work:

```bash
epicd status -C /path/to/repository
epicd status my-project-epic-id --json -C /path/to/repository
epicd resume my-project-epic-id -C /path/to/repository
# Only when runtime cleanup is permanently impossible:
epicd cleanup RUN_ID --abandon
# Only when status reports invalid persisted state:
epicd quarantine RUN_ID --force
```

`status --json` emits schema version 1. Its existing `agentSettings` field continues to contain concrete effective settings; the additive `agentPreferences` field shows which values inherit run-wide defaults. Legacy `orchestratorThreadId`, `implementationThreadId`, and `reviewThreadId` aliases remain available alongside the role-keyed `agentSessions` object. When a controller owns a run, `controllerLease` reports its PID, opaque lease ID, acquisition time, and whether that exact process identity is still alive.

Human-readable status includes the run and controller lease identities required by `epicd unlock`. If one persisted row is corrupt or was written by an incompatible newer version, human status displays that row as invalid while continuing to show other runs. Corrupt rows may be quarantined after inspection; rows carrying a newer state-schema version are never eligible for quarantine and require an Epicd upgrade. JSON status preserves its `RunStatusV1[]` contract by omitting invalid rows, writing a warning to stderr, and returning a nonzero exit status. Human status remains successful after reporting invalid rows so it can still serve as an inspection command.

An invalid row fails closed because epicd cannot safely infer its workflow or external-agent cleanup obligations. After inspecting the reported run and stopping any live controller, `epicd quarantine <run-id> --force` atomically moves its raw state and activity events into forensic tables in the same local database, then releases its epic and repository ownership. Quarantine does not interpret or repair malformed state and cannot clean up external agent resources, which may remain open.

State migration is forward-only. Persisted run state carries its own schema version; this build migrates unversioned legacy rows to version 1 and rejects rows from a newer version instead of stripping unknown fields and overwriting them. Development builds that created SDK sessions without a concrete persisted model contract will retire those sessions once during upgrade and start fresh role sessions on the next turn. Runs written before reasoning inheritance was recorded retain their concrete per-role efforts as explicit overrides; use `r` in the configuration editor to make a role inherit again. Epicd records session rotation in the activity log. The legacy thread-ID aliases are a status compatibility surface, not a promise that older Epicd binaries can safely resume newer state.

A completed SDK run with pending cleanup can be resumed even if its bundled Codex executable is unavailable. SDK session cleanup is local bookkeeping and must not leave otherwise completed work permanently stuck. Herdr cleanup requires its executable and running server, but not a Herdr-managed pane or Codex integration; use `epicd cleanup <run-id> --abandon` if those resources are permanently unavailable. Cleanup-only resumes reject model, reasoning, runtime, permission, and review-budget overrides because they cannot affect an already completed workflow or create a new thread. Cleanup is scoped to the completed run's agent namespace and does not touch Git or Beads, so it may run concurrently with a different epic's active workflow in the same repository. A delivered epic remains in the non-owning `complete` phase when cleanup needs attention, recording the cleanup diagnostic without competing for repository workflow ownership. It exits successfully when external cleanup remains pending; persistence or lease-authority failures still stop the controller rather than being mislabeled as external cleanup failures.

### TUI controls

| Key                  | Action                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| `↑` / `↓`, `j` / `k` | Navigate the epic picker                                                |
| `/`, then type       | Filter by title or ID; `Esc` returns to navigation                      |
| `Enter`              | Start or resume the selected epic                                       |
| `a`                  | Toggle root-only and nested epics                                       |
| `p`                  | Request a safe pause after the active operation                         |
| `r`                  | Retry a paused or blocked run after correcting its cause                |
| `c`                  | Configure models and reasoning for threads created after the change     |
| `v`                  | Toggle command and event details                                        |
| `?`                  | Toggle keyboard help                                                    |
| `q`                  | Pause safely, then quit                                                 |
| `Ctrl-C`             | Interrupt the current agent turn and preserve a recoverable blocked run |

The TUI stacks its panels on narrow terminals and respects terminal color capabilities and `NO_COLOR`.

## Recovery and stored state

Epicd stores runtime state in:

```text
$XDG_STATE_HOME/epicd/epicd.sqlite3
```

When `XDG_STATE_HOME` is unset, the path is `~/.local/state/epicd/epicd.sqlite3`. SQLite stores the lifecycle phase, runtime, permission policy, future role defaults, settings pinned to active sessions, repair budget, opaque agent session IDs, exact revisions, pending cleanup, and TUI events. Beads remains the source of truth for the dependency graph.

The state database must be local to one OS instance and PID namespace. Epicd uses SQLite WAL and process identities for coordination; network filesystems, cross-host sharing, and sharing one database across containers or PID namespaces are unsupported.

The state directory is owner-only, and epicd forces SQLite files to mode `0600`. It does not persist command output. Activity events retain redacted command lines, removing common credential assignments and bearer values.

Herdr agents exchange structured results through an atomic file under `$XDG_STATE_HOME/epicd/herdr/<run-id>`. Epicd deletes each result after reading it instead of parsing terminal screen text as an API.

Herdr tabs remain open while epicd may need them for repair or recovery. Task agents retire after closure; run agents retire after epic completion or a runtime handoff. Agent names carry a run-specific namespace, so cleanup cannot target unrelated agents. Before closing tabs, epicd saves its cleanup intent and retries interrupted cleanup on resume. Cleanup can use the running Herdr server even when epicd is launched outside a Herdr-managed pane. A close failure produces a warning without invalidating verified work. Pending cleanup prevents replacing the same epic run, keeping that cleanup reachable by epic ID, but does not retain ownership of the repository's Git workflow after the run is complete. If cleanup can never succeed because Herdr was removed or its resources were closed manually, explicitly discard the intent with `epicd cleanup <run-id> --abandon`; this may leave external tabs open. The same command clears a residual completed-cleanup diagnostic when no resource action remains.

Epicd leases each run to one controller. State changes and activity events require that controller's lease while it is held. Administrative writes are allowed only without a live lease; stale-lease reclamation and the write happen atomically. Model and reasoning setting changes commit together with their activity event. A completed run with only a saved diagnostic is labeled as needing attention, separately from pending resource cleanup. On Linux, a lease records both the PID and the kernel process start identity, so a recycled PID does not leave the run permanently locked. Inspect the current values with `epicd status`. After stopping the reported controller, use the exact run ID, PID, and lease ID to release only that lease:

```bash
epicd unlock <run-id> --owner-pid <reported-pid> --lease-id <reported-lease-id> --force
```

Unlocking does not stop the reported process. Using it while that controller is still running can permit two controllers to mutate the same run, so inspect the process first. The opaque lease identity and expected PID form a compare-and-swap guard: the command fails if the controller released and reacquired the run, or if ownership otherwise changed after inspection.

On macOS and Windows, epicd can check whether the recorded PID exists but cannot verify the Linux kernel process-start identity. Linux has the same fail-closed limitation when `/proc/<pid>/stat` is unreadable, such as with restrictive `hidepid` settings or a cross-user PID. A boot-ID mismatch can still prove that the lease is stale, but same-boot PID reuse in those restricted environments requires the explicit `epicd unlock` procedure. Epicd does not expire leases by elapsed time because doing so could evict a slow but live controller.

Dependency updates, including the exactly pinned Codex SDK, arrive as pull requests and run the `validate` CI job with a frozen `npm ci` install, formatting, typechecking, the full test suite, and a production build. Platform-specific process contracts also run on macOS and Windows behind the stable `platform-contracts` aggregate check. Configure both `validate` and `platform-contracts` as required status checks on the default branch so a dependency bot cannot bypass either compatibility gate.

## Current limits

Version 0.1 runs one implementation task at a time in the selected checkout. This avoids shared-worktree merge races. Future parallel delivery will require one Git worktree per task.

Starting a run requires a clean working tree and authorizes epicd to create local commits. Pushing remains a separate human action.

Epicd enters `blocked` when it cannot preserve the delivery contract, including failed commands, invalid structured responses, reviewer mutations, missing concrete changes, ownership conflicts, incorrect verifier revisions, or an exhausted repair budget. It keeps the exact phase and evidence so the operator can correct the cause and retry.

## Development

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
```

Integration tests use isolated fake `br`, `bv`, Codex, and Herdr executables to exercise the controller without touching a real repository. `epicd doctor` covers live prerequisites. Automated tests never launch a real epic because a run mutates tracker and Git state.

On POSIX systems, model discovery and SDK runtime version checks use a short-lived supervisor that owns the subprocess group until shutdown finishes. It terminates its own group, including surviving launcher descendants, and also cleans up if the calling epicd process exits. Shutdown includes a 500 ms grace period before forced termination. The caller waits at most one second for cleanup; if the supervisor is delayed, the caller disconnects and leaves that supervisor alive to finish cleanup when scheduled. A suspended supervisor is resumed at that deadline. Windows uses `taskkill` for process-tree cleanup.

Model discovery allows two attempts of up to 10 seconds each, plus bounded shutdown waits. This accommodates a slow local runtime while keeping failures bounded; cancellation stops the retry sequence. An explicit model or a cached effective model avoids discovery. Version checks have a separate 10-second timeout.

To exercise authenticated model discovery against the SDK-pinned Codex app-server, opt into the credential-dependent live check:

```bash
EPICD_LIVE_CODEX=1 npm run test:live-codex
```

## License

MIT
