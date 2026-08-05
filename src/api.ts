import * as core from "@actions/core";
import * as github from "@actions/github";
import { defaults as githubDefaults } from "@actions/github/lib/utils";

import { type ActionConfig, getConfig } from "./action.ts";
import * as constants from "./constants.ts";
import { withEtagCache } from "./etag/fetch.ts";
import type {
  Result,
  WorkflowRunCancelResult,
  WorkflowRunConclusion,
  WorkflowRunStatus,
} from "./types.ts";
import { sleep } from "./utils.ts";

type Octokit = ReturnType<(typeof github)["getOctokit"]>;

/**
 * The fetch `@actions/github` resolves proxy configuration into.
 *
 * Supplying `request.fetch` replaces the entire `request` defaults object, so
 * this has to be wrapped rather than `globalThis.fetch` for a self-hosted
 * runner behind a proxy to keep working. Octokit types the option as `any`.
 */
const proxyAwareFetch =
  (githubDefaults.request?.fetch as typeof globalThis.fetch | undefined) ??
  globalThis.fetch;

let config: ActionConfig;
let octokit: Octokit;

export function init(cfg?: ActionConfig): void {
  config = cfg ?? getConfig();
  octokit = github.getOctokit(config.token, {
    request: { fetch: withEtagCache(proxyAwareFetch) },
  });
}

interface WorkflowRunState {
  status: WorkflowRunStatus | null;
  conclusion: WorkflowRunConclusion | null;
}

export async function fetchWorkflowRunState(
  runId: number,
): Promise<WorkflowRunState> {
  try {
    // https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run
    const response = await octokit.rest.actions.getWorkflowRun({
      owner: config.owner,
      repo: config.repo,
      run_id: runId,
    });

    // A non-200 is possible, the types aren't the best
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch Workflow Run state, expected 200 but received ${response.status}`,
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
        `fetchWorkflowRunState: An unexpected error has occurred: ${error.message}`,
      );
      core.debug(error.stack ?? "");
    }
    throw error;
  }
}

/**
 * Close-enough effort recreation of the error type Octokit throws for any
 * failed request.
 *
 * This also includes ones that never reach GitHub.
 */
interface HttpError extends Error {
  status: number;
  response?: { headers: Record<string, string | undefined> };
}

function isHttpError(error: unknown): error is HttpError {
  // We'll narrow this type based on the name rather than the actual
  // proto from `@octokit/request-error`. Adding the dependency can
  // cause problematic `instanceof` behaviour if we end up with both
  // the transitive and depended exports being bundled.
  return (
    error instanceof Error &&
    error.name === "HttpError" &&
    "status" in error &&
    typeof error.status === "number"
  );
}

/**
 * Whether a failed request could plausibly succeed if it were tried again.
 */
function isRetryable(error: HttpError): boolean {
  if (error.status >= 500 || error.status === 429) {
    return true;
  }

  // A 403 is either a rate limit or a permission problem, and only the former
  // resolves itself.
  return error.status === 403 && isRateLimited(error);
}

/**
 * Rate limiting is reported as a 403 or a 429, identified by an exhausted
 * remaining count or by being told when to try again.
 * See: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit
 */
function isRateLimited(error: HttpError): boolean {
  const headers = error.response?.headers;
  return (
    headers?.["retry-after"] !== undefined ||
    headers?.["x-ratelimit-remaining"] === "0"
  );
}

/**
 * Attempt requesting GitHub to cancel a given run.
 *
 * As cancellation is asynchronous: a successful result means GitHub accepted the
 * request, not that the run has stopped. The caller's polling is what observes
 * it reaching the `cancelled` conclusion.
 *
 * Cancellation is best-effort, as a result we don't throw.
 */
export async function requestWorkflowRunCancel(
  runId: number,
): Promise<WorkflowRunCancelResult> {
  try {
    // https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run
    const response = await octokit.rest.actions.cancelWorkflowRun({
      owner: config.owner,
      repo: config.repo,
      run_id: runId,
    });

    // A non-202 is possible, the types aren't the best
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (response.status !== 202) {
      throw new Error(
        `Failed to request Workflow Run cancellation, expected 202 but received ${response.status}`,
      );
    }

    core.debug(`Requested cancellation of Workflow Run ${runId}`);
    return { success: true };
  } catch (error) {
    if (isHttpError(error) && !isRetryable(error)) {
      if (error.status === 409) {
        // The only error the API documents, returned for a run it will not
        // cancel, such as one that has already concluded.
        core.info(
          `Workflow Run ${runId} is not in a cancellable state, continuing...`,
        );
      } else {
        // Most likely a token without `actions:write`, or a run it cannot see.
        core.warning(
          `Cancellation of Workflow Run ${runId} was rejected with ${error.status}, not retrying`,
        );
      }
      return { success: false, reason: "rejected" };
    }

    core.warning(
      "requestWorkflowRunCancel: An unexpected error has occurred:\n" +
        `  error: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (error instanceof Error) {
      core.debug(error.stack ?? "");
    }
    return { success: false, reason: "failed" };
  }
}

