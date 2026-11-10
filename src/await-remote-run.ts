import * as core from "@actions/core";

import {
  classifyRequestFailure,
  fetchWorkflowRunFailedJobs,
  fetchWorkflowRunJobStates,
  fetchWorkflowRunState,
  requestWorkflowRunCancel,
  type WorkflowRunJobState,
  type WorkflowRunState,
} from "./api.ts";
import * as constants from "./constants.ts";
import {
  POLL_PENDING,
  WorkflowRunConclusion,
  WorkflowRunStatus,
  type PollAttempt,
  type ResultUnrecoverable,
  type WorkflowRunConclusionResult,
  type WorkflowRunJobsResult,
  type WorkflowRunResult,
  type WorkflowRunStatusResult,
} from "./types.ts";
import { sleep } from "./utils.ts";

export function getWorkflowRunStatusResult(
  status: string | null,
  attemptNo: number,
): WorkflowRunStatusResult {
  switch (status) {
    case WorkflowRunStatus.Completed:
      return { success: true, value: status };
    case WorkflowRunStatus.Queued:
      core.debug(`Run is queued to begin, attempt ${attemptNo}...`);
      return { success: false, reason: "pending", value: status };
    case WorkflowRunStatus.InProgress:
      core.debug(`Run is in progress, attempt ${attemptNo}...`);
      return { success: false, reason: "pending", value: status };
    case WorkflowRunStatus.Requested:
    case WorkflowRunStatus.Pending:
    case WorkflowRunStatus.Waiting:
      core.debug(`Run is ${status}, attempt ${attemptNo}...`);
      return { success: false, reason: "pending", value: status };
    default:
      core.error(`Run status is unsupported: ${String(status)}`);
      core.info("Please open an issue with this status value");
      return { success: false, reason: "unsupported", value: String(status) };
  }
}

export function getWorkflowRunConclusionResult(
  conclusion: string | null,
): WorkflowRunConclusionResult {
  switch (conclusion) {
    case WorkflowRunConclusion.Success:
      return { success: true, value: conclusion };
    case WorkflowRunConclusion.ActionRequired:
    case WorkflowRunConclusion.Cancelled:
    case WorkflowRunConclusion.Failure:
    case WorkflowRunConclusion.Neutral:
    case WorkflowRunConclusion.Skipped:
    case WorkflowRunConclusion.Stale:
    case WorkflowRunConclusion.StartupFailure:
    case WorkflowRunConclusion.TimedOut:
      core.error(`Run has failed with conclusion: ${conclusion}`);
      return { success: false, reason: "inconclusive", value: conclusion };
    default:
      core.error(
        `Run has failed with unsupported conclusion: ${String(conclusion)}`,
      );
      core.info("Please open an issue with this conclusion value");
      return {
        success: false,
        reason: "unsupported",
        value: String(conclusion),
      };
  }
}

