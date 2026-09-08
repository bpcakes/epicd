import { Socket } from "node:net";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import {
  WorkspaceCreationRequestSchema,
  assertWorkspaceCreationWorker,
} from "./workspace-creation-io.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const input = new Socket({ fd: 3, readable: true, writable: false });
  let data = "";
  try {
    for await (const chunk of input) {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65_536)
        throw new Error("Creation worker request exceeded its bound");
    }
  } finally {
    input.destroy();
  }
  const request = WorkspaceCreationRequestSchema.parse(JSON.parse(data));
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
