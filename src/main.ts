import * as core from "@actions/core";

import { getConfig } from "./action.ts";
import * as api from "./api.ts";
import { getWorkflowRunResult, handleActionFail } from "./await-remote-run.ts";
import * as constants from "./constants.ts";
import { WorkflowRunConclusion } from "./types.ts";

async function main(): Promise<void> {
  try {
    const startTime = Date.now();

    const config = getConfig();
    api.init(config);

    const activeJobUrlResult = await api.fetchWorkflowRunActiveJobUrlRetry(
      config.runId,
      constants.WORKFLOW_RUN_ACTIVE_JOB_TIMEOUT_MS,
    );
    if (!activeJobUrlResult.success) {
      const elapsedTime = Date.now() - startTime;
      const failureMsg = `Timeout exceeded while attempting to find the active job run URL (${elapsedTime}ms)`;
      await handleActionFail(failureMsg, config.runId);
      return;
    }
    core.info(
      `Awaiting completion of Workflow Run ${config.runId}...\n` +
        `  ID: ${config.runId}\n` +
        `  URL: ${activeJobUrlResult.value}`,
    );

    const runResult = await getWorkflowRunResult({
      startTime,
      pollIntervalMs: config.pollIntervalMs,
      runId: config.runId,
      runTimeoutMs: config.runTimeoutSeconds * 1000,
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
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      const failureMsg = `Failed: An unknown error has occurred: ${error}`;
      core.setFailed(failureMsg);
      core.error(failureMsg);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      core.debug(error as any);
    }
  }
}

if (!process.env.VITEST) {
  await main();
}
