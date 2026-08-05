/* eslint-disable @typescript-eslint/no-inferrable-types */

/**
 * How long to keep looking for the remote run's active job before giving up
 * and warning.
 *
 * A dispatched run sits queued until a runner picks it up, so it has no active
 * job to link to for the first few seconds of its life. This is set well past
 * typical GitHub-hosted runner start latency so awaiting a run immediately
 * after dispatching it does not warn about a run that is merely waiting to
 * start.
 */
export const WORKFLOW_RUN_ACTIVE_JOB_TIMEOUT_MS: number = 30_000;

/**
 * How long to wait between attempts to resolve the remote run's active job.
 *
 * The resulting URL is only used for logging, so this trades resolution
 * latency for a request count that stays clear of the API rate limit across
 * the full timeout window above.
 */
export const WORKFLOW_RUN_ACTIVE_JOB_POLL_INTERVAL_MS: number = 1_000;

/**
 * How many response bodies to retain for conditional requests.
 *
 * The action only polls a couple of distinct URLs, so this sits well above
 * what a run needs and exists to bound memory should that ever change.
 */
export const ETAG_CACHE_MAX_ENTRIES: number = 16;
