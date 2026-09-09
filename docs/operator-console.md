# Operator console

Run `epicd control RUN_ID --state /absolute/path/to/state.sqlite3` in an interactive terminal to inspect and control an existing current-format run. The console does not create a run, acquire a delivery-controller lease, start a model, resume delivery, or implicitly switch runtime. It can coexist with a live controller; handoff still requires that controller and its work to settle first.

The menu supports pause, an exact-question response, fixture-management grants and revocation, separate fixture SQL-access grants and revocation, and explicit SDK/native-Herdr handoff. Fixture declarations and active grant IDs are paginated with `[` and `]`. The screen shows expiry, not proof that the external resource is currently safe or available.

Select an operation, enter its fields, review the exact request and declared resource, then type `confirm` and press Enter. Embedded returns in pasted text do not submit or confirm an operation; press Enter separately after reviewing the displayed input. There are no preselected grants, expiry defaults, automatic confirmations, or automatic retries. Escape discards an unsubmitted form. The request retains the control version observed when the form was opened; concurrent changes cause rejection, not an automatic refresh of authority. Responses also retain the exact question ID.

Free-text responses are instructions only. They never grant environment authority. A management grant does not imply SQL access, and neither kind answers a pending question or adopts a database. SQL confirmation includes the declared dedicated role and broker. Actual grants still require native executable/socket binding and the journal's existing policy, expiry and current-version checks. Reset and cleanup remain unavailable. Grant revocation does not delete resources or prove outstanding work stopped.

Handoff uses the existing stopped-only, exact-repository procedure. Native Herdr requires a managed caller and reads that caller's exact session/workspace; it never selects a focused pane or substitutes SDK workers. Handoff preserves Astra settings, budgets, memory, evidence and pending questions. Resume explicitly afterward when appropriate.

`q` closes from the menu without pausing delivery. Ctrl+C closes from any screen; an in-flight metadata binding or handoff is cancelled where possible and awaited before SQLite is closed. A committed operation cannot be undone by closing its console. Inspect status if closure interrupted the acknowledgement. Reopening does not replay the request. SIGINT/SIGTERM use the same cancellation/drain path.

The existing explicit CLI commands remain available for noninteractive use and share `RunOperator` with the console. This is one implementation boundary, not a compatibility layer. The UI owns input and confirmation; the shared boundary owns provider binding and request lifetime; the kernel owns authority and durable changes. Replacing the terminal frontend does not require reimplementing fixture or runtime guards. No storage migration or model capability was added.

Build before tests, and let each command finish:

```sh
npm run build
npm run typecheck
npx vitest run test/operator-controls.integration.test.ts test/operator-view.test.tsx test/operator-console-pty.integration.test.ts test/cli.integration.test.ts test/runtime-handoff.integration.test.ts test/run-view.test.tsx test/fixture-policy.integration.test.ts test/fixture-validation-policy.test.ts
```

Operator tests use actual SQLite and owned socket/native-file metadata without making database queries. The compiled-console checks use util-linux `script` to supply an actual pseudo-terminal and exercise opening, confirmation and cancellation. UI-only handoff tests script submission; the handoff integration fixture independently checks real Git/journal behavior with a strict read-only Herdr CLI stand-in. These tests do not establish authenticated model delivery or full browser/receipt acceptance.
