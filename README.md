# epicd

Turn a Beads epic into reviewed, verified local commits.

A coding agent can finish one task. Delivering an epic also requires dependency ordering, claim ownership, independent review, exact-revision verification, and recovery when a process or terminal dies. `epicd` owns that control loop. It selects claimable work from the Beads graph, gives each task to an implementation agent, reviews the resulting diff in a separate session, commits approved work, verifies the exact commit, closes the task, and repeats.

Choose direct Codex SDK threads for a compact setup or visible Herdr sessions when you want to inspect every agent. The same persisted workflow can move between the two runtimes. `epicd` creates local commits but never pushes them.

## Why use epicd?

| Delivery risk                          | What epicd does                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An agent picks the wrong task          | Beads supplies the dependency-safe set; a persistent coordinator selects only from controller-vetted candidates.                                             |
| Implementation grades its own work     | A separate reviewer checks the complete diff, and a fresh verifier checks the exact commit afterward.                                                        |
| Fixes escape the original review       | Findings return to the implementation session, then the same reviewer verifies each repair before approval.                                                  |
| A crash loses the thread               | SQLite stores the phase, task, findings, session IDs, repair budget, and Git revisions needed to resume.                                                     |
| A stale tracker claim blocks the graph | Epicd can atomically adopt dependency-safe `in_progress` work that has no owner. It never steals assigned work.                                              |
| Autonomous work becomes a black box    | The TUI shows the active role, task, lifecycle stage, revision, progress, permissions, and event history. Herdr mode also exposes each agent in its own tab. |

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

|                   | SDK                                              | Herdr                                                              |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| Command           | `--runtime sdk`                                  | `--runtime herdr`                                                  |
| Agent surface     | SDK-managed Codex threads                        | Visible Codex agents in unfocused Herdr tabs                       |
| Extra requirement | None beyond the authenticated SDK runtime        | Herdr with its Codex integration and the system `codex` CLI        |
| Best fit          | Minimal local setup and line-oriented automation | Interactive supervision, inspectable agents, and terminal recovery |

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

## The delivery contract

For each concrete task, epicd performs this sequence:

1. Refresh the epic, descendants, ready set, blocked set, and `bv` graph advice.
2. Add dependency-safe recovery candidates already owned by the run or marked `in_progress` without an owner.
3. Ask the persistent coordinator to select one concrete task. Its contract forbids file and Beads mutations, and epicd rejects the selection if the working tree changes.
4. Recheck the selected issue and acquire it with Beads' atomic `--claim`. Unowned recovery uses the same atomic ownership gate; dependency or ownership races fail closed.
5. Start an implementation session with the exact task, acceptance criteria, epic context, and repository instructions. Epicd keeps Beads and Git history mutations out of the implementation contract.
6. Start a separate comprehensive review over the uncommitted application diff.
7. Return every finding to the implementation session, then ask the same reviewer to verify the repairs and any repair-caused regressions.
8. Commit the approved application tree without staging `.beads`.
9. Start a fresh verifier to confirm the exact commit SHA, required checks, and acceptance evidence.
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

Without flags, each role uses the model from the local Codex configuration. Coordinator and implementation reasoning default to `high`; review defaults to `xhigh`. Available values are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. Model support varies, so Codex rejects unsupported combinations.

Role settings persist for the run and cannot change on resume. Each comprehensive review gets three implementation fix passes by default. Set another positive limit when creating the run:

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

Epicd saves the permission policy and displays full access prominently in the TUI. Adding the flag while resuming a paused or blocked sandboxed run performs a cold permission handoff. Epicd retires the old sessions, preserves workflow and Git state, and starts replacement agents with full access.

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
```

### TUI controls

| Key                  | Action                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| `↑` / `↓`, `j` / `k` | Navigate the epic picker                                                |
| `/`, then type       | Filter by title or ID; `Esc` returns to navigation                      |
| `Enter`              | Start or resume the selected epic                                       |
| `a`                  | Toggle root-only and nested epics                                       |
| `p`                  | Request a safe pause after the active operation                         |
| `r`                  | Retry a paused or blocked run after correcting its cause                |
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

When `XDG_STATE_HOME` is unset, the path is `~/.local/state/epicd/epicd.sqlite3`. SQLite stores the lifecycle phase, runtime, permission policy, role settings, repair budget, opaque agent session IDs, exact revisions, pending cleanup, and TUI events. Beads remains the source of truth for the dependency graph.

The state directory is owner-only, and epicd forces SQLite files to mode `0600`. It does not persist command output. Activity events retain redacted command lines, removing common credential assignments and bearer values.

Herdr agents exchange structured results through an atomic file under `$XDG_STATE_HOME/epicd/herdr/<run-id>`. Epicd deletes each result after reading it instead of parsing terminal screen text as an API.

Herdr tabs remain open while epicd may need them for repair or recovery. Epicd retires task agents after closure and run agents after epic completion or a runtime handoff. Agent names carry a run-specific namespace, so cleanup cannot target unrelated agents. Epicd saves cleanup intent before closing tabs and retries interrupted cleanup on resume. A close failure produces a warning without invalidating verified work.

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

## License

MIT
