import * as core from "@actions/core";

import { getConfig } from "./action.ts";
import * as api from "./api.ts";
import {
  getWorkflowRunJobsResult,
  getWorkflowRunResult,
  handleActionFail,
  type JobsResult,
} from "./await-remote-run.ts";
import * as constants from "./constants.ts";
import { WorkflowRunConclusion } from "./types.ts";

/**
 * Report the awaited Jobs, failing the action unless every one succeeded.
 */
async function handleJobsResult(
  result: JobsResult,
  runId: number,
  startTime: number,
): Promise<void> {
  if (result.success) {
    const names = result.value.map((job) => job.name);
    core.info(
      "Awaited Jobs Completed:\n" +
        `  Run ID: ${runId}\n` +
        `  Jobs: [${names.join(", ")}]`,
    );
    return;
  }

  let failureMsg: string;
  switch (result.reason) {
    case "timeout": {
      const elapsedTime = Date.now() - startTime;
      failureMsg = `Timeout exceeded while attempting to await the Jobs concluding (${elapsedTime}ms)`;
      break;
    }
    case "inconclusive": {
      const failed = result.value
        .map((job) => `${job.name} (${String(job.conclusion)})`)
        .join(", ");
      failureMsg = `Awaited Jobs have concluded unsuccessfully: ${failed}`;
      break;
    }
    case "missing": {
      failureMsg = `Run concluded without the awaited Jobs completing: ${result.value.missing.join(", ")}`;
      break;
    }
  }

  await handleActionFail(failureMsg, runId);
}

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
    const awaiting =
      config.jobs === undefined
        ? `Workflow Run ${config.runId}`
        : `Jobs [${config.jobs.join(", ")}] in Workflow Run ${config.runId}`;
    core.info(
      `Awaiting completion of ${awaiting}...\n` +
        `  ID: ${config.runId}\n` +
        `  URL: ${activeJobUrlResult.success ? activeJobUrlResult.value : runUrl}`,
    );

    const runOpts = {
      startTime,
      pollIntervalMs: config.pollIntervalMs,
      runId: config.runId,
      runTimeoutMs: config.runTimeoutSeconds * 1000,
      cancelTimeoutMs:
        config.cancelTimeoutSeconds === undefined
          ? undefined
          : config.cancelTimeoutSeconds * 1000,
    };

    if (config.jobs !== undefined) {
      const jobsResult = await getWorkflowRunJobsResult({
        ...runOpts,
        jobs: config.jobs,
      });
      await handleJobsResult(jobsResult, config.runId, startTime);
      return;
    }

    // Await the result
    const runResult = await getWorkflowRunResult(runOpts);
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
