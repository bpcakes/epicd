import { readFileSync } from "node:fs";
import { StateStore } from "../../dist/adapters/store.js";
import { WorkspaceManager } from "../../dist/adapters/workspaces.js";
import { ActionKernel } from "../../dist/kernel/actions.js";
import { registerDeliveryCapabilities } from "../../dist/kernel/delivery.js";

// Kill the actual kernel caller at acknowledgement of a genuinely produced worker receipt.
// Neither the copied bytes, review binding, worker result nor receipt is fabricated here.
const input = JSON.parse(readFileSync(0, "utf8"));
const store = new StateStore(input.stateFile.path, input.stateFile);
try {
  const journal = store.orchestration;
  const recordStop = journal.workspaceCreations.recordStop.bind(journal.workspaceCreations);
  journal.workspaceCreations.recordStop = (authority, creationId, receipt) => {
    if (input.crashPoint === "after_ack") recordStop(authority, creationId, receipt);
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL did not terminate the caller");
  };
  const kernel = new ActionKernel(journal);
  registerDeliveryCapabilities(kernel, new WorkspaceManager(journal, input.workspaceRoot));
  const started = await kernel.execute(input.decision, input.authority);
  if (started.status !== "running") throw new Error("Creation did not start asynchronously");
  process.stdout.write(JSON.stringify(await kernel.operation(started.operationId)) + "\n");
} finally {
  store.close();
}
