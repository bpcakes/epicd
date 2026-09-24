# Second macOS epic audit

Fresh `git fetch origin` again resolved master and origin/master to
`48e1577c84add53e83da81498a81ed877ac01489`. There are no intervening master commits.
This pass checked execution gaps left after the first alignment, rather than treating
that unchanged baseline as sufficient evidence of plan completeness.

## Corrections

| Evidence | Correction in existing tasks |
| --- | --- |
| `fixture-bridge.ts` uses `/bin/bash` with `wait -n -p`. Local `/bin/bash --version` reports 3.2.57, and `help wait` exposes only `wait [n]`. | MAC-19 explicitly replaces this orchestration dependency through qualified native child-completion handling, preserving early broker failure and stop evidence. No implicit Homebrew Bash requirement. |
| `repository-policy.ts` freezes service `port` and fixture `listenPort`; `delivery.ts`/`delivery-journal.ts` bind definition hashes and binary identities but lack the proposed runtime endpoint lease. | MAC-02 owns the requested-versus-resolved endpoint schema and explicit allocation authorization; MAC-19/20 implement it without rewriting frozen policy/digests. Native profiles, URLs, readiness, recovery and evidence must consume one exact binding. |
| `sandbox.ts`, `fixtures.ts`, `fixture-creation.ts` and `fixture-bridge.ts` depend on Linux mount aliases, private `/tmp` and synthetic `/etc/passwd`. | MAC-05/19 now specify actual admitted native paths, cwd/HOME/TMPDIR and tool/socket mapping. No host-root alias creation or assumption that a sandbox profile virtualizes paths or users. |
| `validation-services.ts` uses `pg_ctl --timeout=20`; the bridge has up to 50 bounded probes; Playwright webServer uses 10 seconds. | MAC-20 no longer calls 10 seconds a general fixture deadline. Allocation and startup have distinct bounded stages within the enclosing check deadline; retries cannot reset it. |
| Current PostgreSQL/PgBouncer trust authentication relies on private Linux namespaces. | MAC-20 explicitly requires native endpoint/authentication qualification before readiness; moving trust-auth listeners onto host loopback is insufficient. |
| `command-lifetime.ts`, `pid-namespace.ts`, `worker-request.ts` and reviewer launch use different private descriptor roles. | MAC-03 distinguishes bounded supervisor request, cancellation, trusted-worker socket request, interactive stdin and immutable review bytes. MAC-06/08 own real integration cases and prevent authority leakage. Existing 1 MiB/64 KiB request bounds and strict UTF-8 decoding remain. |
| `repository-io.ts` uses a Node `setTimeout(120_000)` and omits namespace `timeoutMs`. | MAC-06 explicitly transfers this operation's budget into native admission, including startup delay, rather than preserving a JS-only timer. Acceptance suspends the JS loop to test independent expiry. |

Shared schema/helper file ownership is explicit so tracker readiness is not mistaken
for permission to edit the same interfaces concurrently. No artificial ordering edges
were added for shared-file coordination.

An independent focused source audit checked helper/filesystem/disposal/packaging surfaces
and supplied the descriptor/deadline findings. Existing APFS, descriptor-relative I/O,
disposal and packaging coverage did not need another task or architectural rewrite.

## Verification and limits

The existing epic and 25 child IDs remain. Prerequisites remain 103 blocking edges and
25 parent edges, with MAC-01/MAC-02 ready and every child reaching MAC-25.
`beads-audit.json` records actual plan/packet/tracker/export/graph comparisons and preservation
checks. The first master-alignment audit is retained in
`master-alignment-audit-2026-09-24.json` beside this report.

Only the plan and its tracker copies were changed. Local shell capability inspection ran;
no product tests, native helper experiments, live model delivery or native feasibility proof
were run. MAC-01 remains the positive containment gate; the revised task acceptance describes
future implementation obligations, not checks that passed in this audit.
