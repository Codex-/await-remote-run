import * as core from "@actions/core";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import * as action from "./action.ts";
import * as api from "./api.ts";
import * as awaitRemoteRun from "./await-remote-run.ts";
import * as constants from "./constants.ts";
import { main } from "./main.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";
import { WorkflowRunConclusion, WorkflowRunStatus } from "./types.ts";

vi.mock("@actions/core");
vi.mock("./action.ts");
vi.mock("./api.ts");
vi.mock("./await-remote-run.ts");

describe("main", () => {
  const {
    coreDebugLogMock,
    coreErrorLogMock,
    coreInfoLogMock,
    coreWarningLogMock,
    assertOnlyCalled,
  } = mockLoggingFunctions();
  const testCfg: action.ActionConfig = {
    token: "secret",
    repo: "repository",
    owner: "owner",
    runId: 123456,
    runTimeoutSeconds: 300,
    cancelTimeoutSeconds: undefined,
    pollIntervalMs: 2500,
  };

  // Core
  let coreSetFailedMock: MockInstance<typeof core.setFailed>;

  // Action
  let actionGetConfigMock: MockInstance<typeof action.getConfig>;

  // API
  let apiFetchWorkflowRunActiveJobUrlRetry: MockInstance<
    typeof api.fetchWorkflowRunActiveJobUrlRetry
  >;
  let apiInitMock: MockInstance<typeof api.init>;

  // Await Remote Run
  let awaitRemoteRunHandleActionFail: MockInstance<
    typeof awaitRemoteRun.handleActionFail
  >;
  let awaitRemoteRunGetWorkflowRunResult: MockInstance<
    typeof awaitRemoteRun.getWorkflowRunResult
  >;
  let awaitRemoteRunGetWorkflowRunJobsResult: MockInstance<
    typeof awaitRemoteRun.getWorkflowRunJobsResult
  >;

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers();

    coreSetFailedMock = vi.spyOn(core, "setFailed");

    actionGetConfigMock = vi
      .spyOn(action, "getConfig")
      .mockReturnValue(testCfg);

    apiFetchWorkflowRunActiveJobUrlRetry = vi.spyOn(
      api,
      "fetchWorkflowRunActiveJobUrlRetry",
    );
    apiInitMock = vi.spyOn(api, "init");

    awaitRemoteRunHandleActionFail = vi.spyOn(
      awaitRemoteRun,
      "handleActionFail",
    );
    awaitRemoteRunGetWorkflowRunResult = vi.spyOn(
      awaitRemoteRun,
      "getWorkflowRunResult",
    );
    awaitRemoteRunGetWorkflowRunJobsResult = vi.spyOn(
      awaitRemoteRun,
      "getWorkflowRunJobsResult",
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("should successfully complete", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: true,
      value: "test-url",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: true,
      value: {
        status: WorkflowRunStatus.Completed,
        conclusion: WorkflowRunConclusion.Success,
      },
    });

    await main();

    // Behaviour
    // Setup
    expect(actionGetConfigMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledWith(testCfg);

    // Active Job URL
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledOnce();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledWith(
      testCfg.runId,
      constants.WORKFLOW_RUN_ACTIVE_JOB_TIMEOUT_MS,
    );

    // Run Result
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledWith({
      startTime: Date.now(),
      pollIntervalMs: testCfg.pollIntervalMs,
      runId: testCfg.runId,
      runTimeoutMs: testCfg.runTimeoutSeconds * 1000,
      cancelTimeoutMs: undefined,
    });

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

    // Logging
    assertOnlyCalled(coreInfoLogMock);
    expect(coreInfoLogMock).toHaveBeenCalledTimes(2);
    expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
      "Awaiting completion of Workflow Run 123456...
        ID: 123456
        URL: test-url"
    `);
    expect(coreInfoLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(`
      "Run Completed:
        Run ID: 123456
        Status: completed
        Conclusion: success"
    `);
  });

  it("should pass the cancel timeout through when configured", async () => {
    actionGetConfigMock.mockReturnValue({
      ...testCfg,
      cancelTimeoutSeconds: 120,
    });
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: true,
      value: "test-url",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: true,
      value: {
        status: WorkflowRunStatus.Completed,
        conclusion: WorkflowRunConclusion.Success,
      },
    });

    await main();

    // Behaviour
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledWith({
      startTime: Date.now(),
      pollIntervalMs: testCfg.pollIntervalMs,
      runId: testCfg.runId,
      runTimeoutMs: testCfg.runTimeoutSeconds * 1000,
      cancelTimeoutMs: 120_000,
    });

    // Logging
    assertOnlyCalled(coreInfoLogMock);
  });

  describe("awaiting specific jobs", () => {
    const jobsCfg: action.ActionConfig = { ...testCfg, jobs: ["build"] };
    const succeeded = {
      name: "build",
      status: "completed" as const,
      conclusion: "success" as const,
    };

    beforeEach(() => {
      actionGetConfigMock.mockReturnValue(jobsCfg);
      apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
        success: true,
        value: "test-url",
      });
    });

    it("should await the named jobs rather than the run", async () => {
      awaitRemoteRunGetWorkflowRunJobsResult.mockResolvedValue({
        success: true,
        value: [succeeded],
      });

      await main();

      // Behaviour
      expect(awaitRemoteRunGetWorkflowRunJobsResult).toHaveBeenCalledOnce();
      expect(awaitRemoteRunGetWorkflowRunJobsResult).toHaveBeenCalledWith({
        startTime: Date.now(),
        pollIntervalMs: jobsCfg.pollIntervalMs,
        runId: jobsCfg.runId,
        runTimeoutMs: jobsCfg.runTimeoutSeconds * 1000,
        cancelTimeoutMs: undefined,
        jobs: ["build"],
      });
      expect(awaitRemoteRunGetWorkflowRunResult).not.toHaveBeenCalled();

      // Result
      expect(coreSetFailedMock).not.toHaveBeenCalled();
      expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

      // Logging
      assertOnlyCalled(coreInfoLogMock);
      expect(coreInfoLogMock).toHaveBeenCalledTimes(2);
      expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
        "Awaiting completion of Jobs [build] in Workflow Run 123456...
          ID: 123456
          URL: test-url"
      `);
      expect(coreInfoLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(`
        "Awaited Jobs Completed:
          Run ID: 123456
          Jobs: [build]"
      `);
    });

    it("should fail when a named job concludes unsuccessfully", async () => {
      awaitRemoteRunGetWorkflowRunJobsResult.mockResolvedValue({
        success: false,
        reason: "inconclusive",
        value: [{ ...succeeded, conclusion: "failure" }],
      });

      await main();

      // Behaviour
      expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
      expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
        "Awaited Jobs have concluded unsuccessfully: build (failure)",
        jobsCfg.runId,
      );

      // Logging
      assertOnlyCalled(coreInfoLogMock);
    });

    it("should fail when the run concludes without a named job", async () => {
      awaitRemoteRunGetWorkflowRunJobsResult.mockResolvedValue({
        success: false,
        reason: "missing",
        value: { missing: ["build"], observed: ["biuld"] },
      });

      await main();

      // Behaviour
      expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
      expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
        "Run concluded without the awaited Jobs completing: build",
        jobsCfg.runId,
      );

      // Logging
      assertOnlyCalled(coreInfoLogMock);
    });

    it("should fail on a timeout", async () => {
      awaitRemoteRunGetWorkflowRunJobsResult.mockResolvedValue({
        success: false,
        reason: "timeout",
      });

      await main();

      // Behaviour
      expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
      expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
        "Timeout exceeded while attempting to await the Jobs concluding (0ms)",
        jobsCfg.runId,
      );

      // Logging
      assertOnlyCalled(coreInfoLogMock);
    });

    it("should pass the cancel timeout through when configured", async () => {
      actionGetConfigMock.mockReturnValue({
        ...jobsCfg,
        cancelTimeoutSeconds: 120,
      });
      awaitRemoteRunGetWorkflowRunJobsResult.mockResolvedValue({
        success: true,
        value: [succeeded],
      });

      await main();

      // Behaviour
      expect(awaitRemoteRunGetWorkflowRunJobsResult).toHaveBeenCalledWith(
        expect.objectContaining({ cancelTimeoutMs: 120_000 }),
      );

      // Logging
      assertOnlyCalled(coreInfoLogMock);
    });
  });

  it("should warn and continue if the active job URL fetch times out", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: false,
      reason: "timeout",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: true,
      value: {
        status: WorkflowRunStatus.Completed,
        conclusion: WorkflowRunConclusion.Success,
      },
    });

    await main();

    // Behaviour
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledOnce();
    // URL fetch is best-effort — polling should still run
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();

    // Result — no action failure from the URL fetch
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

    // Logging
    assertOnlyCalled(coreInfoLogMock, coreWarningLogMock);
    expect(coreWarningLogMock).toHaveBeenCalledOnce();
    expect(coreWarningLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Unable to fetch active job URL (reason: timeout), continuing..."`,
    );
    expect(coreInfoLogMock).toHaveBeenCalledTimes(2);
    expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
      "Awaiting completion of Workflow Run 123456...
        ID: 123456
        URL: https://github.com/owner/repository/actions/runs/123456"
    `);
  });

  it("should warn and continue if the active job URL fetch returns unsupported", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: false,
      reason: "unsupported",
      value: "weird-value",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: true,
      value: {
        status: WorkflowRunStatus.Completed,
        conclusion: WorkflowRunConclusion.Success,
      },
    });

    await main();

    // Behaviour
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledOnce();
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

    // Logging
    assertOnlyCalled(coreInfoLogMock, coreWarningLogMock);
    expect(coreWarningLogMock).toHaveBeenCalledOnce();
    expect(coreWarningLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Unable to fetch active job URL (reason: unsupported), continuing..."`,
    );
    expect(coreInfoLogMock).toHaveBeenCalledTimes(2);
    expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
      "Awaiting completion of Workflow Run 123456...
        ID: 123456
        URL: https://github.com/owner/repository/actions/runs/123456"
    `);
  });

  it("should fail if awaiting the run result times out", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: true,
      value: "test-url",
    });
    awaitRemoteRunGetWorkflowRunResult.mockImplementation(() => {
      vi.setSystemTime(Date.now() + 5000);
      return Promise.resolve({ success: false, reason: "timeout" });
    });

    await main();

    // Behaviour
    expect(actionGetConfigMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledOnce();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledOnce();
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
      "Timeout exceeded while attempting to await run conclusion (5000ms)",
      testCfg.runId,
    );

    // Logging
    assertOnlyCalled(coreInfoLogMock);
    expect(coreInfoLogMock).toHaveBeenCalledOnce();
    expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
      "Awaiting completion of Workflow Run 123456...
        ID: 123456
        URL: test-url"
    `);
  });

  it("should fail if awaiting the run result returns unsupported", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: true,
      value: "test-url",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: false,
      reason: "unsupported",
      value: "weird-value",
    });

    await main();

    // Behaviour
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
      "An unsupported value was reached: weird-value",
      testCfg.runId,
    );

    // Logging
    assertOnlyCalled(coreInfoLogMock);
    expect(coreInfoLogMock).toHaveBeenCalledOnce();
  });

  it.each([
    WorkflowRunConclusion.ActionRequired,
    WorkflowRunConclusion.Cancelled,
    WorkflowRunConclusion.Failure,
    WorkflowRunConclusion.Neutral,
    WorkflowRunConclusion.Skipped,
    WorkflowRunConclusion.TimedOut,
    WorkflowRunConclusion.Stale,
    WorkflowRunConclusion.StartupFailure,
  ])(
    "should fail if the run has a non-success conclusion (%s)",
    async (conclusion) => {
      apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
        success: true,
        value: "test-url",
      });
      awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
        success: true,
        value: {
          status: WorkflowRunStatus.Completed,
          conclusion,
        },
      });

      await main();

      // Behaviour
      expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();

      // Result
      expect(coreSetFailedMock).not.toHaveBeenCalled();
      expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
      expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
        `Run has concluded with ${conclusion}`,
        testCfg.runId,
      );

      // Logging - only the "Awaiting completion" info, no "Run Completed"
      assertOnlyCalled(coreInfoLogMock);
      expect(coreInfoLogMock).toHaveBeenCalledOnce();
      expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
        "Awaiting completion of Workflow Run 123456...
          ID: 123456
          URL: test-url"
      `);
    },
  );

  it("should fail for an unhandled error", async () => {
    const testError = new Error("test error");
    actionGetConfigMock.mockImplementation(() => {
      throw testError;
    });

    await main();

    // Behaviour
    expect(actionGetConfigMock).toHaveBeenCalledOnce();

    expect(apiInitMock).not.toHaveBeenCalled();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).not.toHaveBeenCalled();
    expect(awaitRemoteRunGetWorkflowRunResult).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

    expect(coreSetFailedMock).toHaveBeenCalledOnce();
    expect(coreSetFailedMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Failed: An unhandled error has occurred: test error"`,
    );

    // Logging
    assertOnlyCalled(coreDebugLogMock, coreErrorLogMock);
    expect(coreErrorLogMock).toHaveBeenCalledOnce();
    expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Failed: An unhandled error has occurred: test error"`,
    );
    expect(coreDebugLogMock).toHaveBeenCalledOnce();
    expect(coreDebugLogMock.mock.calls[0]?.[0]).toStrictEqual(testError.stack);
  });

  it("should fail for an unhandled unknown", async () => {
    const testError = "some other error";
    actionGetConfigMock.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw testError;
    });

    await main();

    // Behaviour
    expect(actionGetConfigMock).toHaveBeenCalledOnce();

    expect(apiInitMock).not.toHaveBeenCalled();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).not.toHaveBeenCalled();
    expect(awaitRemoteRunGetWorkflowRunResult).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

    expect(coreSetFailedMock).toHaveBeenCalledOnce();
    expect(coreSetFailedMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Failed: An unknown error has occurred: some other error"`,
    );

    // Logging
    assertOnlyCalled(coreDebugLogMock, coreErrorLogMock);
    expect(coreErrorLogMock).toHaveBeenCalledOnce();
    expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Failed: An unknown error has occurred: some other error"`,
    );
    expect(coreDebugLogMock).toHaveBeenCalledOnce();
    expect(coreDebugLogMock.mock.calls[0]?.[0]).toStrictEqual(testError);
  });
});
