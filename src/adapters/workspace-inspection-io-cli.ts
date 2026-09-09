import { readWorkerRequest } from "./worker-request.js";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import {
  WorkspaceInspectionRequestSchema,
  assertWorkspaceInspectionWorker,
} from "./workspace-inspection-io.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const request = WorkspaceInspectionRequestSchema.parse(
    await readWorkerRequest("Inspection request"),
  );
  const store = new StateStore(request.stateFile.path, request.stateFile);
  try {
    const record = assertWorkspaceInspectionWorker(store.orchestration, request);
    await new WorkspaceManager(store.orchestration, record.workspaceRoot).executeInspection(
      request.authority,
      record.inspectionId,
    );
  } finally {
    store.close();
  }
}
work().catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Inspection worker failed")}\n`,
  );
  process.exitCode = 1;
});
