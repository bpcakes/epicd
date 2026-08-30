# epicd

`epicd` delivers a fully specified Beads epic through durable Codex agents. The user chooses either direct SDK threads or visible Herdr-managed sessions. One persistent orchestrator understands the epic graph, each concrete Bead gets its own implementation session, every candidate receives a fresh comprehensive review before commit, and a fresh verifier checks the exact commit afterward.

The terminal UI is the primary interface. It shows the selected runtime, current task, lifecycle stage, implementation and review session IDs, verified revision, progress across the epic, and a recoverable activity stream.

## What epicd guarantees

- Beads remains authoritative. `bv` supplies graph-aware advice; `br ready --json` supplies the claimable set.
- Every claim reruns `br ready` immediately, then `br show`, and rejects epic containers before calling `br update`.
- Implementation agents cannot claim, close, sync, stage, commit, amend, or push.
- Review happens in a separate Codex session. Reviewers are checked for working-tree mutations.
- Findings go back to the original implementation session, then the same independent reviewer verifies those fixes without restarting an open-ended review.
- The controller commits the reviewed tree, then a fresh verifier cites the exact commit SHA and checks its acceptance evidence.
- A Bead closes only after exact-revision verification. Tracker exports are committed separately so the next task starts clean.
- Nested epic containers close only after their descendants close. The root epic receives a final comprehensive review.
- Thread IDs and lifecycle state survive process failure in a transactional SQLite store.
- `epicd` never pushes.

## Requirements

- Node.js 22.12 or newer
- An authenticated Codex session (the SDK bundles its runtime; Herdr mode requires the system `codex` CLI)
- Herdr with its Codex integration installed when using `--runtime herdr`
- `br` (`beads_rust`) and `bv` (`beads_viewer`) on `PATH`
- A clean Git repository containing `.beads`
- Git author name and email configured for automatic commits

Run the prerequisite check before the first epic:

```bash
epicd doctor -C /path/to/repository
```

For Herdr mode, run the check from a Herdr pane:

```bash
epicd doctor --runtime herdr -C /path/to/repository
```

## Install from this checkout

```bash
cd ~/Documents/epicd
npm install
npm run build
npm link
```

`npm link` is optional. Without it, replace `epicd` below with `node ~/Documents/epicd/dist/cli.js`.

## Start an epic

Open the epic picker in the current repository:

```bash
epicd
```

Open the picker for another repository:

```bash
epicd -C /path/to/repository
```

Start a known epic directly:

```bash
epicd run my-project-epic-id -C /path/to/repository
```

Choose the execution mode when creating the run. SDK is the default and runs agents in-process; Herdr opens each agent in a visible, unfocused tab in the current Herdr workspace:

```bash
epicd run my-project-epic-id --runtime sdk -C /path/to/repository
epicd run my-project-epic-id --runtime herdr -C /path/to/repository
```

The runtime is persisted with the run. Omit `--runtime` when resuming to keep the saved choice, or explicitly select the other runtime to perform a cold handoff:

```bash
epicd resume my-project-epic-id --runtime herdr -C /path/to/repository
epicd resume my-project-epic-id --runtime sdk -C /path/to/repository
```

A cold handoff preserves the Bead, lifecycle phase, findings, repair budget, Git revisions, and per-role model settings. Runtime-specific agent sessions are discarded, so the destination runtime starts fresh agents with the persisted workflow context. The switch is written only after epicd acquires the run lease.

## Models and reasoning by role

`--model` and `--reasoning` provide all-role fallbacks. Each role can override either value independently:

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

Available reasoning values are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. Model support varies; Codex reports an error if the selected model does not accept an effort level.

Without flags, every role inherits the model from the local Codex configuration. The orchestrator and implementation roles default to `high`; review defaults to `xhigh`. Role settings are persisted and cannot change during resume because SDK threads and live Herdr agents must retain a stable execution contract.

Each comprehensive review cycle allows three implementation fix passes by default. Set a different positive integer when starting a run:

```bash
epicd run my-project-epic-id --max-review-passes 6 -C /path/to/repository
```

The repair budget is persisted with the run and cannot change during resume. Targeted fix verification uses the same reviewer session; approval resets the budget before exact-revision verification.

