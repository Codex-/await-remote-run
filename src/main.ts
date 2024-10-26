import * as core from "@actions/core";

import { getConfig } from "./action.ts";
import * as api from "./api.ts";
import {
  getWorkflowRunResult,
  handleActionFail,
  handleActionSuccess,
} from "./await-remote-run.ts";
import * as constants from "./constants.ts";

async function main(): Promise<void> {
  try {
    const startTime = Date.now();

    const config = getConfig();
    api.init(config);

    const activeJobUrl = await api.fetchWorkflowRunActiveJobUrlRetry(
      config.runId,
      constants.WORKFLOW_RUN_ACTIVE_JOB_TIMEOUT_MS,
    );
    core.info(
      `Awaiting completion of Workflow Run ${config.runId}...\n` +
        `  ID: ${config.runId}\n` +
        `  URL: ${activeJobUrl}`,
    );

    const result = await getWorkflowRunResult({
      startTime,
      pollIntervalMs: config.pollIntervalMs,
      runId: config.runId,
      runTimeoutMs: config.runTimeoutSeconds * 1000,
    });
    if (result.success) {
      handleActionSuccess(config.runId, result.value.conclusion);
    } else {
      const elapsedTime = Date.now() - startTime;
      const failureMsg =
        result.reason === "timeout"
          ? `Timeout exceeded while attempting to await run conclusion (${elapsedTime}ms)`
          : result.reason === "inconclusive"
            ? "Run was inconclusive"
            : "Unsupported conclusion was returned";
      await handleActionFail(failureMsg, config.runId);
    }
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
