import * as core from "@actions/core";

import {
  fetchWorkflowRunFailedJobs,
  fetchWorkflowRunJobStates,
  fetchWorkflowRunState,
  requestWorkflowRunCancel,
  retryOnError,
  type WorkflowRunJobState,
} from "./api.ts";
import {
  POLL_PENDING,
  WorkflowRunConclusion,
  WorkflowRunStatus,
  type PollAttempt,
  type WorkflowRunConclusionResult,
  type WorkflowRunJobsResult,
  type WorkflowRunResult,
  type WorkflowRunStatusResult,
} from "./types.ts";
import { sleep } from "./utils.ts";

export function getWorkflowRunStatusResult(
  status: WorkflowRunStatus | null,
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
  conclusion: WorkflowRunConclusion | null,
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
      core.error(`Run has failed with conclusion: ${conclusion}`);
      return { success: false, reason: "inconclusive", value: conclusion };
    case WorkflowRunConclusion.TimedOut:
      core.error("Run has timed out");
      return { success: false, reason: "timed_out", value: conclusion };
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
  core.error(`Failed: ${failureMsg}`);
  core.setFailed(failureMsg);

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
  status: WorkflowRunStatus | null,
  conclusion: WorkflowRunConclusion | null,
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

  if (conclusionResult.reason === "timed_out") {
    return {
      done: true,
      value: {
        success: false,
        reason: "timeout",
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
 */
async function pollRun<T>(
  { startTime, runId, runTimeoutMs, pollIntervalMs, cancelTimeoutMs }: RunOpts,
  attempt: (attemptNo: number) => Promise<PollAttempt<T>>,
): Promise<T | { success: false; reason: "timeout" }> {
  let attemptNo = 0;
  let cancelRequested = false;
  while (Date.now() - startTime < runTimeoutMs) {
    attemptNo++;

    const attempted = await attempt(attemptNo);
    if (attempted.done) {
      return attempted.value;
    }

    const elapsedTime = Date.now() - startTime;
    if (
      cancelTimeoutMs !== undefined &&
      !cancelRequested &&
      elapsedTime >= cancelTimeoutMs
    ) {
      core.warning(
        `Cancel timeout exceeded (${elapsedTime}ms), requesting cancellation of Workflow Run ${runId}`,
      );
      const cancelResult = await requestWorkflowRunCancel(runId);
      // A failed request may be transient, so leave the request outstanding for
      // the next poll to retry within the remaining run timeout.
      cancelRequested =
        cancelResult.success || cancelResult.reason === "rejected";
    }

    await sleep(pollIntervalMs);
  }

  return {
    success: false,
    reason: "timeout",
  };
}

export async function getWorkflowRunResult(
  opts: RunOpts,
): Promise<WorkflowRunResult> {
  return pollRun(opts, async (attemptNo) => {
    const fetchWorkflowRunStateResult = await retryOnError(
      async () => fetchWorkflowRunState(opts.runId),
      400,
      "fetchWorkflowRunState",
    );
    if (!fetchWorkflowRunStateResult.success) {
      core.debug(`Failed to fetch run state, attempt ${attemptNo}...`);
      return POLL_PENDING;
    }

    const { status, conclusion } = fetchWorkflowRunStateResult.value;
    return getWorkflowRunStateResult(status, conclusion, attemptNo);
  });
}

export type JobsResult = WorkflowRunJobsResult<WorkflowRunJobState>;

/**
 * The result the awaited Jobs settle on, or pending while they have yet to.
 *
 * A Job absent from `jobs` is only terminal once the run has completed, as
 * until then it may still be created.
 */
export function getWorkflowRunJobsStateResult(
  awaited: string[],
  jobs: WorkflowRunJobState[],
  runCompleted: boolean,
): PollAttempt<JobsResult> {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const concluded: WorkflowRunJobState[] = [];
  const inconclusive: WorkflowRunJobState[] = [];
  const missing: string[] = [];

  for (const name of awaited) {
    const job = byName.get(name);
    if (job?.status !== "completed") {
      missing.push(name);
    } else if (job.conclusion === WorkflowRunConclusion.Success) {
      concluded.push(job);
    } else {
      inconclusive.push(job);
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
 */
export async function getWorkflowRunJobsResult(
  opts: RunOpts & { jobs: string[] },
): Promise<JobsResult> {
  return pollRun(opts, async (attemptNo) => {
    const statesResult = await retryOnError(
      async () =>
        Promise.all([
          fetchWorkflowRunState(opts.runId),
          fetchWorkflowRunJobStates(opts.runId),
        ]),
      400,
      "fetchWorkflowRunJobStates",
    );
    if (!statesResult.success) {
      core.debug(`Failed to fetch run Jobs, attempt ${attemptNo}...`);
      return POLL_PENDING;
    }

    const [runState, jobs] = statesResult.value;
    return getWorkflowRunJobsStateResult(
      opts.jobs,
      jobs,
      runState.status === WorkflowRunStatus.Completed,
    );
  });
}
