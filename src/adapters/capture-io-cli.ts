import { readWorkerRequest } from "./worker-request.js";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { CaptureIORequestSchema, assertCaptureWorker } from "./capture-io.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const request = CaptureIORequestSchema.parse(await readWorkerRequest("Capture worker request"));
  // Exact existing state only: attachment cannot adopt, initialize or migrate a file.
  const store = new StateStore(request.stateFile.path, request.stateFile);
  try {
    const journal = store.orchestration;
    const candidate = assertCaptureWorker(journal, request);
    await new WorkspaceManager(journal, request.workspaceRoot).executeCandidateCapture(
      request.authority,
      candidate,
    );
  } finally {
    store.close();
  }
}
work().catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Capture worker failed")}\n`,
  );
  process.exitCode = 1;
});
