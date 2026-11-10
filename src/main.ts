import * as core from "@actions/core";
import * as github from "@actions/github";

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
    case "unrecoverable": {
      failureMsg = `Unable to fetch Workflow Run ${runId}, giving up: ${result.value}`;
      break;
    }
  }

  await handleActionFail(failureMsg, runId);
}

export async function main(): Promise<void> {
  try {
    const config = getConfig();
    api.init(config);

    // The active job URL is only used for logging, so a lookup that fails for
    // any reason is warned about and the run is awaited regardless.
    const activeJobUrlResult = await api.fetchWorkflowRunActiveJobUrlRetry(
      config.runId,
      constants.WORKFLOW_RUN_ACTIVE_JOB_TIMEOUT_MS,
    );
    if (!activeJobUrlResult.success) {
      core.warning(
        `Unable to fetch active job URL (reason: ${activeJobUrlResult.reason}), continuing...`,
      );
    }
    const runUrl = `${github.context.serverUrl}/${config.owner}/${config.repo}/actions/runs/${config.runId}`;
    const awaiting =
      config.jobs === undefined
        ? `Workflow Run ${config.runId}`
        : `Jobs [${config.jobs.join(", ")}] in Workflow Run ${config.runId}`;
    core.info(
      `Awaiting completion of ${awaiting}...\n` +
        `  ID: ${config.runId}\n` +
        `  URL: ${activeJobUrlResult.success ? activeJobUrlResult.value : runUrl}`,
    );

    // Resolving the active job URL can take up to its own timeout, so the
    // run timeout only starts counting once polling for the run does.
    const startTime = Date.now();
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
      let failureMsg: string;
      switch (runResult.reason) {
        case "timeout": {
          const elapsedTime = Date.now() - startTime;
          failureMsg = `Timeout exceeded while attempting to await run conclusion (${elapsedTime}ms)`;
          break;
        }
        case "unsupported": {
          failureMsg = `An unsupported value was reached: ${runResult.value}`;
          break;
        }
        case "unrecoverable": {
          failureMsg = `Unable to fetch Workflow Run ${config.runId}, giving up: ${runResult.value}`;
          break;
        }
      }
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
      core.debug(error.stack ?? "");
    } else {
      const failureMsg = `Failed: An unknown error has occurred: ${String(error)}`;
      core.setFailed(failureMsg);
      core.debug(String(error));
    }
  }
}
