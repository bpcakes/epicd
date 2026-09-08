import { Socket } from "node:net";
import { StateStore } from "./store.js";
import {
  WorkspaceDisposalRequestSchema,
  assertWorkspaceDisposalWorker,
} from "./workspace-disposal-io.js";
import { moveDisposedWorkspace } from "./workspace-disposal-files.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const input = new Socket({ fd: 3, readable: true, writable: false });
  let bytes = "";
  try {
    for await (const chunk of input) {
      bytes += chunk.toString();
      if (Buffer.byteLength(bytes) > 65_536) throw new Error("Disposal request exceeded its bound");
    }
  } finally {
    input.destroy();
  }
  const request = WorkspaceDisposalRequestSchema.parse(JSON.parse(bytes));
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
