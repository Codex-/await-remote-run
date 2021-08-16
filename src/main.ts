import * as core from "@actions/core";
import { getConfig } from "./action";
import {
  getWorkflowRunState,
  init,
  WorkflowRunConclusion,
  WorkflowRunStatus,
} from "./api";

async function run(): Promise<void> {
  try {
    const config = getConfig();
    const startTime = Date.now();
    init(config);

    const timeoutMs = config.runTimeoutSeconds * 1000;
    let attemptNo = 0;
    let elapsedTime = Date.now() - startTime;
    core.info(`Awaiting completion of Workflow Run ${config.runId}...`);
    while (elapsedTime < timeoutMs) {
      attemptNo++;
      elapsedTime = Date.now() - startTime;

      core.info(
        `Exhausted searching IDs in known runs, attempt ${attemptNo}...`
      );

      const { status, conclusion } = await getWorkflowRunState(config.runId);

      if (status === WorkflowRunStatus.Completed) {
        switch (conclusion) {
          case WorkflowRunConclusion.Success:
            return;
          case WorkflowRunConclusion.ActionRequired:
          case WorkflowRunConclusion.Cancelled:
          case WorkflowRunConclusion.Failure:
          case WorkflowRunConclusion.Neutral:
          case WorkflowRunConclusion.Skipped:
          case WorkflowRunConclusion.TimedOut:
            core.setFailed(conclusion);
            return;
          default:
            core.setFailed(`Unknown conclusion: ${conclusion}`);
            return;
        }
      }

      await new Promise((resolve) =>
        setTimeout(resolve, config.pollIntervalMs)
      );
    }

    throw new Error("Timeout exceeded while attempting to get Run ID");
  } catch (error) {
    core.error(`Failed to complete: ${error.message}`);
    core.warning("Does the token have the correct permissions?");
    error.stack && core.debug(error.stack);
    core.setFailed(error.message);
  }
}

(() => run())();
