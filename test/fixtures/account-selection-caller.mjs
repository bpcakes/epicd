import { join } from "node:path";
import { selectAccounts } from "../../dist/tui/account-editor-session.js";
import { createRun } from "../../dist/bootstrap.js";
import { StateStore } from "../../dist/adapters/store.js";
const root = process.argv[2];
const store = new StateStore(join(root, "state.sqlite3"));
try {
  let run;
  let attempts = 0;
  const accountDraft = await selectAccounts("demo", {}, undefined, undefined, {
    epicTitle: "Demo account setup",
    repoPath: join(root, "repo"),
    runtime: "sdk",
    start: async (draft, signal) => {
      attempts++;
      if (process.env.EPICD_FIXTURE_FAIL_START === "1" && attempts === 1)
        throw new Error("Fixture creation failed before persistence");
      run = await createRun(
        store,
        {
          repoPath: join(root, "repo"),
          epicId: "demo",
          runtime: "sdk",
          codexPath: join(root, "codex"),
          trackerPath: join(root, "br"),
          model: "worker",
          accountDraft: draft,
        },
        signal,
      );
    },
  });
  process.stdout.write(`RAW ${Boolean(process.stdin.isRaw)}\n`);
  if (accountDraft === null || accountDraft === "quit") process.stdout.write("CANCELLED\n");
  else process.stdout.write(`CREATED ${run.runId}\nATTEMPTS ${attempts}\n`);
} finally {
  store.close();
}
