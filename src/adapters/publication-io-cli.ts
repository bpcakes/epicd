import { Socket } from "node:net";
import { StateStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";
import { PublicationAdapter } from "./publication.js";
import { PublicationIORequestSchema, assertPublicationWorker } from "./publication-io.js";
import { redactSensitiveText } from "../util/redact.js";

async function work() {
  const input = new Socket({ fd: 3, readable: true, writable: false });
  let data = "";
  try {
    for await (const chunk of input) {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65_536)
        throw new Error("Publication request exceeded its bound");
    }
  } finally {
    input.destroy();
  }
  const request = PublicationIORequestSchema.parse(JSON.parse(data));
  const store = new StateStore(request.stateFile.path, request.stateFile);
  try {
    const { record } = assertPublicationWorker(store.orchestration, request);
    const adapter = new PublicationAdapter(
      store.orchestration,
      new WorkspaceManager(store.orchestration, record.workspaceRoot),
    );
    if (request.phase === "publish")
      await adapter.executePublication(request.authority, request.publicationId, request.attemptId);
    else
      await adapter.executeInspection(request.authority, request.publicationId, request.attemptId);
  } finally {
    store.close();
  }
}
work().catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Publication worker failed")}\n`,
  );
  process.exitCode = 1;
});