For logs suitable for a supervisor or CI console:

```bash
epicd run my-project-epic-id -C /path/to/repository --no-tui
```

Inspect or resume persisted work:

```bash
epicd status -C /path/to/repository
epicd status my-project-epic-id -C /path/to/repository --json
epicd resume my-project-epic-id -C /path/to/repository
```

## TUI controls

| Key                  | Action                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| `↑` / `↓`, `j` / `k` | Navigate the epic picker                                                |
| `/`, then type       | Filter epics by title or ID; `Esc` returns to navigation                |
| `Enter`              | Start or resume the selected epic                                       |
| `a`                  | Toggle root-only and all nested epics in the picker                     |
| `p`                  | Request a safe pause after the active operation                         |
| `r`                  | Resume a paused or blocked run after resolving its cause                |
| `v`                  | Toggle command and event details                                        |
| `?`                  | Toggle keyboard help                                                    |
| `q`                  | Pause safely, then quit                                                 |
| `Ctrl-C`             | Interrupt the current agent turn and preserve a recoverable blocked run |

The TUI adapts to narrow terminals by stacking the current-work and activity panels. It also respects standard terminal color capabilities and `NO_COLOR` behavior through Ink.

## Execution lifecycle

For every implementation task, epicd performs:

1. Refresh the full epic graph using `bv --robot-triage`, `--robot-plan`, and `--robot-graph`.
2. Ask the persistent orchestrator session to choose from concrete descendants returned by `br ready`.
3. Rerun the authoritative ready/show claim gate and claim the selected task.
4. Start a top-level implementation session with the exact Bead and epic context.
5. Start a fresh comprehensive review session over the uncommitted candidate.
6. Resume the implementation session with every finding, then resume the same reviewer to verify those fixes and repair-caused regressions. After a runtime handoff, start fresh agents for these roles instead.
7. Commit application changes without staging `.beads`.
8. Start a fresh verifier session to confirm the exact candidate SHA and its acceptance evidence without repeating the comprehensive review.
9. Close and sync the Bead, then commit tracker-only changes.
10. Refresh the graph and select the next ready task.

When all concrete descendants are closed, epicd verifies the entire epic at the current exact revision before closing the root container.

## Recovery state

By default, epicd stores minimal runtime state at:

```text
$XDG_STATE_HOME/epicd/epicd.sqlite3
```

When `XDG_STATE_HOME` is unset, it uses `~/.local/state/epicd/epicd.sqlite3`. The database contains lifecycle state, the selected runtime, repair budget, opaque SDK/Herdr session IDs, exact revisions, and the activity events displayed by the TUI. It does not duplicate the Beads dependency graph. Runs created before repair-budget persistence retain the historical default of five passes.

Herdr agents use an atomic structured-result file under `$XDG_STATE_HOME/epicd/herdr/<run-id>` (or the corresponding `~/.local/state` path). This avoids treating terminal screen text as an API. Result files are deleted after each turn; the dedicated agent tabs remain available for inspection and recovery.

The state directory is created with owner-only access and SQLite files are forced to mode `0600`. Command output is not persisted; command lines are retained for the activity view with common credential assignments and bearer values redacted.

Only one unfinished epicd run may own a repository. A blocked run must be resumed rather than silently replaced.

## Safety and current operating model

Version 0.1 runs one implementation task at a time in the selected repository. Sequential execution avoids shared-worktree merge races while the review and recovery contracts settle. Parallel tasks should eventually use one Git worktree per Bead; they should not share a mutable checkout.

Automatic commits are part of the requested lifecycle. Starting a run therefore requires a clean working tree and is an explicit request for epicd to create local commits. Pushing remains a separate human action.

If a reviewer modifies tracked files, a structured response is invalid, a command fails, a task has no concrete changes, a verifier cites the wrong revision, or the repair budget is exhausted, epicd enters `blocked`. The TUI preserves the exact phase and evidence so the operator can correct the cause and press `r`.

## Development

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
```

The integration tests use isolated fake `br`, `bv`, Codex, and Herdr executables to exercise the complete controller state machine without touching a real repository. Live prerequisite behavior is covered separately with `epicd doctor`; a real epic run is intentionally never used as an automated test fixture because it mutates tracker and Git state.
