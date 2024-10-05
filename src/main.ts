import * as core from "@actions/core";

import { getConfig } from "./action.ts";
import * as api from "./api.ts";
import { run } from "./await-remote-run.ts";
import * as constants from "./constants.ts";

async function main(): Promise<void> {
  const startTime = Date.now();

  const config = getConfig();
  api.init(config);

  const activeJobUrl = await api.getWorkflowRunActiveJobUrlRetry(
    config.runId,
    constants.WORKFLOW_RUN_ACTIVE_JOB_TIMEOUT_MS,
  );
  core.info(
    `Awaiting completion of Workflow Run ${config.runId}...\n` +
      `  ID: ${config.runId}\n` +
      `  URL: ${activeJobUrl}`,
  );

  await run({ config, startTime });
}

if (!process.env.VITEST) {
  await main();
}
