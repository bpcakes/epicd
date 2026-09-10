# Epic discovery and saved-run authority

The browser displays tracker metadata and offers journal-backed run actions. These
are separate contracts. A tracker payload that exceeds the read limit cannot tell
us whether an existing run may resume or accept operator input.

## Root cause

The oversized-read fallback originally returned a fabricated full `Issue` from an
ID, with invented priority/status and a separate `unavailableIds` list. That type
claimed more knowledge than the read supplied. Consumers had to understand the
fallback, parse raw tracker relationships and override actions after projecting
saved state. One such override disabled valid paused-run resumption. Synthetic
priority also changed sorting, while fabricated status and empty parents presented
unknown facts as known. Pinning an off-page owner repeated the same mistake.

Those individual branches were mistakes enabled by a structural problem: discovery
data and run authority shared an oversized contract. Effect error composition did
not cause it, and additional Effect wrappers would not repair that contract.

A later resource review exposed a second boundary assumption: a small CLI response
and a bounded command count do not prove bounded work inside the tracker. The
redundant `--deferred` option selected client-side filtering in `br`, which removed
SQL pagination and hydrated the entire matching corpus before returning 51 rows.
The omission was in validating the dependency's execution behavior, not in the
Effect layer. Discovery now omits that flag and tests actual off-page hydration.

## Ownership and decisions

`src/domain/epic-discovery.ts` defines the discovery result. The tracker adapter
returns verified ID, priority and status, a nullable title, and either available
parent IDs or an explicit `too_large`/`budget_exhausted` result with unknown hierarchy. It translates
raw dependency edges itself. No full `Issue` or sideband failure-ID list crosses
the browser boundary. Full graph reads still require complete tracker records.

`savedRunAction` in `src/epic-browser.ts` accepts only the journal and saved run.
It cannot inspect tracker metadata. The browser invokes it before considering
whether a new start is possible. An owning run absent from a page remains visible
using saved identity; its priority, tracker status and hierarchy stay unknown.

| Journal state                                                      | Complete tracker details    | Incomplete or off-page tracker record                              |
| ------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------ |
| Valid stopped active/paused run                                    | Resume recorded run         | Resume recorded run                                                |
| Live controller or unanswered question, including paused questions | Open operator console       | Open operator console                                              |
| Invalid saved run                                                  | Unavailable; preserve state | Unavailable; preserve state                                        |
| Another epic owns the repository                                   | Block new start             | Block new start                                                    |
| No saved run or owner                                              | Offer new start             | Block new start until details load; no choice for an absent record |

Confirmation rechecks journal identity, ownership and relevant control version.
The shared launch/resume path still owns admission, lease acquisition and recovery.
Offering resume does not promise later tracker operations will succeed: a full
graph read may still hit its existing bound. Discovery cannot bypass those checks.

## Bounded reads and research evidence

The installed `br` implementation was inspected in `beads_rust`'s
`src/format/csv.rs` and list/search command implementations. Both list and search
support `--format csv --fields id,priority,status,issue_type`. A disposable real-CLI
probe verified priority zero and deferred status with both commands. The integration
test also creates an actual 5 MiB epic, changes it to deferred and checks exact
metadata, sorting and search through the confined adapter.

Each page reads the four bounded fields above for 51 entries: 50 choices and one
lookahead identity. List/search never transfer descriptions or inherited context.
The installed `br` (0.5.7) includes deferred records by default when no status filter
is specified. We omit `--deferred` because `list_args_need_client_filters` treats it
as a client filter; both list and search then remove SQL LIMIT/OFFSET before loading
issues. Without it, the current query keeps pagination in SQL. CSV projection only
bounds the wire fields: `br` can still hydrate full records for the selected page,
and SQLite can scan or sort beyond the page. This is not a constant-memory or
constant-time database guarantee. A true metadata-only storage projection would
need support in the tracker itself.

