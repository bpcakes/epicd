# Coordinator bootstrap recovery

Before an orchestrator conversation can start, epicd needs an immutable copy of the run's committed baseline. A failed copy must not permanently strand that coordinator slot, and a restart must not turn an uncertain copy into permission to try again.

The controller uses the repository policy's `budgets.identicalFailures` limit for copy attempts for each coordinator slot and frozen agent contract. The default is three, and the existing policy permits one through three. Stable operation identities retain those attempts across restart; reopening the state file does not refill the limit. A different coordinator slot or an explicitly changed contract is a distinct bootstrap context, not a reset of the same recorded attempt.

A fresh attempt is allowed only after the workspace adapter has settled the original creation as failed using its independent worker-stop proof or never-bound execution fence. It gets a new workspace identity and directory. The failed copy and its journal records remain intact. Repository ownership and active controller authority are checked before each attempt. This is bounded bootstrap maintenance before model reasoning is available, not a task-selection or delivery-recovery strategy.

These cases do not authorize another copy:

- The original worker's stop remains unknown.
- No creation intent was admitted, or the recorded source differs from the frozen bootstrap source.
- The run is paused or cancelled, or repository ownership changed.
- The old workspace still has unsettled custody.
- Creation succeeded but the recovered copy is incomplete or changed.

An intact copy with a lost acknowledgement is recovered under its original identity after inspection. Historical creation or inspection evidence does not grant review approval. No failed or changed directory is restored, discarded, or overwritten by this recovery.

If the attempt budget is exhausted, startup escalates with the failed records preserved. A plain restart or operator response does not silently create more copies. Bootstrap observations are durable run-local diagnostics; they do not become permanent repository policy.

The boundary is shared by SDK and native Herdr runtimes. It does not change the pinned `gpt-6-astra` orchestrator contract, substitute an SDK process for native Herdr, or introduce storage migration or compatibility support.

Focused verification, with each command allowed to finish before the next:

```sh
npm run build
npm run typecheck
npx vitest run test/controller.integration.test.ts test/bootstrap.test.ts test/runtime-handoff.integration.test.ts
```

The controller tests use scripted provider decisions with real SQLite, Git copies, process confinement and stop receipts. They test bootstrap behavior, not live model judgment or complete epic delivery.