export async function handleActionFail(
  failureMsg: string,
  runId: number,
): Promise<void> {
  core.setFailed(`Failed: ${failureMsg}`);

  // Handle and log errors here so teardown errors don't leak to the caller
  // catch and end up overriding the `setFailed` with the wrong error.
  try {
    const failedJobs = await fetchWorkflowRunFailedJobs(runId);
    for (const failedJob of failedJobs) {
      const failedSteps = failedJob.steps
        .filter((step) => step.conclusion !== "success")
        .map((step) => {
          return (
            `    ${step.number}: ${step.name}\n` +
            `      Status: ${step.status}\n` +
            `      Conclusion: ${step.conclusion}`
          );
        })
        .join("\n");
      core.error(
        `Job ${failedJob.name}:\n` +
          `  ID: ${failedJob.id}\n` +
          `  Status: ${failedJob.status}\n` +
          `  Conclusion: ${failedJob.conclusion}\n` +
          `  URL: ${failedJob.url}\n` +
          `  Steps (non-success):\n` +
          (failedSteps || "    (none)"),
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    core.warning(
      `Unable to log failed job details for Workflow Run ${runId}: ${detail}`,
    );
  }
}

/**
 * The result a fetched state settles on, or pending while the run has yet to
 * resolve and is worth polling for again.
 */
function getWorkflowRunStateResult(
  status: string | null,
  conclusion: string | null,
  attemptNo: number,
): PollAttempt<WorkflowRunResult> {
  const statusResult = getWorkflowRunStatusResult(status, attemptNo);
  if (!statusResult.success) {
    // An unsupported status may never resolve, unlike a pending one. Alert to
    // raise this so we can handle it properly.
    return statusResult.reason === "unsupported"
      ? { done: true, value: statusResult }
      : POLL_PENDING;
  }

  // We only get a conclusion should the status resolve, otherwise it is null.
  const conclusionResult = getWorkflowRunConclusionResult(conclusion);
  if (conclusionResult.success || conclusionResult.reason === "inconclusive") {
    return {
      done: true,
      value: {
        success: true,
        value: {
          status: statusResult.value,
          conclusion: conclusionResult.value,
        },
      },
    };
  }

  return {
    done: true,
    value: {
      success: false,
      reason: "unsupported",
      value: conclusionResult.value,
    },
  };
}

interface RunOpts {
  startTime: number;
  pollIntervalMs: number;
  runId: number;
  runTimeoutMs: number;
  cancelTimeoutMs?: number;
}

/**
 * Poll the run until `attempt` settles on a result or the run timeout elapses,
 * requesting cancellation on the way if one was configured.
 *
 * A configured cancellation is guaranteed to have been requested by the time
 * this returns on timeout, even if no poll fell between the two timeouts.
 * `cancelRequested` reports whether GitHub has settled such a request, so a
 * caller giving up on the run for its own reasons need not ask again.
 */
async function pollRun<T>(
  { startTime, runId, runTimeoutMs, pollIntervalMs, cancelTimeoutMs }: RunOpts,
  attempt: (attemptNo: number) => Promise<PollAttempt<T>>,
): Promise<{
  result: T | { success: false; reason: "timeout" };
  cancelRequested: boolean;
}> {
  let attemptNo = 0;
  let cancelRequested = false;
  // Resolves to whether the request has settled. A failed request may be
  // transient, so it is left outstanding for the next poll to retry.
  const requestCancel = async (elapsedTime: number): Promise<boolean> => {
    core.warning(
      `Cancel timeout exceeded (${elapsedTime}ms), requesting cancellation of Workflow Run ${runId}`,
    );
    const cancelResult = await requestWorkflowRunCancel(runId);
    return cancelResult.success || cancelResult.reason === "rejected";
  };

  while (Date.now() - startTime < runTimeoutMs) {
    attemptNo++;

    const attempted = await attempt(attemptNo);
    if (attempted.done) {
      return { result: attempted.value, cancelRequested };
    }

    const elapsedTime = Date.now() - startTime;
    if (
      cancelTimeoutMs !== undefined &&
      !cancelRequested &&
      elapsedTime >= cancelTimeoutMs
    ) {
      cancelRequested = await requestCancel(elapsedTime);
    }

    await sleep(pollIntervalMs);
  }

  // The cancel timeout can elapse during the final sleep, or a failed request
  // can still be outstanding. The run is being given up on either way, so
  // leaving it running would defeat the point of configuring cancellation.
  if (cancelTimeoutMs !== undefined && !cancelRequested) {
    cancelRequested = await requestCancel(Date.now() - startTime);
  }

  return {
    result: { success: false, reason: "timeout" },
    cancelRequested,
  };
}

/**
 * Whether a fetch failure ends polling, as no later poll can succeed.
 *
 * A 404 is tolerated for `WORKFLOW_RUN_NOT_FOUND_GRACE_MS` from `startTime`,
 * as a freshly dispatched run can be missing briefly.
 */
function isUnrecoverable(error: unknown, startTime: number): boolean {
  switch (classifyRequestFailure(error)) {
    case "permanent": {
      return true;
    }
    case "not_found": {
      return (
        Date.now() - startTime >= constants.WORKFLOW_RUN_NOT_FOUND_GRACE_MS
      );
    }
    case "transient": {
      return false;
    }
  }
}

/**
 * The attempt a failed fetch settles on: unrecoverable when no later poll can
 * succeed, otherwise pending so the next poll retries it.
 *
 * The API layer has already logged the failure itself.
 */
function failedFetchAttempt(
  error: unknown,
  startTime: number,
  retryMsg: string,
): PollAttempt<ResultUnrecoverable> {
  if (isUnrecoverable(error, startTime)) {
    return {
      done: true,
      value: {
        success: false,
        reason: "unrecoverable",
        value: error instanceof Error ? error.message : String(error),
      },
    };
  }

  core.debug(retryMsg);
  return POLL_PENDING;
}

export async function getWorkflowRunResult(
  opts: RunOpts,
): Promise<WorkflowRunResult> {
  const { result } = await pollRun(opts, async (attemptNo) => {
    let state: WorkflowRunState;
    try {
      state = await fetchWorkflowRunState(opts.runId);
    } catch (error) {
      return failedFetchAttempt(
        error,
        opts.startTime,
        `Failed to fetch run state, attempt ${attemptNo}...`,
      );
    }

    return getWorkflowRunStateResult(state.status, state.conclusion, attemptNo);
  });

  return result;
}

export type JobsResult = WorkflowRunJobsResult<WorkflowRunJobState>;

/**
 * The result the awaited Jobs settle on, or pending while they have yet to.
 *
 * A Job absent from `jobs` is only terminal once the run has completed, as
 * until then it may still be created.
 *
 * GitHub permits Jobs to share a name, so an awaited name covers every Job
 * bearing it.
 */
export function getWorkflowRunJobsStateResult(
  awaited: string[],
  jobs: WorkflowRunJobState[],
  runCompleted: boolean,
): PollAttempt<JobsResult> {
  const byName = Map.groupBy(jobs, (job) => job.name);
  const concluded: WorkflowRunJobState[] = [];
  const inconclusive: WorkflowRunJobState[] = [];
  const missing: string[] = [];

  for (const name of awaited) {
    const named = byName.get(name) ?? [];
    const failed = named.filter(
      (job) =>
        job.status === "completed" &&
        job.conclusion !== WorkflowRunConclusion.Success,
    );
    if (failed.length > 0) {
      inconclusive.push(...failed);
    } else if (
      named.length > 0 &&
      named.every((job) => job.status === "completed")
    ) {
      concluded.push(...named);
    } else {
      missing.push(name);
    }
  }

  // One failed Job settles it, the rest cannot change the outcome.
  if (inconclusive.length > 0) {
    for (const job of inconclusive) {
      core.error(
        `Job ${job.name} has failed with conclusion: ${String(job.conclusion)}`,
      );
    }
    return {
      done: true,
      value: { success: false, reason: "inconclusive", value: inconclusive },
    };
  }

  if (missing.length === 0) {
    return { done: true, value: { success: true, value: concluded } };
  }

  if (runCompleted) {
    const observed = jobs.map((job) => job.name);
    core.error(
      `Run concluded without the awaited Jobs completing:\n` +
        `  Awaited: [${missing.join(", ")}]\n` +
        `  Jobs in run: [${observed.join(", ")}]`,
    );
    return {
      done: true,
      value: {
        success: false,
        reason: "missing",
        value: { missing, observed },
      },
    };
  }

  return POLL_PENDING;
}

/**
 * Await named Jobs within the run rather than the run itself, resolving once
 * each has succeeded and leaving the rest of the run in flight.
 *
 * A Job concluding otherwise fails the result, cancelling the run where
 * cancellation is configured.
 */
export async function getWorkflowRunJobsResult(
  opts: RunOpts & { jobs: string[] },
): Promise<JobsResult> {
  // The Jobs listing can briefly lag a freshly completed run, so a `missing`
  // verdict needs completion to hold for two polls before it is terminal.
  let runCompletedLastPoll = false;
  const { result, cancelRequested } = await pollRun(opts, async (attemptNo) => {
    let runState: WorkflowRunState;
    let jobs: WorkflowRunJobState[];
    try {
      [runState, jobs] = await Promise.all([
        fetchWorkflowRunState(opts.runId),
        fetchWorkflowRunJobStates(opts.runId),
      ]);
    } catch (error) {
      return failedFetchAttempt(
        error,
        opts.startTime,
        `Failed to fetch run state and Jobs, attempt ${attemptNo}...`,
      );
    }

    const runCompleted = runState.status === WorkflowRunStatus.Completed;
    const completionConfirmed = runCompleted && runCompletedLastPoll;
    runCompletedLastPoll = runCompleted;

    return getWorkflowRunJobsStateResult(opts.jobs, jobs, completionConfirmed);
  });

  // A failed Job means the run can no longer succeed, so give up on it too
  // where cancellation was opted into. A Job that failed because the cancel
  // timeout already cancelled the run needs no second request.
  if (
    !result.success &&
    result.reason === "inconclusive" &&
    opts.cancelTimeoutMs !== undefined &&
    !cancelRequested
  ) {
    core.warning(
      `Awaited Jobs have concluded unsuccessfully, requesting cancellation of Workflow Run ${opts.runId}`,
    );
    await requestWorkflowRunCancel(opts.runId);
  }

  return result;
}
