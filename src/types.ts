/**
 * The Status and Conclusion types are difficult to find a reliable source
 * of truth for, but this seems accurate from testing:
 * https://docs.github.com/en/enterprise-server@3.14/rest/guides/using-the-rest-api-to-interact-with-checks#about-check-suites
 */

export enum WorkflowRunStatus {
  Queued = "queued",
  InProgress = "in_progress",
  Requested = "requested",
  Waiting = "waiting",
  Pending = "pending",
  Completed = "completed",
}

export enum WorkflowRunConclusion {
  Success = "success",
  Failure = "failure",
  Neutral = "neutral",
  Cancelled = "cancelled",
  Skipped = "skipped",
  TimedOut = "timed_out",
  Stale = "stale",
  StartupFailure = "startup_failure",
  ActionRequired = "action_required",
}

export type Result<T> = ResultSuccess<T> | RequestTimeout | ResultUnsupported;

interface ResultSuccess<T> {
  success: true;
  value: T;
}

interface RequestTimeout {
  success: false;
  reason: "timeout";
}

interface ResultUnsupported {
  success: false;
  reason: "unsupported";
  value: string;
}

export type WorkflowRunStatusResult =
  ResultSuccess<WorkflowRunStatus> | ResultStatusPending | ResultUnsupported;

interface ResultStatusPending {
  success: false;
  reason: "pending";
  value: WorkflowRunStatus;
}

/**
 * Rejected requests will continue to be rejected.
 * Failed requests can be retried and eventually succeed.
 */
export type WorkflowRunCancelResult =
  { success: true } | { success: false; reason: "rejected" | "failed" };

export type WorkflowRunConclusionResult =
  | ResultSuccess<WorkflowRunConclusion>
  | ResultConclusionInconclusive
  | ResultConclusionTimedOut
  | ResultUnsupported;

interface ResultConclusionInconclusive {
  success: false;
  reason: "inconclusive";
  value: WorkflowRunConclusion;
}

interface ResultConclusionTimedOut {
  success: false;
  reason: "timed_out";
  value: WorkflowRunConclusion;
}
