export class AgentCleanupRequiredError extends Error {
  override readonly name = "AgentCleanupRequiredError";

  constructor(
    readonly runId: string,
    readonly epicId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class WorkflowCompletionReportingError extends Error {
  override readonly name = "WorkflowCompletionReportingError";

  constructor(
    readonly runId: string,
    readonly epicId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
