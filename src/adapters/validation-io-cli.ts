import { readWorkerRequest } from "./worker-request.js";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { ValidationIORequestSchema, assertValidationWorker } from "./validation-io.js";
import { executeCandidateValidation } from "./validation.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const request = ValidationIORequestSchema.parse(
    await readWorkerRequest("Validation worker request"),
  );
  // Exact existing file only. Attaching cannot initialize, adopt, or migrate state.
  const store = new StateStore(request.stateFile.path, request.stateFile);
  try {
    const journal = store.orchestration;
    const evidence = assertValidationWorker(journal, request);
    await executeCandidateValidation(
      journal,
      new WorkspaceManager(journal, request.workspaceRoot),
      request.authority,
      evidence,
      new AbortController().signal,
    );
  } finally {
    store.close();
  }
}
work().catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Validation worker failed")}\n`,
  );
  process.exitCode = 1;
});
