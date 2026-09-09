import { readWorkerRequest } from "./worker-request.js";
import { StateStore } from "./store.js";
import {
  WorkspaceDisposalRequestSchema,
  assertWorkspaceDisposalWorker,
} from "./workspace-disposal-io.js";
import { moveDisposedWorkspace } from "./workspace-disposal-files.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const request = WorkspaceDisposalRequestSchema.parse(await readWorkerRequest("Disposal request"));
  const store = new StateStore(request.stateFile.path, request.stateFile);
  try {
    const record = assertWorkspaceDisposalWorker(store.orchestration, request);
    await moveDisposedWorkspace(record, () => {
      assertWorkspaceDisposalWorker(store.orchestration, request);
    });
  } finally {
    store.close();
  }
}
work().catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Disposal worker failed")}\n`,
  );
  process.exitCode = 1;
});
