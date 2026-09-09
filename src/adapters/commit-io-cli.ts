import { readWorkerRequest } from "./worker-request.js";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { CommitIORequestSchema, assertCommitWorker } from "./commit-io.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const request = CommitIORequestSchema.parse(await readWorkerRequest("Commit worker request"));
  const store = new StateStore(request.stateFile.path, request.stateFile);
  try {
    const journal = store.orchestration;
    const record = assertCommitWorker(journal, request);
    const workspaces = new WorkspaceManager(journal, request.workspaceRoot);
    if ("trackerCommitId" in record)
      await workspaces.executeTrackerCommit(request.authority, record);
    else await workspaces.executeCandidateCommit(request.authority, record);
  } finally {
    store.close();
  }
}
work().catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Commit worker failed")}\n`,
  );
  process.exitCode = 1;
});
