import { readFileSync } from "node:fs";
import { StateStore } from "../../dist/adapters/store.js";
import { WorkspaceManager } from "../../dist/adapters/workspaces.js";
import { ActionKernel } from "../../dist/kernel/actions.js";
import { registerCommitCapabilities } from "../../dist/kernel/commits.js";

// Kill only the caller at a real worker boundary; never fabricate a result or receipt.
const input = JSON.parse(readFileSync(0, "utf8"));
const store = new StateStore(input.stateFile.path, input.stateFile);
let timer;
function workerBelow(pid) {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    for (const child of children ? children.split(/\s+/).map(Number) : []) {
      // Ancestor supervisors carry the script as a later launch argument too.
      // Only argv[1] identifies the actual Node worker to hold.
      if (
        readFileSync(`/proc/${child}/cmdline`, "utf8")
          .split("\0")[1]
          ?.endsWith("/workspace-inspection-io-cli.js")
      )
        return child;
      const nested = workerBelow(child);
      if (nested) return nested;
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
  }
  return null;
}
try {
  const journal = store.orchestration;
  if (input.crashPoint === "during_worker") {
    timer = setInterval(() => {
      const worker = workerBelow(process.pid);
      if (!worker) return;
      // Hold the live worker before retention. Caller death must make its independent
      // supervisor terminate even this stopped descendant and retain the real receipt.
      process.kill(worker, "SIGSTOP");
      clearInterval(timer);
      const pending = journal.workspaceInspections.pending(input.authority.runId, input.workspace);
      if (!pending?.execution || pending.workerResult)
        throw new Error("Did not intercept the live inspection before result retention");
      const stat = readFileSync(`/proc/${worker}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      process.stdout.write(
        JSON.stringify({ worker, start, inspectionId: pending.inspectionId }) + "\n",
        () => {
          process.kill(process.pid, "SIGKILL");
        },
      );
    }, 5);
  } else {
    const recordStop = journal.workspaceInspections.recordStop.bind(journal.workspaceInspections);
    journal.workspaceInspections.recordStop = (authority, inspectionId, stop) => {
      if (input.crashPoint === "after_ack") recordStop(authority, inspectionId, stop);
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL did not terminate the inspection caller");
    };
  }
  const manager = new WorkspaceManager(journal, input.workspaceRoot);
  if (input.decision) {
    const kernel = new ActionKernel(journal);
    registerCommitCapabilities(kernel, manager);
    const started = await kernel.execute(input.decision, input.authority);
    if (started.status !== "running") throw new Error("Commit did not start asynchronously");
    await kernel.operation(started.operationId);
  } else {
    await manager.inspectMaterialization(input.authority, input.workspace);
  }
  throw new Error("Inspection did not reach the requested crash boundary");
} finally {
  clearInterval(timer);
  store.close();
}
