import * as core from "@actions/core";
import * as github from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils";
import { ActionConfig, getConfig } from "./action";

type Octokit = InstanceType<typeof GitHub>;

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

export interface WorkflowRunState {
  status: WorkflowRunStatus | null;
  conclusion: WorkflowRunConclusion | null;
}

export function init(cfg?: ActionConfig): void {
  config = cfg || getConfig();
  octokit = github.getOctokit(config.token);
}

export async function getWorkflowRunState(
  runId: number
): Promise<WorkflowRunState> {
  try {
    // https://docs.github.com/en/rest/reference/actions#get-a-workflow-run
    const response = await octokit.rest.actions.getWorkflowRun({
      owner: config.owner,
      repo: config.repo,
      run_id: runId,
    });

    if (response.status !== 200) {
      throw new Error(
        `Failed to get Workflow Run state, expected 200 but received ${response.status}`
      );
    }

    core.debug(
      `Fetched Run:\n` +
        `  Repository: ${config.owner}/${config.repo}\n` +
        `  Run ID: ${config.runId}\n` +
        `  Status: ${response.data.status}\n` +
        `  Conclusion: ${response.data.conclusion}`
    );

    return {
      status: response.data.status as WorkflowRunStatus | null,
      conclusion: response.data.conclusion as WorkflowRunConclusion | null,
    };
  } catch (error) {
    core.error(
      `getWorkflowRunState: An unexpected error has occurred: ${error.message}`
    );
    error.stack && core.debug(error.stack);
    throw error;
  }
}
