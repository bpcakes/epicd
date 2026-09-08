import { Socket } from "node:net";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { CaptureIORequestSchema, assertCaptureWorker } from "./capture-io.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const input = new Socket({ fd: 3, readable: true, writable: false });
  let data = "";
  try {
    for await (const chunk of input) {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65_536)
        throw new Error("Capture worker request exceeded its bound");
    }
  } finally {
    input.destroy();
  }
  const request = CaptureIORequestSchema.parse(JSON.parse(data));
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
