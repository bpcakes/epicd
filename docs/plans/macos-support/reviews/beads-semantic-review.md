# Post-import Beads semantic polish

Reviewed the saved `br show` records in `/var/tmp/epicd-macos-beads-actual.json`, mapped through `docs/plans/macos-support/beads-map.json`, against the corresponding final packet bodies in `docs/plans/macos-support/tasks.json`. After removing added `(epicd-m7r.N)` references, every reviewed saved description contains its complete planned packet body. This checks actual imported issue content, not just the conversion input. No implementation or native qualification is implied.

## Pass 3 — Native scope and proof boundaries

**PASS; no material findings.** Reviewed MAC-01, MAC-04, MAC-05, MAC-11, MAC-19, and MAC-20 (`epicd-m7r.1`, `.4`, `.5`, `.11`, `.19`, `.20`).

The imported tasks retain native-only execution, the positive feasibility closure gate, complete descendant-domain stop requirements, and explicit rejection of process-group-only or absent-PID proofs. MAC-11 clearly separates typed fixture payload/component custody tests from real supervisor qualification and keeps reconnectable endpoint qualification blocking when unproven. MAC-19 separates native client exit from database backend quiescence. MAC-20 requires qualified endpoint isolation and real native browser/service acceptance; diagnostics, shared networking, and skipped qualification cannot close it. No material plan-to-Beads drift was found.

## Pass 5 — Installation, workflow, runtimes, and release

**PASS; no material findings.** Reviewed MAC-15, MAC-16, MAC-17, MAC-18, MAC-23, MAC-24, and MAC-25 (`epicd-m7r.15`, `.16`, `.17`, `.18`, `.23`, `.24`, `.25`).

The imported tasks retain capability-based diagnosis, packed-install and npm-link helper verification, no-argument interactive epic selection, current-controller resume/control semantics, and noninteractive behavior. Native CI cannot count skipped required tests as support. SDK acceptance requires installed-path whole-epic delivery; Herdr acceptance requires actual Codex TUIs and rejects SDK substitution and fake stop receipts. Final release requires both runtime reports, the positive feasibility result, accounted stop evidence, and completion of required children. No material plan-to-Beads drift was found.
