import { runRecoveryKind, type EngineEvent, type RunPhase, type RunState } from "./domain/types.js";
import { RunAlreadyControlledError } from "./adapters/store.js";
import { AgentCleanupRequiredError, WorkflowCompletionReportingError } from "./engine/errors.js";

const IDLE_CONTROLLER_PHASES = new Set<RunPhase>(["paused", "blocked", "complete"]);

export function isControllerIdlePhase(phase: RunPhase): boolean {
  return IDLE_CONTROLLER_PHASES.has(phase);
}

export function canRequestPause(controllerBusy: boolean, phase: RunPhase): boolean {
  return controllerBusy && !isControllerIdlePhase(phase);
}

/** Workflow phase may become idle before the active operation releases its lease. */
export function shouldExitAfterController(
  pauseThenExit: boolean,
  controllerBusy: boolean,
): boolean {
  return pauseThenExit && !controllerBusy;
}

export function controllerFailureMessage(error: unknown): string {
  if (error instanceof RunAlreadyControlledError) {
    return `Run ${error.runId} is already controlled by process ${error.pid}. Stop that epicd process first. If the controller is stale, run: epicd unlock ${error.runId} --owner-pid ${error.pid} --lease-id ${error.leaseId} --force`;
  }
  if (error instanceof AgentCleanupRequiredError) {
    return `Agent cleanup for run ${error.runId} needs attention: ${error.message}. Retry with: epicd resume ${error.epicId}. If cleanup cannot be completed, explicitly abandon it with: epicd cleanup ${error.runId} --abandon. External agent resources may remain open.`;
  }
  if (error instanceof WorkflowCompletionReportingError) {
    return `Workflow for epic ${error.epicId} completed, but its final event could not be recorded: ${error.message}. Inspect the durable result with: epicd status ${error.epicId}`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Controller stopped unexpectedly: ${detail}. Restart epicd to recover from the last persisted phase.`;
}

export function performControllerCommand(
  command: () => void,
  onError: (message: string) => void,
): boolean {
  try {
    command();
    return true;
  } catch (error) {
    onError(controllerFailureMessage(error));
    return false;
  }
}

export function epicRunConflictMessage(
  run: Parameters<typeof runRecoveryKind>[0] & Pick<RunState, "epicId" | "runId">,
  repoPath: string,
): string {
  if (runRecoveryKind(run) === "diagnostic") {
    return `Completed run ${run.runId} for epic ${run.epicId} has a saved diagnostic. Use: epicd resume ${run.epicId} --repo ${repoPath}, or epicd cleanup ${run.runId} --abandon`;
  }
  const ownership = run.phase === "complete" ? "pending agent cleanup" : `a ${run.phase} workflow`;
  return `An existing run for epic ${run.epicId} has ${ownership}. Use: epicd resume ${run.epicId} --repo ${repoPath}`;
}

type HeadlessController = {
  onEvent(listener: (event: EngineEvent) => void): () => void;
  run(): Promise<RunState>;
};

export async function launchHeadlessController(controller: HeadlessController): Promise<void> {
  controller.onEvent((event) => {
    process.stdout.write(
      `${event.at} ${event.level.toUpperCase()} ${event.message}${event.detail ? ` — ${event.detail}` : ""}\n`,
    );
  });
  let result: RunState;
  try {
    result = await controller.run();
  } catch (error) {
    process.exitCode = 1;
    throw new Error(controllerFailureMessage(error), { cause: error });
  }
  if (result.phase !== "complete") process.exitCode = 1;
}

export async function observeControllerOperation(
  operation: Promise<RunState>,
  onState: (state: RunState) => void,
  onError: (message: string) => void,
): Promise<void> {
  let state: RunState;
  try {
    state = await operation;
  } catch (error) {
    onError(controllerFailureMessage(error));
    return;
  }
  onState(state);
}

export class ControllerOperationGate {
  private active: Promise<RunState> | null = null;

  get busy(): boolean {
    return this.active !== null;
  }

  start(
    operation: () => Promise<RunState>,
    onState: (state: RunState) => void,
    onError: (message: string) => void,
    onBusyChange: (busy: boolean) => void,
  ): boolean {
    if (this.active) return false;
    let active: Promise<RunState>;
    try {
      active = operation();
    } catch (error) {
      onError(controllerFailureMessage(error));
      return false;
    }
    this.active = active;
    onBusyChange(true);
    void observeControllerOperation(active, onState, onError)
      .catch(() => {
        process.emitWarning(
          "Controller state observer failed; persisted state remains authoritative",
        );
      })
      .finally(() => {
        if (this.active !== active) return;
        this.active = null;
        onBusyChange(false);
      });
    return true;
  }
}
