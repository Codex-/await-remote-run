import * as core from "@actions/core";

import {
  fetchWorkflowRunFailedJobs,
  fetchWorkflowRunState,
  requestWorkflowRunCancel,
  retryOnError,
} from "./api.ts";
import {
  WorkflowRunConclusion,
  WorkflowRunStatus,
  type WorkflowRunConclusionResult,
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
 * The result a fetched state resolves to, or undefined while the run has yet to
 * resolve and is worth polling for again.
 */
function getWorkflowRunStateResult(
  status: WorkflowRunStatus | null,
  conclusion: WorkflowRunConclusion | null,
  attemptNo: number,
): WorkflowRunResult | undefined {
  const statusResult = getWorkflowRunStatusResult(status, attemptNo);
  if (!statusResult.success) {
    // An unsupported status may never resolve, unlike a pending one. Alert to
    // raise this so we can handle it properly.
    return statusResult.reason === "unsupported" ? statusResult : undefined;
  }

  // We only get a conclusion should the status resolve, otherwise it is null.
  const conclusionResult = getWorkflowRunConclusionResult(conclusion);
  if (conclusionResult.success || conclusionResult.reason === "inconclusive") {
    return {
      success: true,
      value: {
        status: statusResult.value,
        conclusion: conclusionResult.value,
      },
    };
  }

  if (conclusionResult.reason === "timed_out") {
    return {
      success: false,
      reason: "timeout",
    };
  }

  return {
    success: false,
    reason: "unsupported",
    value: conclusionResult.value,
  };
}

interface RunOpts {
  startTime: number;
  pollIntervalMs: number;
  runId: number;
  runTimeoutMs: number;
  cancelTimeoutMs?: number;
}
export async function getWorkflowRunResult({
  startTime,
  runId,
  runTimeoutMs,
  pollIntervalMs,
  cancelTimeoutMs,
}: RunOpts): Promise<WorkflowRunResult> {
  let attemptNo = 0;
  let cancelRequested = false;
  while (Date.now() - startTime < runTimeoutMs) {
    attemptNo++;

    const fetchWorkflowRunStateResult = await retryOnError(
      async () => fetchWorkflowRunState(runId),
      400,
      "fetchWorkflowRunState",
    );
    if (fetchWorkflowRunStateResult.success) {
      const { status, conclusion } = fetchWorkflowRunStateResult.value;
      const stateResult = getWorkflowRunStateResult(
        status,
        conclusion,
        attemptNo,
      );
      if (stateResult !== undefined) {
        return stateResult;
      }
    } else {
      core.debug(`Failed to fetch run state, attempt ${attemptNo}...`);
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