interface WorkflowRunJob {
  id: number;
  name: string;
  status:
    | "requested"
    | "queued"
    | "pending"
    | "in_progress"
    | "completed"
    | "waiting";
  conclusion: string | null;
  steps: WorkflowRunJobStep[];
  url: string | null;
}

interface WorkflowRunJobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

type ListJobsForWorkflowRunResponse = Awaited<
  ReturnType<Octokit["rest"]["actions"]["listJobsForWorkflowRun"]>
>;

async function fetchWorkflowRunJobs(
  runId: number,
): Promise<ListJobsForWorkflowRunResponse> {
  // https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run
  const response = await octokit.rest.actions.listJobsForWorkflowRun({
    owner: config.owner,
    repo: config.repo,
    run_id: runId,
    filter: "latest",
  });

  // A non-200 is possible, the types aren't the best
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch Jobs for Workflow Run, expected 200 but received ${response.status}`,
    );
  }

  return response;
}

export async function fetchWorkflowRunFailedJobs(
  runId: number,
): Promise<WorkflowRunJob[]> {
  try {
    const response = await fetchWorkflowRunJobs(runId);
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
        `    Job: ${job.name}\n` +
          `      ID: ${job.id}\n` +
          `      Status: ${job.status}\n` +
          `      Conclusion: ${job.conclusion}\n` +
          `      Steps: [${steps.join(", ")}]`,
      );
    }

    return jobs;
  } catch (error) {
    if (error instanceof Error) {
      core.error(
        `fetchWorkflowRunFailedJobs: An unexpected error has occurred: ${error.message}`,
      );
      core.debug(error.stack ?? "");
    }
    throw error;
  }
}

export async function fetchWorkflowRunActiveJobUrl(
  runId: number,
): Promise<string | undefined> {
  try {
    const response = await fetchWorkflowRunJobs(runId);
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
        `fetchWorkflowRunActiveJobUrl: An unexpected error has occurred: ${error.message}`,
      );
      core.debug(error.stack ?? "");
    }
    throw error;
  }
}

export async function fetchWorkflowRunActiveJobUrlRetry(
  runId: number,
  timeout: number,
): Promise<Result<string>> {
  const startTime = Date.now();
  let elapsedTime = Date.now() - startTime;

  while (elapsedTime < timeout) {
    const url = await fetchWorkflowRunActiveJobUrl(runId);
    if (url) {
      return { success: true, value: url };
    }

    core.debug(
      `No 'in_progress' or 'completed' Jobs found for Workflow Run ${runId}, retrying...`,
    );

    await sleep(constants.WORKFLOW_RUN_ACTIVE_JOB_POLL_INTERVAL_MS);
    elapsedTime = Date.now() - startTime;
  }
  core.debug(`Timed out while trying to fetch URL for Workflow Run ${runId}`);

  return { success: false, reason: "timeout" };
}

export async function retryOnError<T>(
  func: () => Promise<T>,
  timeoutMs: number,
  functionName?: string,
): Promise<Result<T>> {
  const startTime = Date.now();

  let elapsedTime = 0;
  while (elapsedTime < timeoutMs) {
    try {
      const value = await func();
      return {
        success: true,
        value: value,
      };
    } catch (error) {
      if (error instanceof Error && Date.now() - startTime < timeoutMs) {
        core.warning(
          "retryOnError: An unexpected error has occurred:\n" +
            `  name: ${functionName ?? (func.name || "anonymous function")}\n` +
            `  error: ${error.message}`,
        );
      }
    }

    await sleep(1000);
    elapsedTime = Date.now() - startTime;
  }

  return {
    success: false,
    reason: "timeout",
  };
}
