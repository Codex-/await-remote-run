import * as core from "@actions/core";

const RUN_TIMEOUT_SECONDS = 5 * 60;
const POLL_INTERVAL_MS = 5000;

/**
 * action.yaml definition.
 */
export interface ActionConfig {
  /**
   * GitHub API token for making requests.
   */
  token: string;

  /**
   * Repository of the action to await.
   */
  repo: string;

  /**
   * Owner of the given repository.
   */
  owner: string;

  /**
   * Run ID to await the completion of.
   */
  runId: number;

  /**
   * Time until giving up on the completion of an action.
   * @default 300
   */
  runTimeoutSeconds: number;

  /**
   * Time until requesting cancellation of the remote run.
   *
   * Must be less than `runTimeoutSeconds`.
   *
   * @default undefined
   */
  cancelTimeoutSeconds?: number;

  /**
   * Frequency to poll the action for a status.
   * @default 5000
   */
  pollIntervalMs: number;

  /**
   * Names of Jobs to await, instead of the whole run.
   *
   * Matched against the name GitHub reports, not the workflow's job key.
   *
   * @example
   * ```yaml
   * jobs: |
   *   build
   *   test (ubuntu-latest, 20)
   *   lint / eslint
   * ```
   * Parses to `["build", "test (ubuntu-latest, 20)", "lint / eslint"]`: a
   * plain Job, a matrix Job, and a reusable workflow call.
   *
   * @default undefined
   */
  jobs?: string[];
}

export function getConfig(): ActionConfig {
  const runTimeoutSeconds =
    getPositiveIntegerInput("run_timeout_seconds") ?? RUN_TIMEOUT_SECONDS;
  const cancelTimeoutSeconds = getPositiveIntegerInput(
    "cancel_timeout_seconds",
  );

  // Cancellation is requested from the polling loop, so a cancel timeout at
  // or beyond the run timeout would never fire.
  if (
    cancelTimeoutSeconds !== undefined &&
    cancelTimeoutSeconds >= runTimeoutSeconds
  ) {
    throw new TypeError(
      `cancel_timeout_seconds (${cancelTimeoutSeconds}) must be less than run_timeout_seconds (${runTimeoutSeconds}).`,
    );
  }

  return {
    token: core.getInput("token", { required: true }),
    repo: core.getInput("repo", { required: true }),
    owner: core.getInput("owner", { required: true }),
    runId: getRunIdInput(),
    runTimeoutSeconds,
    cancelTimeoutSeconds,
    pollIntervalMs:
      getPositiveIntegerInput("poll_interval_ms") ?? POLL_INTERVAL_MS,
    jobs: getJobsFromValue(core.getInput("jobs")),
  };
}

/**
 * Split on newlines only, as a matrix Job carries commas in its name.
 */
function getJobsFromValue(value: string): string[] | undefined {
  const jobs = new Set(
    value
      .split("\n")
      .map((job) => job.trim())
      .filter((job) => job !== ""),
  );

  return jobs.size > 0 ? [...jobs] : undefined;
}

function getRunIdInput(): number {
  const id = getPositiveIntegerInput("run_id");
  if (id === undefined) {
    throw new TypeError("Run ID must be provided.");
  }
  return id;
}

/**
 * A positive integer input, or `undefined` when it is unset.
 *
 * Parsing is strict rather than `parseInt`, so `1.5` or `5s` is rejected
 * instead of being silently truncated to `1` or `5`.
 */
function getPositiveIntegerInput(name: string): number | undefined {
  const value = core.getInput(name);
  if (value === "") {
    return undefined;
  }

  if (!/^[+-]?\d+$/.test(value)) {
    throw new TypeError(`Unable to parse ${name}: ${value}`);
  }

  const num = Number(value);
  if (num <= 0) {
    throw new TypeError(`${name} (${num}) must be a positive number.`);
  }

  return num;
}
