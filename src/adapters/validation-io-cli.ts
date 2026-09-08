import { Socket } from "node:net";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { ValidationIORequestSchema, assertValidationWorker } from "./validation-io.js";
import { executeCandidateValidation } from "./validation.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const input = new Socket({ fd: 3, readable: true, writable: false });
  let data = "";
  try {
    for await (const chunk of input) {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65_536)
        throw new Error("Validation worker request exceeded its bound");
    }
  } finally {
    input.destroy();
  }
  const request = ValidationIORequestSchema.parse(JSON.parse(data));
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
