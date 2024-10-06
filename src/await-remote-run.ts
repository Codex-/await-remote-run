import * as core from "@actions/core";

import { type ActionConfig } from "./action.ts";
import {
  fetchWorkflowRunFailedJobs,
  fetchWorkflowRunState,
  retryOnError,
  WorkflowRunConclusion,
  WorkflowRunStatus,
} from "./api.ts";
import { sleep } from "./utils.ts";

async function logFailureDetails(runId: number): Promise<void> {
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
  config: ActionConfig;
  startTime: number;
}
export async function run({ config, startTime }: RunOpts): Promise<void> {
  const timeoutMs = config.runTimeoutSeconds * 1000;

  let attemptNo = 0;
  let elapsedTime = Date.now() - startTime;
  while (elapsedTime < timeoutMs) {
    attemptNo++;
    elapsedTime = Date.now() - startTime;

    const fetchWorkflowRunStateResult = await retryOnError(
      async () => fetchWorkflowRunState(config.runId),
      400,
      "fetchWorkflowRunState",
    );
    if (fetchWorkflowRunStateResult.success) {
      const { status, conclusion } = fetchWorkflowRunStateResult.value;

      if (status === WorkflowRunStatus.Completed) {
        switch (conclusion) {
          case WorkflowRunConclusion.Success:
            core.info(
              "Run Completed:\n" +
                `  Run ID: ${config.runId}\n` +
                `  Status: ${status}\n` +
                `  Conclusion: ${conclusion}`,
            );
            return;
          case WorkflowRunConclusion.ActionRequired:
          case WorkflowRunConclusion.Cancelled:
          case WorkflowRunConclusion.Failure:
          case WorkflowRunConclusion.Neutral:
          case WorkflowRunConclusion.Skipped:
          case WorkflowRunConclusion.TimedOut:
            core.error(`Run has failed with conclusion: ${conclusion}`);
            await logFailureDetails(config.runId);
            core.setFailed(conclusion);
            return;
          default:
            core.setFailed(`Unknown conclusion: ${conclusion}`);
            return;
        }
      }
    } else {
      core.debug(`Run has not concluded, attempt ${attemptNo}...`);
    }

    await sleep(config.pollIntervalMs);
  }

  throw new Error(
    `Timeout exceeded while awaiting completion of Run ${config.runId}`,
  );
}
