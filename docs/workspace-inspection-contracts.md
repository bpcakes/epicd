# Workspace inspection contracts

Standalone inspections have three independent responsibilities: establish physical
facts under custody, settle the original worker lifetime, and answer a caller.
The journal already distinguishes retained observations from independent stop
proof. The defects were in the adapters composing those responsibilities, rather
than a need to replace durable inspection with an in-process read.

## Custody precedes content classification

A filesystem error code describes an operation, not a domain fact. `ENOENT` from
resolving managed storage does not mean the inspector read an incomplete copy.
The old catch covered both custody resolution and content reads, so unrelated
failures were converted into the same negative observation.

`owned(..., "reserved")` now returns an explicit absence only for an unmaterialized
reservation under the validated storage root. Missing established directories,
aliases and inaccessible storage are failures. Content inspection runs after
custody checks and classifies only content mismatches. Custody is checked again
before retaining the result, including negative results.

A never-materialized reservation can still be observed absent; that established
case must not be confused with losing a previously registered directory. External
filesystem ownership guards remain a separate unfinished boundary; these checks
do not promise immunity to all concurrent external path substitution.

## Durable settlement is separate from caller cancellation

Moving a read into a supervised worker introduced the same reconciliation pattern
used for writes. That correctly retained physical outcomes, but also swallowed
the caller's cancellation. A retained fact can remain valid while the caller no
longer wants a result.

The inspection adapter first recovers the original stop proof and settles the
record, then checks the caller's signal. It propagates the original cancellation
reason, including when an observation was retained before cancellation. It does
not erase observations or launch a replacement. If stop remains unproven, that
failure takes precedence and the exclusion stays held. Explicit historical
reconciliation has no caller-cancellation contract.

