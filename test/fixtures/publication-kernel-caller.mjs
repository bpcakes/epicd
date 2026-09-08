import { readFileSync } from "node:fs";
import { StateStore } from "../../dist/adapters/store.js";
import { WorkspaceManager } from "../../dist/adapters/workspaces.js";
import { ActionKernel } from "../../dist/kernel/actions.js";
import { registerPublicationCapabilities } from "../../dist/kernel/publication.js";

// Kill the real kernel caller at acknowledgement of an independently produced receipt.
// The worker, ref writes, observations and stop proof are genuine, not injected results.
const input = JSON.parse(readFileSync(0, "utf8"));
const store = new StateStore(input.stateFile.path, input.stateFile);
try {
  const journal = store.orchestration;
  const acknowledge = journal.publications.recordIOStop.bind(journal.publications);
  journal.publications.recordIOStop = (authority, publicationId, attemptId, stop) => {
    const attempt = journal.publications
      .record(authority.runId, publicationId)
      .ioAttempts.find((item) => item.attemptId === attemptId);
    if (attempt.phase !== input.phase)
      return acknowledge(authority, publicationId, attemptId, stop);
    if (input.crashPoint === "after_ack") acknowledge(authority, publicationId, attemptId, stop);
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL did not terminate the publication caller");
  };
  const kernel = new ActionKernel(journal);
  registerPublicationCapabilities(kernel, new WorkspaceManager(journal, input.workspaceRoot));
  const started = await kernel.execute(input.decision, input.authority);
  if (started.status !== "running") throw new Error("Publication was not admitted asynchronously");
  process.stdout.write(JSON.stringify(await kernel.operation(started.operationId)) + "\n");
} finally {
  store.close();
}
