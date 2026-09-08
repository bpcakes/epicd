import { readFileSync } from "node:fs";
import { StateStore } from "../../dist/adapters/store.js";
import { WorkspaceManager } from "../../dist/adapters/workspaces.js";
import { ActionKernel } from "../../dist/kernel/actions.js";
import { registerDeliveryCapabilities } from "../../dist/kernel/delivery.js";

// Crash the actual controller after the independent worker's receipt exists.
// This hook never fabricates either the snapshot or the receipt.
const input = JSON.parse(readFileSync(0, "utf8"));
const store = new StateStore(input.stateFile.path, input.stateFile);
try {
  const journal = store.orchestration;
  const recordStop = journal.agents.recordWorkspaceExecutionStop.bind(journal.agents);
  journal.agents.recordWorkspaceExecutionStop = (authority, operationId, receipt) => {
    if (journal.agents.workspaceOperation(authority.runId, operationId).kind === "capture") {
      if (input.crashPoint === "after_ack") recordStop(authority, operationId, receipt);
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL did not terminate the caller");
    }
    return recordStop(authority, operationId, receipt);
  };
  const kernel = new ActionKernel(journal);
  registerDeliveryCapabilities(kernel, new WorkspaceManager(journal, input.workspaceRoot));
  const started = await kernel.execute(input.decision, input.authority);
  if (started.status !== "running") throw new Error("Capture did not start asynchronously");
  process.stdout.write(JSON.stringify(await kernel.operation(started.operationId)) + "\n");
} finally {
  store.close();
}
