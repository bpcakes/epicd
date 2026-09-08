import { readFileSync } from "node:fs";
import { StateStore } from "../../dist/adapters/store.js";
import { WorkspaceManager } from "../../dist/adapters/workspaces.js";
import { ActionKernel } from "../../dist/kernel/actions.js";
import { registerCommitCapabilities } from "../../dist/kernel/commits.js";

// Crash the real kernel caller before binding its prepared worker, or at the
// durable-receipt / journal-acknowledgement boundary. No receipt is fabricated.
const input = JSON.parse(readFileSync(0, "utf8"));
const store = new StateStore(input.stateFile.path, input.stateFile);
try {
  const journal = store.orchestration;
  const bind = journal.agents.bindWorkspaceExecution.bind(journal.agents);
  journal.agents.bindWorkspaceExecution = (authority, operationId, intent) => {
    if (
      input.crashPoint === "before_bind" &&
      journal.agents.workspaceOperation(authority.runId, operationId).kind === "commit"
    ) {
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL did not terminate the caller");
    }
    return bind(authority, operationId, intent);
  };
  const recordStop = journal.agents.recordWorkspaceExecutionStop.bind(journal.agents);
  journal.agents.recordWorkspaceExecutionStop = (authority, operationId, receipt) => {
    if (journal.agents.workspaceOperation(authority.runId, operationId).kind === "commit") {
      if (input.crashPoint === "after_ack") recordStop(authority, operationId, receipt);
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL did not terminate the caller");
    }
    return recordStop(authority, operationId, receipt);
  };
  const kernel = new ActionKernel(journal);
  registerCommitCapabilities(kernel, new WorkspaceManager(journal, input.workspaceRoot));
  const started = await kernel.execute(input.decision, input.authority);
  if (started.status !== "running") throw new Error("Commit did not start asynchronously");
  process.stdout.write(JSON.stringify(await kernel.operation(started.operationId)) + "\n");
} finally {
  store.close();
}
