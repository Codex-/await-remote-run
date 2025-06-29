import * as core from "@actions/core";
import * as github from "@actions/github";

import { type ActionConfig, getConfig } from "./action.ts";
import { withEtag } from "./etags.js";

type Octokit = ReturnType<(typeof github)["getOctokit"]>;

let config: ActionConfig;
let octokit: Octokit;

export enum WorkflowRunStatus {
  Queued = "queued",
  InProgress = "in_progress",
  Completed = "completed",
}

export enum WorkflowRunConclusion {
  Success = "success",
  Failure = "failure",
  Neutral = "neutral",
  Cancelled = "cancelled",
  Skipped = "skipped",
  TimedOut = "timed_out",
  ActionRequired = "action_required",
}

export function init(cfg?: ActionConfig): void {
  config = cfg ?? getConfig();
  octokit = github.getOctokit(config.token);
}

export interface WorkflowRunState {
  status: WorkflowRunStatus | null;
  conclusion: WorkflowRunConclusion | null;
}

export async function getWorkflowRunState(
  runId: number,
): Promise<WorkflowRunState> {
  try {
    const response = await withEtag(
      "getWorkflowRun",
      {
        owner: config.owner,
        repo: config.repo,
        run_id: runId,
      },
      async (params) => {
        // https://docs.github.com/en/rest/reference/actions#get-a-workflow-run
        return await octokit.rest.actions.getWorkflowRun(params);
      },
    );

    if (response.status !== 200) {
      throw new Error(
        `Failed to get Workflow Run state, expected 200 but received ${response.status}`,
      );
    }

    core.debug(
      `Fetched Run:\n` +
        `  Repository: ${config.owner}/${config.repo}\n` +
        `  Run ID: ${runId}\n` +
        `  Status: ${response.data.status}\n` +
        `  Conclusion: ${response.data.conclusion}`,
    );

    return {
      status: response.data.status as WorkflowRunStatus | null,
      conclusion: response.data.conclusion as WorkflowRunConclusion | null,
    };
  } catch (error) {
    if (error instanceof Error) {
      core.error(
        `getWorkflowRunState: An unexpected error has occurred: ${error.message}`,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      error.stack && core.debug(error.stack);
    }
    throw error;
  }
}

export interface WorkflowRunJob {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | "waiting";
  conclusion: string | null;
  steps: WorkflowRunJobStep[];
  url: string | null;
}

export interface WorkflowRunJobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;
type ListJobsForWorkflowRunResponse = Awaited<
  ReturnType<Octokit["rest"]["actions"]["listJobsForWorkflowRun"]>
>;

async function getWorkflowRunJobs(
  runId: number,
): Promise<ListJobsForWorkflowRunResponse> {
  // https://docs.github.com/en/rest/reference/actions#list-jobs-for-a-workflow-run
  const response = await octokit.rest.actions.listJobsForWorkflowRun({
    owner: config.owner,
    repo: config.repo,
    run_id: runId,
    filter: "latest",
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (response.status !== 200) {
    throw new Error(
      `Failed to get Jobs for Workflow Run, expected 200 but received ${response.status}`,
    );
  }

  return response;
}

export async function getWorkflowRunFailedJobs(
  runId: number,
): Promise<WorkflowRunJob[]> {
  try {
    const response = await getWorkflowRunJobs(runId);
    const fetchedFailedJobs = response.data.jobs.filter(
      (job) => job.conclusion === "failure",
    );

    if (fetchedFailedJobs.length <= 0) {
      core.warning(`Failed to find failed Jobs for Workflow Run ${runId}`);
      return [];
    }

    const jobs: WorkflowRunJob[] = fetchedFailedJobs.map((job) => {
      const steps = job.steps?.map((step) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
      }));

      return {
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        steps: steps ?? [],
        url: job.html_url,
      };
    });

    const runJobs = jobs.map((job) => job.name);
    core.debug(
      `Fetched Jobs for Run:\n` +
        `  Repository: ${config.owner}/${config.repo}\n` +
        `  Run ID: ${config.runId}\n` +
        `  Jobs: [${runJobs.join(", ")}]`,
    );

    for (const job of jobs) {
      const steps = job.steps.map((step) => `${step.number}: ${step.name}`);
      core.debug(
        `  Job: ${job.name}\n` +
          `    ID: ${job.id}\n` +
          `    Status: ${job.status}\n` +
          `    Conclusion: ${job.conclusion}\n` +
          `    Steps: [${steps.join(", ")}]`,
      );
    }

    return jobs;
  } catch (error) {
    if (error instanceof Error) {
      core.error(
        `getWorkflowRunJobFailures: An unexpected error has occurred: ${error.message}`,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      error.stack && core.debug(error.stack);
    }
    throw error;
  }
}

export async function getWorkflowRunActiveJobUrl(
  runId: number,
): Promise<string | undefined> {
  try {
    const response = await getWorkflowRunJobs(runId);
    const fetchedInProgressJobs = response.data.jobs.filter(
      (job) => job.status === "in_progress" || job.status === "completed",
    );

    const inProgressJobs = fetchedInProgressJobs.map(
      (job) => `${job.name} (${job.status})`,
    );
    core.debug(
      `Fetched Jobs for Run:\n` +
        `  Repository: ${config.owner}/${config.repo}\n` +
        `  Run ID: ${config.runId}\n` +
        `  Jobs: [${inProgressJobs.join(", ")}]`,
    );

    if (fetchedInProgressJobs.length <= 0) {
      return undefined;
    }

    return (
      fetchedInProgressJobs[0]?.html_url ?? "GitHub failed to return the URL"
    );
  } catch (error) {
    if (error instanceof Error) {
      core.error(
        `getWorkflowRunActiveJobUrl: An unexpected error has occurred: ${error.message}`,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      error.stack && core.debug(error.stack);
    }
    throw error;
  }
}

export async function getWorkflowRunActiveJobUrlRetry(
  runId: number,
  timeout: number,
): Promise<string> {
  const startTime = Date.now();
  let elapsedTime = Date.now() - startTime;

  while (elapsedTime < timeout) {
    elapsedTime = Date.now() - startTime;
    core.debug(
      `No 'in_progress' or 'completed' Jobs found for Workflow Run ${runId}, retrying...`,
    );

    const url = await getWorkflowRunActiveJobUrl(runId);
    if (url) {
      return url;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  core.debug(`Timed out while trying to fetch URL for Workflow Run ${runId}`);

  return "Unable to fetch URL";
}

export async function retryOnError<T>(
  func: () => Promise<T>,
  name: string,
  timeout = 5000,
): Promise<T> {
  const startTime = Date.now();
  let elapsedTime = Date.now() - startTime;

  while (elapsedTime < timeout) {
    elapsedTime = Date.now() - startTime;
    try {
      return await func();
    } catch (error) {
      if (error instanceof Error) {
        // We now exceed the time, so throw the error up
        if (Date.now() - startTime >= timeout) {
          throw error;
        }

        core.warning(
          "retryOnError: An unexpected error has occurred:\n" +
            `  name: ${name}\n` +
            `  error: ${error.message}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error(`Timeout exceeded while attempting to retry ${name}`);
}
