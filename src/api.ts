import * as core from "@actions/core";
import * as github from "@actions/github";
import { defaults as githubDefaults } from "@actions/github/lib/utils";

import { type ActionConfig, getConfig } from "./action.ts";
import * as constants from "./constants.ts";
import { withEtagCache } from "./etag/fetch.ts";
import {
  type Result,
  type ResultUnrecoverable,
  type WorkflowRunCancelResult,
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

/**
 * Both are passed through verbatim rather than narrowed to the known enums, so
 * a value GitHub adds reaches the interpretation and is reported as itself.
 */
export interface WorkflowRunState {
  status: string | null;
  conclusion: string | null;
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

    const workflowRunStatus = response.data.status ?? null;
    const workflowRunConclusion = response.data.conclusion ?? null;
    core.debug(
      `Fetched Run:\n` +
        `  Repository: ${config.owner}/${config.repo}\n` +
        `  Run ID: ${runId}\n` +
        `  Status: ${workflowRunStatus}\n` +
        `  Conclusion: ${workflowRunConclusion}`,
    );

    return {
      status: workflowRunStatus,
      conclusion: workflowRunConclusion,
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
 * Whether a failed Jobs lookup for a run may succeed on a later attempt.
 *
 * The Jobs listing lags the run's creation, so a run dispatched moments ago
 * returns a 404 that fixes itself.
 *
 * A token without correct permissions can't will also get a 404, which is
 * indistinguishable, so the caller must limit how long it keeps trying.
 */
function isTransientJobsLookupError(error: unknown): error is HttpError {
  return isHttpError(error) && (error.status === 404 || isRetryable(error));
}

export type RequestFailure = "permanent" | "not_found" | "transient";

/**
 * How a caller that polls should treat a failed request.
 *
 * `permanent` is a 401, or a 403 that is not a rate limit: the credentials or
 * permissions are wrong and no retry can help. `not_found` is a 404, which is a
 * run that does not exist or that the token cannot see, but a freshly
 * dispatched run can also 404 briefly, so the caller decides how long to
 * tolerate it. Everything else is `transient`, including a request that never
 * reached GitHub.
 */
export function classifyRequestFailure(error: unknown): RequestFailure {
  if (!isHttpError(error)) {
    return "transient";
  }

  switch (error.status) {
    case 401: {
      return "permanent";
    }
    case 403: {
      return isRateLimited(error) ? "transient" : "permanent";
    }
    case 404: {
      return "not_found";
    }
    default: {
      return "transient";
    }
  }
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

type ListedJob = ListJobsForWorkflowRunResponse["data"]["jobs"][number];

/**
 * Fetch every Job the run has created.
 *
 * Costs a request per `JOBS_PER_PAGE` Jobs, so prefer
 * `fetchWorkflowRunJobsFirstPage` where any one Job will do.
 */
function fetchWorkflowRunJobs(runId: number): Promise<ListedJob[]> {
  // https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run
  return octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
    owner: config.owner,
    repo: config.repo,
    run_id: runId,
    filter: "latest",
    per_page: constants.JOBS_PER_PAGE,
  });
}

/**
 * Fetch the first page of the run's Jobs.
 *
 * Jobs are listed oldest first, so the earliest to start are here.
 */
async function fetchWorkflowRunJobsFirstPage(
  runId: number,
): Promise<ListedJob[]> {
  // https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run
  const response = await octokit.rest.actions.listJobsForWorkflowRun({
    owner: config.owner,
    repo: config.repo,
    run_id: runId,
    filter: "latest",
    per_page: constants.JOBS_PER_PAGE,
  });

  return response.data.jobs;
}

/**
 * Fetch the run's Jobs that concluded unsuccessfully, for failure diagnostics.
 *
 * Skipped Jobs are excluded, as they carry no diagnostic detail and would bury
 * the causal failure.
 */
export async function fetchWorkflowRunFailedJobs(
  runId: number,
): Promise<WorkflowRunJob[]> {
  try {
    const fetchedFailedJobs = (await fetchWorkflowRunJobs(runId)).filter(
      (job) =>
        job.status === "completed" &&
        job.conclusion !== "success" &&
        job.conclusion !== "skipped",
    );

    if (fetchedFailedJobs.length <= 0) {
      core.info(`Found no unsuccessful Jobs for Workflow Run ${runId}`);
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
        `  Run ID: ${runId}\n` +
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

export interface WorkflowRunJobState {
  name: string;
  status: ListedJob["status"];
  conclusion: ListedJob["conclusion"];
}

/**
 * Fetch the state of every Job the run has created so far.
 *
 * Jobs appear as they become eligible, so one blocked on `needs` is absent
 * rather than pending.
 */
export async function fetchWorkflowRunJobStates(
  runId: number,
): Promise<WorkflowRunJobState[]> {
  try {
    const jobs = (await fetchWorkflowRunJobs(runId)).map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
    }));

    const jobStates = jobs.map(
      (job) => `${job.name} (${job.status}, ${job.conclusion})`,
    );
    core.debug(
      `Fetched Job states for Run:\n` +
        `  Repository: ${config.owner}/${config.repo}\n` +
        `  Run ID: ${runId}\n` +
        `  Jobs: [${jobStates.join(", ")}]`,
    );

    return jobs;
  } catch (error) {
    if (error instanceof Error) {
      core.error(
        `fetchWorkflowRunJobStates: An unexpected error has occurred: ${error.message}`,
      );
      core.debug(error.stack ?? "");
    }
    throw error;
  }
}

/**
 * The URL of the run's first active Job.
 *
 * Resolves to `undefined` while the run has no active Job yet, and to `null`
 * when GitHub returned the Job without a URL, which retrying cannot change.
 */
export async function fetchWorkflowRunActiveJobUrl(
  runId: number,
): Promise<string | null | undefined> {
  try {
    const fetchedInProgressJobs = (
      await fetchWorkflowRunJobsFirstPage(runId)
    ).filter(
      (job) => job.status === "in_progress" || job.status === "completed",
    );

    const inProgressJobs = fetchedInProgressJobs.map(
      (job) => `${job.name} (${job.status})`,
    );
    core.debug(
      `Fetched Jobs for Run:\n` +
        `  Repository: ${config.owner}/${config.repo}\n` +
        `  Run ID: ${runId}\n` +
        `  Jobs: [${inProgressJobs.join(", ")}]`,
    );

    return fetchedInProgressJobs[0]?.html_url;
  } catch (error) {
    if (error instanceof Error && !isTransientJobsLookupError(error)) {
      core.error(
        `fetchWorkflowRunActiveJobUrl: An unexpected error has occurred: ${error.message}`,
      );
      core.debug(error.stack ?? "");
    }
    throw error;
  }
}

/**
 * Resolve the URL of the run's first active Job, polling until one exists or
 * `timeout` elapses.
 *
 * A transient lookup failure is treated the same as the run having no active
 * Job yet. Any other failure ends the lookup as unrecoverable rather than
 * throwing, as the URL is only used for logging and the caller's own fetches
 * will surface the problem.
 */
export async function fetchWorkflowRunActiveJobUrlRetry(
  runId: number,
  timeout: number,
): Promise<Result<string> | ResultUnrecoverable> {
  const startTime = Date.now();
  let elapsedTime = Date.now() - startTime;

  while (elapsedTime < timeout) {
    try {
      const url = await fetchWorkflowRunActiveJobUrl(runId);
      if (url === null) {
        core.debug(
          `Active Job for Workflow Run ${runId} has no URL, giving up on it`,
        );
        return { success: false, reason: "unsupported", value: "null" };
      }
      if (url !== undefined) {
        return { success: true, value: url };
      }

      core.debug(
        `No 'in_progress' or 'completed' Jobs found for Workflow Run ${runId}, retrying...`,
      );
    } catch (error) {
      if (!isTransientJobsLookupError(error)) {
        core.debug(
          `Giving up on the URL for Workflow Run ${runId}, the request cannot succeed`,
        );
        return {
          success: false,
          reason: "unrecoverable",
          value: error instanceof Error ? error.message : String(error),
        };
      }

      core.debug(
        `Jobs for Workflow Run ${runId} are not yet available (${error.status}), retrying...`,
      );
    }

    await sleep(constants.WORKFLOW_RUN_ACTIVE_JOB_POLL_INTERVAL_MS);
    elapsedTime = Date.now() - startTime;
  }
  core.debug(`Timed out while trying to fetch URL for Workflow Run ${runId}`);

  return { success: false, reason: "timeout" };
}
