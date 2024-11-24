import * as core from "@actions/core";

import {
  fetchWorkflowRunFailedJobs,
  fetchWorkflowRunState,
  retryOnError,
} from "./api.ts";
import {
  WorkflowRunConclusion,
  WorkflowRunStatus,
  type Result,
  type WorkflowRunConclusionResult,
  type WorkflowRunStatusResult,
} from "./types.ts";
import { sleep } from "./utils.ts";

export function getWorkflowRunStatusResult(
  status: WorkflowRunStatus | null,
  attemptNo: number,
): WorkflowRunStatusResult {
  if (status === WorkflowRunStatus.Completed) {
    return { success: true, value: status };
  }

  if (status === WorkflowRunStatus.Queued) {
    core.debug(`Run is queued to begin, attempt ${attemptNo}...`);
    return { success: false, reason: "pending", value: status };
  } else if (status === WorkflowRunStatus.InProgress) {
    core.debug(`Run is in progress, attempt ${attemptNo}...`);
    return { success: false, reason: "pending", value: status };
  }

  core.error(`Run status is unsupported: ${status}`);
  core.info("Please open an issue with this status value");
  return { success: false, reason: "unsupported", value: status ?? "null" };
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
      core.error(`Run has failed with conclusion: ${conclusion}`);
      return { success: false, reason: "inconclusive", value: conclusion };
    case WorkflowRunConclusion.TimedOut:
      core.error("Run has timeout out");
      return { success: false, reason: "timeout", value: conclusion };
    default:
      core.error(`Run has failed with unsupported conclusion: ${conclusion}`);
      core.info("Please open an issue with this conclusion value");
      return {
        success: false,
        reason: "unsupported",
        value: conclusion ?? "null",
      };
  }
}

export async function handleActionFail(
  failureMsg: string,
  runId: number,
): Promise<void> {
  core.error(`Failed: ${failureMsg}`);
  core.setFailed(failureMsg);

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
        failedSteps,
    );
  }
}

interface RunOpts {
  startTime: number;
  pollIntervalMs: number;
  runId: number;
  runTimeoutMs: number;
}
export async function getWorkflowRunResult({
  startTime,
  runId,
  runTimeoutMs,
  pollIntervalMs,
}: RunOpts): Promise<
  Result<
    | { status: WorkflowRunStatus.Completed; conclusion: WorkflowRunConclusion }
    | { status: WorkflowRunStatus; conclusion?: WorkflowRunConclusion }
  >
> {
  let attemptNo = 0;
  let elapsedTime = Date.now() - startTime;
  while (elapsedTime < runTimeoutMs) {
    attemptNo++;

    const fetchWorkflowRunStateResult = await retryOnError(
      async () => fetchWorkflowRunState(runId),
      400,
      "fetchWorkflowRunState",
    );
    if (!fetchWorkflowRunStateResult.success) {
      core.debug(`Failed to fetch run state, attempt ${attemptNo}...`);
    } else {
      const { status, conclusion } = fetchWorkflowRunStateResult.value;
      const statusResult = getWorkflowRunStatusResult(status, attemptNo);
      if (statusResult.success) {
        // We only get a conclusion should the status resolve, otherwise it is null.
        const conclusionResult = getWorkflowRunConclusionResult(conclusion);

        return {
          success: true,
          value: {
            status: statusResult.value,
            conclusion: conclusionResult.success
              ? conclusionResult.value
              : undefined,
          },
        };
      }

      // If the status is unsupported, we can't guarantee it will ever
      // resolve. Alert to raise this so we can handle it properly.
      if (statusResult.reason === "unsupported") {
        return statusResult;
      }
    }

    await sleep(pollIntervalMs);
    elapsedTime = Date.now() - startTime;
  }

  return {
    success: false,
    reason: "timeout",
  };
}
