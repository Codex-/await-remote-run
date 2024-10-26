import * as core from "@actions/core";

import { type ActionConfig } from "./action.ts";
import {
  fetchWorkflowRunFailedJobs,
  fetchWorkflowRunState,
  retryOnError,
  WorkflowRunConclusion,
  WorkflowRunStatus,
} from "./api.ts";
import type { Result } from "./types.ts";
import { sleep } from "./utils.ts";

function getWorkflowRunStatusResult(
  status: WorkflowRunStatus | null,
  attemptNo: number,
): Result<WorkflowRunStatus> {
  if (status === WorkflowRunStatus.Queued) {
    core.debug(`Run is queued to begin, attempt ${attemptNo}...`);
  } else if (status === WorkflowRunStatus.InProgress) {
    core.debug(`Run is in progress, attempt ${attemptNo}...`);
  } else if (status === WorkflowRunStatus.Completed) {
    core.debug("Run has completed");
    return { success: true, value: status };
  }
  return { success: false, reason: "inconclusive" };
}

function getWorkflowRunConclusionResult(
  conclusion: WorkflowRunConclusion | null,
): Result<WorkflowRunConclusion> {
  switch (conclusion) {
    case WorkflowRunConclusion.Success:
      return { success: true, value: conclusion };
    case WorkflowRunConclusion.ActionRequired:
    case WorkflowRunConclusion.Cancelled:
    case WorkflowRunConclusion.Failure:
    case WorkflowRunConclusion.Neutral:
    case WorkflowRunConclusion.Skipped:
    case WorkflowRunConclusion.TimedOut:
      core.error(`Run has failed with conclusion: ${conclusion}`);
      return { success: false, reason: "timeout" };
    default:
      core.error(`Run has failed with unsupported conclusion: ${conclusion}`);
      core.info("Please open an issue with this conclusion value");
      return { success: false, reason: "unsupported" };
  }
}

export function handleActionSuccess(
  runId: number,
  conclusion: WorkflowRunConclusion,
): void {
  core.info(
    "Run Completed:\n" +
      `  Run ID: ${runId}\n` +
      `  Status: ${WorkflowRunStatus.Completed}\n` +
      `  Conclusion: ${conclusion}`,
  );
}

export async function handleActionFail(
  failureMsg: string,
  runId: number,
): Promise<void> {
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
  core.error(`Failed: ${failureMsg}`);
  core.setFailed(failureMsg);
}

interface RunOpts {
  startTime: number;
  config: ActionConfig;
}
export async function getWorkflowRunResult({
  startTime,
  config,
}: RunOpts): Promise<
  Result<{ status: WorkflowRunStatus; conclusion: WorkflowRunConclusion }>
> {
  const timeoutMs = config.runTimeoutSeconds * 1000;

  let attemptNo = 0;
  let elapsedTime = Date.now() - startTime;
  while (elapsedTime < timeoutMs) {
    attemptNo++;

    const fetchWorkflowRunStateResult = await retryOnError(
      async () => fetchWorkflowRunState(config.runId),
      400,
      "fetchWorkflowRunState",
    );
    if (fetchWorkflowRunStateResult.success) {
      const { status, conclusion } = fetchWorkflowRunStateResult.value;
      const statusResult = getWorkflowRunStatusResult(status, attemptNo);
      if (statusResult.success) {
        const conclusionResult = getWorkflowRunConclusionResult(conclusion);

        if (conclusionResult.success) {
          return {
            success: true,
            value: {
              status: statusResult.value,
              conclusion: conclusionResult.value,
            },
          };
        } else {
          return conclusionResult;
        }
      }
    } else {
      core.debug(`Run has not yet been identified, attempt ${attemptNo}...`);
    }

    await sleep(config.pollIntervalMs);
    elapsedTime = Date.now() - startTime;
  }

  return {
    success: false,
    reason: "timeout",
  };
}
