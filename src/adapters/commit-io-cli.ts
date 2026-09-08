import { Socket } from "node:net";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { CommitIORequestSchema, assertCommitWorker } from "./commit-io.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const input = new Socket({ fd: 3, readable: true, writable: false });
  let data = "";
  try {
    for await (const chunk of input) {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65_536)
        throw new Error("Commit worker request exceeded its bound");
    }
  } finally {
    input.destroy();
  }
  const request = CommitIORequestSchema.parse(JSON.parse(data));
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
