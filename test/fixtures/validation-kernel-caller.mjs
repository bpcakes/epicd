import { readFileSync } from "node:fs";
import { StateStore } from "../../dist/adapters/store.js";
import { WorkspaceManager } from "../../dist/adapters/workspaces.js";
import { ActionKernel } from "../../dist/kernel/actions.js";
import { registerDeliveryCapabilities } from "../../dist/kernel/delivery.js";

// A real separate kernel caller. No model, mocked command, or synthesized result.
const input = JSON.parse(readFileSync(0, "utf8"));
const store = new StateStore(input.stateFile.path, input.stateFile);
try {
  const journal = store.orchestration;
  const kernel = new ActionKernel(journal);
  registerDeliveryCapabilities(kernel, new WorkspaceManager(journal, input.workspaceRoot));
  const started = await kernel.execute(input.decision, input.authority);
  if (started.status !== "running") throw new Error("Validation did not start asynchronously");
  const result = await kernel.operation(started.operationId);
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  store.close();
}