The adapter then requests exact-ID JSON details for the 50 choices. Only an
output-limit failure triggers splitting after the original process settles.
Detail recovery has a page-wide budget of 16 commands, including successful reads,
so a page needs at most 17 tracker commands. A single overflowing epic becomes
`too_large`; remaining batches after the budget are `budget_exhausted`, not claimed
to be individually oversized. Both preserve the verified metadata. A narrower
search gets its own budget, allowing a skipped normal epic to load separately.
The lookahead never requires full details. Those fields are strictly validated and cannot contain
CSV delimiters under their schemas. Invalid headers, priorities, statuses or record
counts fail the load instead of acquiring defaults. Title/hierarchy remain unknown
when they cannot be read. The UI alone supplies explanatory placeholder text.

The existing 4 MiB per-command bound, shared deadline, binding checks and process
stop ownership remain in the Promise adapter. Effect composes lazy read stages and
typed failures at the browser boundary; it does not own another process lifecycle.

Each browser read waits for its Promise to settle before fiber interruption can
complete. The explicit AbortSignal still requests cancellation from the adapter.
The picker session uses one Effect resource lifetime: it returns a typed selection,
navigation or quit event, removes its abort listener, unmounts Ink, and waits for
Ink's exit before another UI opens. The browser's process signal handlers have a
separate enclosing lifetime. Controller launch/resume still awaits the existing
controller's stop and drain path.

Discovery emits an `epic.browser.load` span and child stage spans. Root attributes
contain page offset, search presence and result counts, not the query or payload.
`epicd --trace-discovery` prints only known span names, elapsed milliseconds and
success/failure to stderr. Typed load failures retain their original cause for
programmatic inspection; CLI messages use redacted stage-specific diagnostics.

The installed CLI's list SQL and search sort include creation time and ID tie-breaks
after priority. Real-CLI tests check page membership and search at offset 50 with
55 equal-priority epics. Offset paging remains a live view, not a snapshot across
concurrent tracker mutations.

The same disposable real-CLI test places a lowest-priority record beyond the first
page and gives it a timestamp that SQLite accepts but the CLI's issue decoder
rejects. Both browser list and search must still load the correct first page.
Negative controls with `--deferred` must fail with that exact decoder error,
demonstrating that the canary detects full-corpus hydration. The regression failed
before removing the flag and passed afterward. The separate deferred/P0 test guards
against accidentally hiding deferred epics. This checks materialization behavior
without relying on noisy memory thresholds or a mock that merely echoes flags.

`br search --help` and `SearchArgs` in `beads_rust/src/cli/mod.rs` expose only a
positional query, with no stdin, query-file or environment input option. Search
terms therefore remain visible in process arguments. The picker warns about this
before input, and the README states the limitation. Display redaction remains best
effort; it is not a confidential-search guarantee. Removing process-argument
exposure requires a tracker interface that accepts a private input channel.

## Preventing recurrence

Keep discovery types smaller than execution types and represent unknown facts
explicitly. Add future tracker transport representations inside the adapter; they
should not require the picker or confirmation logic to interpret raw records.
Derive saved-run actions exclusively from persisted state, leases and questions.
Keep warnings about metadata separate from permission to operate a saved run.
Review resource limits separately for response bytes, subprocess counts, row
materialization and database execution. When changing tracker filters, sorting,
format or supported CLI versions, recheck the underlying pagination path and run
the installed-CLI contract tests with `EPICD_TEST_BR_PATH`; mock-only tests cannot
establish these dependency guarantees.

Regression tests compare the same saved-run action across complete, detail-only,
summary-only, budget-exhausted and absent metadata for active, paused, awaiting-question, live and
invalid journals. CLI tests route paused runs from each discovery state through
shared resume without recreating settings, and assert interactive rendering. UI
tests require visible tracker status, unknown metadata, the search privacy notice,
and explicit confirmation. Adapter tests check exact priority/status, malformed
summaries, every page identity, the crowded-page command budget, recovery through
narrow search, real CLI paging and process confinement. Existing stale-confirmation
tests retain their independent journal-version and lease oracles.

Authenticated model execution is outside this boundary's test scope. If full
tracker execution must eventually support arbitrarily large issues, that needs a
separate bounded content/graph contract; silently raising limits or treating these
summaries as complete execution inputs would reintroduce the same defect.
