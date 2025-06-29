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
import { main } from "./main.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";
import type { Result } from "./types.ts";
// import * as utils from "./utils.ts";

vi.mock("@actions/core");
vi.mock("./action.ts");
vi.mock("./api.ts");
vi.mock("./await-remote-run.ts");
// vi.mock("./utils.ts");

describe("main", () => {
  const {
    coreDebugLogMock,
    coreErrorLogMock,
    coreInfoLogMock,
    assertOnlyCalled,
  } = mockLoggingFunctions();
  const testCfg: action.ActionConfig = {
    token: "secret",
    repo: "repository",
    owner: "owner",
    runId: 123456,
    runTimeoutSeconds: 300,
    pollIntervalMs: 2500,
  } satisfies Partial<action.ActionConfig> as action.ActionConfig;

  // Core
  let coreSetFailedMock: MockInstance<typeof core.setFailed>;

  // Action
  let actionGetConfigMock: MockInstance<typeof action.getConfig>;

  // API
  let apiFetchWorkflowRunActiveJobUrlRetry: MockInstance<
    typeof api.fetchWorkflowRunActiveJobUrlRetry
  >;
  let apiInitMock: MockInstance<typeof api.init>;

  // Utils
  // let utilsSleepMock: MockInstance<typeof utils.sleep>;

  // Await Remote Run
  let awaitRemoteRunGetWorkflowRunStatusResult: MockInstance<
    typeof awaitRemoteRun.getWorkflowRunStatusResult
  >;
  let awaitRemoteRunGetWorkflowRunConclusionResult: MockInstance<
    typeof awaitRemoteRun.getWorkflowRunConclusionResult
  >;
  let awaitRemoteRunHandleActionFail: MockInstance<
    typeof awaitRemoteRun.handleActionFail
  >;
  let awaitRemoteRunGetWorkflowRunResult: MockInstance<
    typeof awaitRemoteRun.getWorkflowRunResult
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

    // utilsGetBranchNameMock = vi.spyOn(utils, "getBranchName");
    // utilsLogInfoForBranchNameResult = vi.spyOn(
    //   utils,
    //   "logInfoForBranchNameResult",
    // );
    // utilsCreateDistinctIdRegexMock = vi.spyOn(utils, "createDistinctIdRegex");

    awaitRemoteRunGetWorkflowRunStatusResult = vi.spyOn(
      awaitRemoteRun,
      "getWorkflowRunStatusResult",
    );
    awaitRemoteRunGetWorkflowRunConclusionResult = vi.spyOn(
      awaitRemoteRun,
      "getWorkflowRunConclusionResult",
    );
    awaitRemoteRunHandleActionFail = vi.spyOn(
      awaitRemoteRun,
      "handleActionFail",
    );
    awaitRemoteRunGetWorkflowRunResult = vi.spyOn(
      awaitRemoteRun,
      "getWorkflowRunResult",
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("should successfully complete", async () => {
    // const distinctIdRegex = new RegExp(testCfg.distinctId);
    // const returnDispatchSuccessResult = {
    //   success: true,
    //   value: {
    //     id: 0,
    //     url: "test-url",
    //   },
    // } as const;

    // utilsCreateDistinctIdRegexMock.mockReturnValue(distinctIdRegex);
    // returnDispatchGetWorkflowIdMock.mockResolvedValue(0);
    // returnDispatchGetRunIdAndUrlMock.mockResolvedValue(
    //   returnDispatchSuccessResult,
    // );
    const apiFetchWorkflowRunActiveJobUrlRetryResult: Result<string> = {
      success: true,
      value: "test-url",
    };
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue(
      apiFetchWorkflowRunActiveJobUrlRetryResult,
    );

    await main();

    // Behaviour
    // Setup
    expect(actionGetConfigMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledWith(testCfg);

    // Active Job URL
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledOnce();

    // Workflow ID
    // expect(returnDispatchGetWorkflowIdMock).toHaveBeenCalledOnce();
    // expect(returnDispatchGetWorkflowIdMock).toHaveBeenCalledWith(
    //   testCfg.workflow,
    // );

    // Dispatch
    // expect(apiDispatchWorkflowMock).toHaveBeenCalledOnce();
    // expect(apiDispatchWorkflowMock).toHaveBeenCalledWith(testCfg.distinctId);

    // Branch name
    // expect(utilsGetBranchNameMock).toHaveBeenCalledOnce();
    // expect(utilsGetBranchNameMock).toHaveBeenCalledWith(testCfg.ref);
    // expect(utilsLogInfoForBranchNameResult).toHaveBeenCalledOnce();
    // expect(utilsLogInfoForBranchNameResult).toHaveBeenCalledWith(
    //   testBranch,
    //   testCfg.ref,
    // );
    // expect(utilsCreateDistinctIdRegexMock).toHaveBeenCalledOnce();
    // expect(utilsCreateDistinctIdRegexMock).toHaveBeenCalledWith(
    //   testCfg.distinctId,
    // );

    // Get run ID
    // expect(returnDispatchGetRunIdAndUrlMock).toHaveBeenCalledOnce();
    // expect(returnDispatchGetRunIdAndUrlMock).toHaveBeenCalledWith({
    //   startTime: Date.now(),
    //   branch: testBranch,
    //   distinctIdRegex: distinctIdRegex,
    //   workflowId: 0,
    //   workflowTimeoutMs: testCfg.workflowTimeoutSeconds * 1000,
    //   workflowJobStepsRetryMs: testCfg.workflowJobStepsRetrySeconds * 1000,
    // });

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    // expect(returnDispatchHandleFailMock).not.toHaveBeenCalled();
    // expect(returnDispatchHandleSuccessMock).toHaveBeenCalledOnce();
    // expect(returnDispatchHandleSuccessMock).toHaveBeenCalledWith(
    //   returnDispatchSuccessResult.value.id,
    //   returnDispatchSuccessResult.value.url,
    // );

    // Logging
    assertOnlyCalled(coreInfoLogMock, coreDebugLogMock);
    expect(coreInfoLogMock).toHaveBeenCalledTimes(2);
    expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Attempt to extract branch name from ref..."`,
    );
    expect(coreInfoLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(
      `"Attempting to identify run ID from steps..."`,
    );
    expect(coreDebugLogMock).toHaveBeenCalledTimes(2);
    expect(coreDebugLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Attempting to identify run ID for test-workflow (0)"`,
    );
    expect(coreDebugLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(
      `"Completed (0ms)"`,
    );
  });

  // it("should fail for an unhandled error", async () => {
  //   const testError = new Error("test error");
  //   actionGetConfigMock.mockImplementation(() => {
  //     throw testError;
  //   });

  //   await main();

  //   // Behaviour
  //   expect(actionGetConfigMock).toHaveBeenCalledOnce();

  //   expect(apiInitMock).not.toHaveBeenCalled();
  //   expect(returnDispatchGetWorkflowIdMock).not.toHaveBeenCalled();
  //   expect(apiDispatchWorkflowMock).not.toHaveBeenCalled();
  //   expect(utilsGetBranchNameMock).not.toHaveBeenCalled();
  //   expect(utilsLogInfoForBranchNameResult).not.toHaveBeenCalled();
  //   expect(returnDispatchGetRunIdAndUrlMock).not.toHaveBeenCalled();
  //   expect(returnDispatchHandleFailMock).not.toHaveBeenCalled();
  //   expect(returnDispatchHandleSuccessMock).not.toHaveBeenCalled();

  //   expect(coreSetFailedMock).toHaveBeenCalledOnce();
  //   expect(coreSetFailedMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
  //     `"Failed: An unhandled error has occurred: test error"`,
  //   );

  //   // Logging
  //   assertOnlyCalled(coreDebugLogMock, coreErrorLogMock);
  //   expect(coreErrorLogMock).toHaveBeenCalledOnce();
  //   expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
  //     `"Failed: An unhandled error has occurred: test error"`,
  //   );
  //   expect(coreDebugLogMock).toHaveBeenCalledOnce();
  //   expect(coreDebugLogMock.mock.calls[0]?.[0]).toStrictEqual(testError.stack);
  // });

  // it("should fail for an unhandled unknown", async () => {
  //   const testError = "some other error";
  //   actionGetConfigMock.mockImplementation(() => {
  //     // eslint-disable-next-line @typescript-eslint/only-throw-error
  //     throw testError;
  //   });

  //   await main();

  //   // Behaviour
  //   expect(actionGetConfigMock).toHaveBeenCalledOnce();

  //   expect(apiInitMock).not.toHaveBeenCalled();
  //   expect(returnDispatchGetWorkflowIdMock).not.toHaveBeenCalled();
  //   expect(apiDispatchWorkflowMock).not.toHaveBeenCalled();
  //   expect(utilsGetBranchNameMock).not.toHaveBeenCalled();
  //   expect(utilsLogInfoForBranchNameResult).not.toHaveBeenCalled();
  //   expect(returnDispatchGetRunIdAndUrlMock).not.toHaveBeenCalled();
  //   expect(returnDispatchHandleFailMock).not.toHaveBeenCalled();
  //   expect(returnDispatchHandleSuccessMock).not.toHaveBeenCalled();

  //   expect(coreSetFailedMock).toHaveBeenCalledOnce();
  //   expect(coreSetFailedMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
  //     `"Failed: An unknown error has occurred: some other error"`,
  //   );

  //   // Logging
  //   assertOnlyCalled(coreDebugLogMock, coreErrorLogMock);
  //   expect(coreErrorLogMock).toHaveBeenCalledOnce();
  //   expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
  //     `"Failed: An unknown error has occurred: some other error"`,
  //   );
  //   expect(coreDebugLogMock).toHaveBeenCalledOnce();
  //   expect(coreDebugLogMock.mock.calls[0]?.[0]).toStrictEqual(testError);
  // });
});
