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

import * as api from "./api.ts";
import {
  getWorkflowRunConclusionResult,
  getWorkflowRunResult,
  getWorkflowRunStatusResult,
  handleActionFail,
} from "./await-remote-run.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";
import { WorkflowRunConclusion, WorkflowRunStatus } from "./types.ts";

vi.mock("@actions/core");
vi.mock("@actions/github");
vi.mock("./api.ts");

describe("await-remote-run", () => {
  const {
    coreErrorLogMock,
    coreInfoLogMock,
    coreDebugLogMock,
    assertOnlyCalled,
    assertNoneCalled,
  } = mockLoggingFunctions();

  afterAll(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("getWorkflowRunStatusResult", () => {
    it("should return success on completed status", () => {
      // Behaviour
      const result = getWorkflowRunStatusResult(WorkflowRunStatus.Completed, 0);
      if (!result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(true);
      expect(result.value).toStrictEqual(WorkflowRunStatus.Completed);

      // Logging
      assertNoneCalled();
    });

    it("should return inconclusive on queued status", () => {
      // Behaviour
      const result = getWorkflowRunStatusResult(WorkflowRunStatus.Queued, 0);
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("pending");

      // Logging
      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toHaveBeenCalledOnce();
      expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Run is queued to begin, attempt 0..."`,
      );
    });

    it("should return inconclusive on in_progress status", () => {
      // Behaviour
      const result = getWorkflowRunStatusResult(
        WorkflowRunStatus.InProgress,
        0,
      );
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("pending");

      // Logging
      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toHaveBeenCalledOnce();
      expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Run is in progress, attempt 0..."`,
      );
    });

    it.each([
      WorkflowRunStatus.Pending,
      WorkflowRunStatus.Requested,
      WorkflowRunStatus.Waiting,
    ])("should return unsupported on %s status", (status) => {
      // Behaviour
      const result = getWorkflowRunStatusResult(status, 0);
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("unsupported");

      // Logging
      assertOnlyCalled(coreErrorLogMock, coreInfoLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toStrictEqual(
        `Run status is unsupported: ${status}`,
      );
      expect(coreInfoLogMock).toHaveBeenCalledOnce();
      expect(coreInfoLogMock.mock.lastCall?.[0]).toStrictEqual(
        "Please open an issue with this status value",
      );
    });
  });

  describe("getWorkflowRunConclusionResult", () => {
    it("should return success on success conclusion", () => {
      // Behaviour
      const result = getWorkflowRunConclusionResult(
        WorkflowRunConclusion.Success,
      );
      if (!result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(true);
      expect(result.value).toStrictEqual(WorkflowRunConclusion.Success);

      // Logging
      assertNoneCalled();
    });

    it("should return non-success on an unsupported conclusion", () => {
      // Behaviour
      const result = getWorkflowRunConclusionResult(
        "random_conclusion" as WorkflowRunConclusion,
      );
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("unsupported");

      // Logging
      assertOnlyCalled(coreErrorLogMock, coreInfoLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Run has failed with unsupported conclusion: random_conclusion"`,
      );
      expect(coreInfoLogMock).toHaveBeenCalledOnce();
      expect(coreInfoLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Please open an issue with this conclusion value"`,
      );
    });

    it("should return non-success on timeout conclusion", () => {
      // Behaviour
      const result = getWorkflowRunConclusionResult(
        WorkflowRunConclusion.TimedOut,
      );
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("timeout");

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Run has timeout out"`,
      );
    });

    it.each([
      WorkflowRunConclusion.ActionRequired,
      WorkflowRunConclusion.Cancelled,
      WorkflowRunConclusion.Failure,
      WorkflowRunConclusion.Neutral,
      WorkflowRunConclusion.Skipped,
    ])("should return non-success on %s conclusion", (conclusion) => {
      // Behaviour
      const result = getWorkflowRunConclusionResult(conclusion);
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("inconclusive");

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toStrictEqual(
        `Run has failed with conclusion: ${conclusion}`,
      );
    });
  });

  describe("handleActionFail", () => {
    let setFailedSpy: MockInstance<typeof core.setFailed>;
    let setOutputSpy: MockInstance<typeof core.setOutput>;

    let apiFetchWorkflowRunFailedJobsMock: MockInstance<
      typeof api.fetchWorkflowRunFailedJobs
    >;

    beforeEach(() => {
      setFailedSpy = vi.spyOn(core, "setFailed");
      setOutputSpy = vi.spyOn(core, "setOutput");

      apiFetchWorkflowRunFailedJobsMock = vi.spyOn(
        api,
        "fetchWorkflowRunFailedJobs",
      );
    });

    it("should set the action output and status", async () => {
      apiFetchWorkflowRunFailedJobsMock.mockResolvedValue([]);

      const testMsg = "Test Message";
      await handleActionFail(testMsg, 0);

      // Behaviour
      expect(setFailedSpy).toHaveBeenCalled();
      expect(setOutputSpy).not.toHaveBeenCalled();

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
        `"Failed: Test Message"`,
      );
    });

    it("should fetch and log failed jobs from the remote run", async () => {
      const jobs = [
        {
          name: "First Job",
          id: 0,
          status: "completed" as const,
          conclusion: WorkflowRunConclusion.Failure,
          url: "url",
          steps: [
            {
              name: "First Step",
              number: 0,
              status: "completed" as const,
              conclusion: WorkflowRunConclusion.Failure,
            },
          ],
        },
        {
          name: "Second Job",
          id: 0,
          status: "completed" as const,
          conclusion: WorkflowRunConclusion.Failure,
          url: "url",
          steps: [
            {
              name: "First Step",
              number: 0,
              status: "completed" as const,
              conclusion: WorkflowRunConclusion.Success,
            },
          ],
        },
      ];
      apiFetchWorkflowRunFailedJobsMock.mockResolvedValue(jobs);

      const testMsg = "Test Message";
      await handleActionFail(testMsg, 0);

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledTimes(3);
      expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
        `"Failed: Test Message"`,
      );
      expect(coreErrorLogMock.mock.calls[1]?.[0]).toMatchSnapshot();
      expect(coreErrorLogMock.mock.calls[2]?.[0]).toMatchSnapshot();
    });

    it("should only log steps that did not succeed", async () => {
      const jobs = [
        {
          name: "First Job",
          id: 0,
          status: "completed" as const,
          conclusion: WorkflowRunConclusion.Failure,
          url: "url",
          steps: [
            {
              name: "First Step",
              number: 0,
              status: "completed" as const,
              conclusion: WorkflowRunConclusion.Success,
            },
            {
              name: "Second Step",
              number: 1,
              status: "completed" as const,
              conclusion: WorkflowRunConclusion.Failure,
            },
            {
              name: "Third Step",
              number: 2,
              status: "completed" as const,
              conclusion: WorkflowRunConclusion.Skipped,
            },
          ],
        },
      ];
      apiFetchWorkflowRunFailedJobsMock.mockResolvedValue(jobs);

      const testMsg = "Test Message";
      await handleActionFail(testMsg, 0);

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledTimes(2);
      expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
        `"Failed: Test Message"`,
      );
      expect(coreErrorLogMock.mock.calls[1]?.[0]).toMatchSnapshot();
    });
  });

  describe("getWorkflowRunResult", () => {
    let apiFetchWorkflowRunStateMock: MockInstance<
      typeof api.fetchWorkflowRunState
    >;
    let apiRetryOnErrorMock: MockInstance<typeof api.retryOnError>;

    beforeEach(() => {
      vi.useFakeTimers();

      apiFetchWorkflowRunStateMock = vi.spyOn(api, "fetchWorkflowRunState");
      apiRetryOnErrorMock = vi.spyOn(api, "retryOnError");
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("succeeds on the completion of a run", async () => {
      apiFetchWorkflowRunStateMock.mockResolvedValue({
        status: WorkflowRunStatus.Completed,
        conclusion: WorkflowRunConclusion.Success,
      });
      apiRetryOnErrorMock.mockImplementation(async (toTry) => ({
        success: true,
        value: await toTry(),
      }));

      // Behaviour
      const getWorkflowRunResultPromise = getWorkflowRunResult({
        startTime: Date.now(),
        pollIntervalMs: 100,
        runId: 0,
        runTimeoutMs: 10_000,
      });
      await expect(getWorkflowRunResultPromise).resolves.not.toThrow();
      const result = await getWorkflowRunResultPromise;
      expect(result).toStrictEqual({
        success: true,
        value: {
          conclusion: WorkflowRunConclusion.Success,
          status: WorkflowRunStatus.Completed,
        },
      });

      // Logging
      assertNoneCalled();
    });

    it("retries on request failures", async () => {
      const pollIntervalMs = 100;
      apiFetchWorkflowRunStateMock.mockResolvedValue({
        status: WorkflowRunStatus.Completed,
        conclusion: WorkflowRunConclusion.Success,
      });
      apiRetryOnErrorMock
        .mockImplementation(async (toTry) => ({
          success: true,
          value: await toTry(),
        }))
        .mockResolvedValueOnce({ success: false, reason: "timeout" })
        .mockResolvedValueOnce({ success: false, reason: "timeout" });

      // Behaviour
      const getWorkflowRunResultPromise = getWorkflowRunResult({
        startTime: Date.now(),
        pollIntervalMs: pollIntervalMs,
        runId: 0,
        runTimeoutMs: 10_000,
      });

      // First iteration
      await vi.advanceTimersByTimeAsync(1);
      expect(coreDebugLogMock).toHaveBeenCalledOnce();

      // Second iteration
      await vi.advanceTimersByTimeAsync(100);
      expect(coreDebugLogMock).toHaveBeenCalledTimes(2);

      // Final iteration
      await vi.advanceTimersByTimeAsync(100);
      await expect(getWorkflowRunResultPromise).resolves.not.toThrow();
      const result = await getWorkflowRunResultPromise;
      expect(result).toStrictEqual({
        success: true,
        value: {
          conclusion: WorkflowRunConclusion.Success,
          status: WorkflowRunStatus.Completed,
        },
      });

      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toBeCalledTimes(2);
      expect(coreDebugLogMock.mock.calls).toMatchSnapshot();
    });

    it("returns the conclusion if available", async () => {
      const expectedConclusion = WorkflowRunConclusion.Skipped;
      apiFetchWorkflowRunStateMock.mockResolvedValue({
        status: WorkflowRunStatus.Completed,
        conclusion: expectedConclusion,
      });
      apiRetryOnErrorMock.mockImplementation(async (toTry) => ({
        success: true,
        value: await toTry(),
      }));

      // Behaviour
      const getWorkflowRunResultPromise = getWorkflowRunResult({
        startTime: Date.now(),
        pollIntervalMs: 100,
        runId: 0,
        runTimeoutMs: 10_000,
      });
      await expect(getWorkflowRunResultPromise).resolves.not.toThrow();
      const result = await getWorkflowRunResultPromise;
      expect(result).toStrictEqual({
        success: true,
        value: {
          conclusion: expectedConclusion,
          status: WorkflowRunStatus.Completed,
        },
      });

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.calls).toMatchSnapshot();
    });

    it("returns a failure on timeout conclusion", async () => {
      const expectedConclusion = WorkflowRunConclusion.TimedOut;
      apiFetchWorkflowRunStateMock.mockResolvedValue({
        status: WorkflowRunStatus.Completed,
        conclusion: expectedConclusion,
      });
      apiRetryOnErrorMock.mockImplementation(async (toTry) => ({
        success: true,
        value: await toTry(),
      }));

      // Behaviour
      const getWorkflowRunResultPromise = getWorkflowRunResult({
        startTime: Date.now(),
        pollIntervalMs: 100,
        runId: 0,
        runTimeoutMs: 10_000,
      });
      await expect(getWorkflowRunResultPromise).resolves.not.toThrow();
      const result = await getWorkflowRunResultPromise;
      expect(result).toStrictEqual({
        success: false,
        reason: "timeout",
      });

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.calls).toMatchSnapshot();
    });

    it("returns a failure on an unsupported conclusion", async () => {
      const expectedConclusion = "weird";
      apiFetchWorkflowRunStateMock.mockResolvedValue({
        status: WorkflowRunStatus.Completed,
        conclusion: expectedConclusion as any,
      });
      apiRetryOnErrorMock.mockImplementation(async (toTry) => ({
        success: true,
        value: await toTry(),
      }));

      // Behaviour
      const getWorkflowRunResultPromise = getWorkflowRunResult({
        startTime: Date.now(),
        pollIntervalMs: 100,
        runId: 0,
        runTimeoutMs: 10_000,
      });
      await expect(getWorkflowRunResultPromise).resolves.not.toThrow();
      const result = await getWorkflowRunResultPromise;
      expect(result).toStrictEqual({
        success: false,
        reason: "unsupported",
        value: expectedConclusion,
      });

      // Logging
      assertOnlyCalled(coreErrorLogMock, coreInfoLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.calls).toMatchSnapshot();
      expect(coreInfoLogMock).toHaveBeenCalledOnce();
      expect(coreInfoLogMock.mock.calls).toMatchSnapshot();
    });

    it("returns a failure if the status is unsupported", async () => {
      const expectedStatus = "weird";
      apiFetchWorkflowRunStateMock.mockResolvedValue({
        status: expectedStatus as any,
        conclusion: WorkflowRunConclusion.Failure,
      });
      apiRetryOnErrorMock.mockImplementation(async (toTry) => ({
        success: true,
        value: await toTry(),
      }));

      // Behaviour
      const getWorkflowRunResultPromise = getWorkflowRunResult({
        startTime: Date.now(),
        pollIntervalMs: 100,
        runId: 0,
        runTimeoutMs: 10_000,
      });
      await expect(getWorkflowRunResultPromise).resolves.not.toThrow();
      const result = await getWorkflowRunResultPromise;
      expect(result).toStrictEqual({
        success: false,
        reason: "unsupported",
        value: "weird",
      });

      // Logging
      assertOnlyCalled(coreErrorLogMock, coreInfoLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.calls).toMatchSnapshot();
      expect(coreInfoLogMock).toHaveBeenCalledOnce();
      expect(coreInfoLogMock.mock.calls).toMatchSnapshot();
    });

    it("returns a timeout", async () => {
      const pollIntervalMs = 100;
      const runTimeoutMs = 1000;
      const expectedIterations = runTimeoutMs / pollIntervalMs;
      apiFetchWorkflowRunStateMock.mockResolvedValue({
        status: WorkflowRunStatus.InProgress,
        conclusion: null,
      });
      apiRetryOnErrorMock.mockImplementation(async (toTry) => ({
        success: true,
        value: await toTry(),
      }));

      // Behaviour
      const getWorkflowRunResultPromise = getWorkflowRunResult({
        startTime: Date.now(),
        pollIntervalMs: pollIntervalMs,
        runId: 0,
        runTimeoutMs: runTimeoutMs,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(getWorkflowRunResultPromise).resolves.not.toThrow();
      const result = await getWorkflowRunResultPromise;
      expect(result).toStrictEqual({
        success: false,
        reason: "timeout",
      });

      // Logging
      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toHaveBeenCalledTimes(expectedIterations);
      expect(coreDebugLogMock.mock.calls).toMatchSnapshot();
    });
  });
});
