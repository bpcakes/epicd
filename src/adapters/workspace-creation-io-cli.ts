import { readWorkerRequest } from "./worker-request.js";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import {
  WorkspaceCreationRequestSchema,
  assertWorkspaceCreationWorker,
} from "./workspace-creation-io.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const request = WorkspaceCreationRequestSchema.parse(
    await readWorkerRequest("Creation worker request"),
  );
  const store = new StateStore(request.stateFile.path, request.stateFile);
  try {
    const record = assertWorkspaceCreationWorker(store.orchestration, request);
    await new WorkspaceManager(store.orchestration, record.workspaceRoot).executeWorkspaceCreation(
      request.authority,
      record.creationId,
    );
  } finally {
    store.close();
  }
}
work().catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Creation worker failed")}\n`,
  );
  process.exitCode = 1;
});