This ordering deliberately uses
[`AbortSignal.throwIfAborted()`](https://nodejs.org/download/release/latest-jod/docs/api/globals.html#abortsignalthrowifaborted),
which throws the signal's reason. Cleanup and observation retention must not be
hidden inside a generic error-to-result conversion. Other durable operations
have their own caller contracts; sharing a runner must not silently import the
semantics of write recovery into reads.

## Preview limits apply to the complete serialization

Ten individually bounded records can still overflow a response when composed
with creation details. JSON escaping further expands control characters. The old
budget loop could shrink only disposal history, leaving the new inspection
history and creation diagnostics outside its control.

The workspace view now measures the complete serialized response. It drops older
disposal and inspection previews with accurate omitted counts, keeping the newest
ID from each history available for recovery. It shortens creation or disposal
diagnostics if necessary and marks the truncation. Stable identity
and outcome fields remain intact. A final budget check refuses oversized core
metadata; no oversized or invalid JSON is returned. Full journal records remain
unchanged and accessible through `inspect_record`.

When adding a section to this view, define how its preview shrinks and test it
together with the existing sections. Per-field string or row limits alone are
not an aggregate response guarantee.

## Recovery decisions

### An attempt outlives its workspace exclusion

Startup must recover orphaned inspections before recovering parent actions. That
ordering cannot determine whether the parent is allowed to start another read.
The journal therefore locates a commitment's latest inspection by its exact
application/tracker target across both pending and settled records. Finishing an
attempt releases custody without forgetting that the attempt happened.

Commit inspection has two caller intents. `recover` is the default: adopt the
original retained attempt, including a failure, or admit the first inspection if
none was ever reserved. `request` comes only from a newly dispatched
`reconcile_action` or `reconcile_tracker_commit` action and may replace a
previously failed attempt. Both intents must settle an existing pending attempt
before doing anything else; that same call cannot replace it if it fails.
Materialization retains its separate freshness contract: each new readiness
request reads current bytes.

The existing action journal supplies request identity and prevents a dispatched
action from running twice. Restarting the controller or recovering a lost
reconciliation acknowledgement does not manufacture another request. This keeps
retry policy at the action boundary and attempt selection inside the inspection
adapter, without adding a second request log or weakening orphan recovery.

An unknown inspection ID is a classified input error at the workspace-manager
boundary. Live dispatch rejects it; crash recovery settles the interrupted
action as failed because no inspection belonging to that run was admitted.
Unknown stop, changed custody, and storage failures remain unresolved. An absent
resource is not uncertain execution.

### Diagnostics follow durable settlement

The runner gathers diagnostics while the worker runs, then attempts to recover
the original stop proof and settle its journal record before appending those
diagnostics. A diagnostic-write failure cannot leave a proven-stopped inspection
holding its exclusion. If both settlement and diagnostic reporting fail, the
settlement failure takes precedence. After successful settlement the caller's
original cancellation still takes precedence, and other diagnostic failures
remain visible to the caller.

### Worker input is one bounded UTF-8 packet

The fixed workers and their supervisors share a byte-bounded JSON reader.
It counts source bytes, collects the complete packet, and decodes UTF-8 once with
fatal error handling before each worker applies its own schema. It does not
change the 64 KiB worker or 1 MiB command-supervisor limits. Socket chunk
boundaries cannot alter paths, and malformed UTF-8 cannot become replacement
characters in an otherwise accepted request.

This follows Node's documented distinction between independently decoding
buffers and preserving
[multibyte characters across chunks](https://nodejs.org/api/string_decoder.html).
[Fatal UTF-8 decoding](https://nodejs.org/download/release/v22.17.0/docs/api/util.html#textdecoderdecodeinput-options)
rejects malformed input. The request/recovery distinction also follows the
principle of using caller intent to distinguish repeated delivery from a new
operation, rather than inferring intent from identical parameters:
[Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

### Remaining contract distinctions

Readiness and inspection settlement remain separate facts. `recordResult` checks
the exact target and atomically retains readiness with its physical observation.
`finish` checks the binding again. Those binding fields are immutable in supported
workspace transitions; out-of-band journal edits are not a supported way to
change a workspace target. Historical readiness is never current publication or
review approval. Raw operational diagnostics remain available separately from
the domain observation; a failed read must not become a negative content fact.

`creation.detailsTruncated` covers two diagnostic fields, whereas a disposal's
`detailTruncated` covers one. The names describe those existing response fields;
they are not a second lifecycle state.

- Revocation may quarantine immediately, even while an inspection owns an
  exclusion. Revocation withdraws authority; it is not evidence that I/O stopped.
  New readiness reads remain unavailable on quarantined copies. Use
  `reconcile_workspace_inspection` for the original receipt before disposal.
  Recovery must not depend on admitting another read or on the old agent still
  being eligible to run.
- A stopped inspection without an observation is a failed attempt. A later
  explicit request may start another; reconciliation does not automatically
  retry or reinterpret newer bytes as the original observation.
- Retained commit observations remain historical. Publication separately reads
  and checks the source through `inspectPublicationWorkspace`; it does not rely
  solely on `sourceIntact` in the journal.
- The 120-second worker deadline is deliberate. A timeout is not negative
  materialization evidence and does not authorize automatic replay.

Regression coverage exercises real filesystem disappearance, preserved missing
reservation semantics, cancellation around launch and settlement, unproven stop,
aggregate JSON expansion, and quarantine followed by explicit recovery and
disposal. These contract tests complement the existing real worker and caller
crash tests; passing the happy path alone cannot establish these boundaries.

Recovery coverage also includes repeated real controller startup after a failed
commit inspection, explicit retry for both commit kinds, missing and foreign-run
IDs interrupted before validation, diagnostic-write failures with proven and
unproven stop, and a real worker deadline. The deadline test shortens the admitted
duration while retaining the real supervisor and stop receipt; it does not mock
a timeout outcome. Packet tests cover every byte split of multibyte text, exact
byte limits and malformed UTF-8, with a supervised Unicode-path integration case.

Recovery tests must distinguish a permitted fresh inspection from a forbidden
copy replay. Assert the launched worker's kind and binding, the retained creation
receipt and the preserved bytes; a blanket assertion that no worker starts
confuses those two contracts.
