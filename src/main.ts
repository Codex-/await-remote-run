import * as core from "@actions/core";

import { getConfig } from "./action.ts";
import * as api from "./api.ts";
import { getWorkflowRunResult, handleActionFail } from "./await-remote-run.ts";
import * as constants from "./constants.ts";
import { WorkflowRunConclusion } from "./types.ts";

export async function main(): Promise<void> {
  try {
    const startTime = Date.now();

    const config = getConfig();
    api.init(config);

    // Attempt to fetch and use the active job URL for logging.
    // If this fails, we'll still attempt to await the run, but
    // cannot log the URL.
    const activeJobUrlResult = await api.fetchWorkflowRunActiveJobUrlRetry(
      config.runId,
      constants.WORKFLOW_RUN_ACTIVE_JOB_TIMEOUT_MS,
    );
    if (!activeJobUrlResult.success) {
      core.warning(
        `Unable to fetch active job URL (reason: ${activeJobUrlResult.reason}), continuing...`,
      );
    }
    const runUrl = `https://github.com/${config.owner}/${config.repo}/actions/runs/${config.runId}`;
    core.info(
      `Awaiting completion of Workflow Run ${config.runId}...\n` +
        `  ID: ${config.runId}\n` +
        `  URL: ${activeJobUrlResult.success ? activeJobUrlResult.value : runUrl}`,
    );

    // Await the result
    const runResult = await getWorkflowRunResult({
      startTime,
      pollIntervalMs: config.pollIntervalMs,
      runId: config.runId,
      runTimeoutMs: config.runTimeoutSeconds * 1000,
      cancelTimeoutMs:
        config.cancelTimeoutSeconds === undefined
          ? undefined
          : config.cancelTimeoutSeconds * 1000,
    });
    if (!runResult.success) {
      const elapsedTime = Date.now() - startTime;
      const failureMsg =
        runResult.reason === "timeout"
          ? `Timeout exceeded while attempting to await run conclusion (${elapsedTime}ms)`
          : `An unsupported value was reached: ${runResult.value}`;
      await handleActionFail(failureMsg, config.runId);
      return;
    }

    const { status, conclusion } = runResult.value;
    if (conclusion === WorkflowRunConclusion.Success) {
      core.info(
        "Run Completed:\n" +
          `  Run ID: ${config.runId}\n` +
          `  Status: ${status}\n` +
          `  Conclusion: ${conclusion}`,
      );
      return;
    }

    await handleActionFail(
      `Run has concluded with ${conclusion}`,
      config.runId,
    );
  } catch (error) {
    if (error instanceof Error) {
      const failureMsg = `Failed: An unhandled error has occurred: ${error.message}`;
      core.setFailed(failureMsg);
      core.error(failureMsg);
      core.debug(error.stack ?? "");
    } else {
      const failureMsg = `Failed: An unknown error has occurred: ${String(error)}`;
      core.setFailed(failureMsg);
      core.error(failureMsg);
      core.debug(String(error));
    }
  }
}
