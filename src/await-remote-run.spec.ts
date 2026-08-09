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
import type { WorkflowRunJobState } from "./api.ts";
import {
  getWorkflowRunConclusionResult,
  getWorkflowRunJobsResult,
  getWorkflowRunJobsStateResult,
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
    coreWarningLogMock,
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
      WorkflowRunStatus.Requested,
      WorkflowRunStatus.Pending,
      WorkflowRunStatus.Waiting,
    ])("should return pending on %s status", (status) => {
      // Behaviour
      const result = getWorkflowRunStatusResult(status, 0);
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("pending");

      // Logging
      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toHaveBeenCalledOnce();
      expect(coreDebugLogMock.mock.lastCall?.[0]).toStrictEqual(
        `Run is ${status}, attempt 0...`,
      );
    });

    it("should return unsupported on a null status", () => {
      // Behaviour
      const result = getWorkflowRunStatusResult(null, 0);
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("unsupported");
      expect(result.value).toStrictEqual("null");

      // Logging
      assertOnlyCalled(coreErrorLogMock, coreInfoLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Run status is unsupported: null"`,
      );
      expect(coreInfoLogMock).toHaveBeenCalledOnce();
      expect(coreInfoLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Please open an issue with this status value"`,
      );
    });

    it("should return unsupported on an unknown status", () => {
      // Behaviour
      const result = getWorkflowRunStatusResult(
        "random_status" as WorkflowRunStatus,
        0,
      );
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("unsupported");
      expect(result.value).toStrictEqual("random_status");

      // Logging
      assertOnlyCalled(coreErrorLogMock, coreInfoLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Run status is unsupported: random_status"`,
      );
      expect(coreInfoLogMock).toHaveBeenCalledOnce();
      expect(coreInfoLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Please open an issue with this status value"`,
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
      expect(result.reason).toStrictEqual("timed_out");

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Run has timed out"`,
      );
    });

    it.each([
      WorkflowRunConclusion.ActionRequired,
      WorkflowRunConclusion.Cancelled,
      WorkflowRunConclusion.Failure,
      WorkflowRunConclusion.Neutral,
      WorkflowRunConclusion.Skipped,
      WorkflowRunConclusion.Stale,
      WorkflowRunConclusion.StartupFailure,
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

  describe("getWorkflowRunJobsStateResult", () => {
    function job(
      name: string,
      status: WorkflowRunJobState["status"],
      conclusion: WorkflowRunJobState["conclusion"] = null,
    ): WorkflowRunJobState {
      return { name: name, status: status, conclusion: conclusion };
    }

    const build = job("build", "completed", "success");

    it("should settle once every awaited Job has succeeded", () => {
      const test = job("test", "completed", "success");

      // Behaviour
      const result = getWorkflowRunJobsStateResult(
        ["build", "test"],
        [build, test, job("deploy", "in_progress")],
        false,
      );
      expect(result).toStrictEqual({
        done: true,
        value: { success: true, value: [build, test] },
      });

      // Logging
      assertNoneCalled();
    });

    it.each(["failure", "cancelled", "skipped", "timed_out"] as const)(
      "should fail on an awaited Job concluding %s",
      (conclusion) => {
        const failed = job("build", "completed", conclusion);

        // Behaviour
        const result = getWorkflowRunJobsStateResult(
          ["build"],
          [failed],
          false,
        );
        expect(result).toStrictEqual({
          done: true,
          value: { success: false, reason: "inconclusive", value: [failed] },
        });

        // Logging
        assertOnlyCalled(coreErrorLogMock);
        expect(coreErrorLogMock).toHaveBeenCalledOnce();
        expect(coreErrorLogMock.mock.lastCall?.[0]).toStrictEqual(
          `Job build has failed with conclusion: ${conclusion}`,
        );
      },
    );

    it("should fail without waiting on the remaining awaited Jobs", () => {
      // Behaviour
      // `test` has yet to appear, but cannot rescue `build`.
      const result = getWorkflowRunJobsStateResult(
        ["build", "test"],
        [job("build", "completed", "failure")],
        false,
      );
      expect(result).toMatchObject({
        done: true,
        value: { reason: "inconclusive" },
      });

      // Logging
      assertOnlyCalled(coreErrorLogMock);
    });

    it.each([
      { label: "not yet appeared", pending: [] },
      { label: "yet to complete", pending: [job("test", "in_progress")] },
      { label: "queued", pending: [job("test", "queued")] },
    ])("should keep polling while an awaited Job has $label", ({ pending }) => {
      // Behaviour
      const result = getWorkflowRunJobsStateResult(
        ["build", "test"],
        [build, ...pending],
        false,
      );
      expect(result).toStrictEqual({ done: false });

      // Logging
      assertNoneCalled();
    });

    it("should fail once the run concludes without an awaited Job", () => {
      // Behaviour
      const result = getWorkflowRunJobsStateResult(
        ["build", "tset"],
        [build, job("test", "completed", "success")],
        true,
      );
      expect(result).toStrictEqual({
        done: true,
        value: {
          success: false,
          reason: "missing",
          value: { missing: ["tset"], observed: ["build", "test"] },
        },
      });

      // Logging
      assertOnlyCalled(coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(`
        "Run concluded without the awaited Jobs completing:
          Awaited: [tset]
          Jobs in run: [build, test]"
      `);
    });

    it("should report a Job the run abandoned mid-flight as missing", () => {
      // Behaviour
      const result = getWorkflowRunJobsStateResult(
        ["test"],
        [job("test", "in_progress")],
        true,
      );
      expect(result).toMatchObject({
        done: true,
        value: { reason: "missing", value: { missing: ["test"] } },
      });

      // Logging
      assertOnlyCalled(coreErrorLogMock);
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

    it("should swallow errors from fetching failed jobs", async () => {
      const fetchError = new Error("boom");
      apiFetchWorkflowRunFailedJobsMock.mockRejectedValue(fetchError);

      const testMsg = "Original Failure";
      await expect(handleActionFail(testMsg, 42)).resolves.toBeUndefined();

      // Behaviour
      // We want to ensure that the original `setFailed` reason
      // is preserved. Teardown errors shouldn't leak to the caller.
      expect(setFailedSpy).toHaveBeenCalledOnce();
      expect(setFailedSpy).toHaveBeenCalledWith(testMsg);
      expect(setOutputSpy).not.toHaveBeenCalled();

      // Logging
      assertOnlyCalled(coreErrorLogMock, coreWarningLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
        `"Failed: Original Failure"`,
      );
      expect(coreWarningLogMock).toHaveBeenCalledOnce();
      expect(coreWarningLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
        `"Unable to log failed job details for Workflow Run 42: boom"`,
      );
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
    let apiRequestWorkflowRunCancelMock: MockInstance<
      typeof api.requestWorkflowRunCancel
    >;

    beforeEach(() => {
      vi.useFakeTimers();

      apiFetchWorkflowRunStateMock = vi.spyOn(api, "fetchWorkflowRunState");
      apiRetryOnErrorMock = vi.spyOn(api, "retryOnError");
      apiRequestWorkflowRunCancelMock = vi.spyOn(
        api,
        "requestWorkflowRunCancel",
      );
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
      expect(coreDebugLogMock).toHaveBeenCalledTimes(2);
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

    describe("cancellation", () => {
      const pollIntervalMs = 100;
      const runTimeoutMs = 1000;
      const cancelTimeoutMs = 300;

      beforeEach(() => {
        apiFetchWorkflowRunStateMock.mockResolvedValue({
          status: WorkflowRunStatus.InProgress,
          conclusion: null,
        });
        apiRetryOnErrorMock.mockImplementation(async (toTry) => ({
          success: true,
          value: await toTry(),
        }));
      });

      it("requests cancellation once the cancel timeout elapses", async () => {
        apiRequestWorkflowRunCancelMock.mockImplementation(() => {
          // Mirror the remote run reacting to the cancellation, so the
          // subsequent poll observes the conclusion.
          apiFetchWorkflowRunStateMock.mockResolvedValue({
            status: WorkflowRunStatus.Completed,
            conclusion: WorkflowRunConclusion.Cancelled,
          });
          return Promise.resolve({ success: true });
        });

        // Behaviour
        const getWorkflowRunResultPromise = getWorkflowRunResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          cancelTimeoutMs: cancelTimeoutMs,
        });

        // Cancellation is requested on the first poll at or after the cancel
        // timeout, so it should not have fired one interval earlier.
        await vi.advanceTimersByTimeAsync(cancelTimeoutMs - pollIntervalMs);
        expect(apiRequestWorkflowRunCancelMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(runTimeoutMs);
        const result = await getWorkflowRunResultPromise;
        expect(result).toStrictEqual({
          success: true,
          value: {
            status: WorkflowRunStatus.Completed,
            conclusion: WorkflowRunConclusion.Cancelled,
          },
        });
        expect(apiRequestWorkflowRunCancelMock).toHaveBeenCalledOnce();
        expect(apiRequestWorkflowRunCancelMock).toHaveBeenCalledWith(0);

        // Logging
        assertOnlyCalled(
          coreDebugLogMock,
          coreWarningLogMock,
          coreErrorLogMock,
        );
        expect(coreWarningLogMock).toHaveBeenCalledOnce();
        expect(coreWarningLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
          `"Cancel timeout exceeded (300ms), requesting cancellation of Workflow Run 0"`,
        );
      });

      it("does not request cancellation if no cancel timeout is given", async () => {
        // Behaviour
        const getWorkflowRunResultPromise = getWorkflowRunResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);
        const result = await getWorkflowRunResultPromise;

        expect(result).toStrictEqual({ success: false, reason: "timeout" });
        expect(apiRequestWorkflowRunCancelMock).not.toHaveBeenCalled();

        // Logging
        assertOnlyCalled(coreDebugLogMock);
      });

      it("does not retry a rejected cancellation", async () => {
        apiRequestWorkflowRunCancelMock.mockResolvedValue({
          success: false,
          reason: "rejected",
        });

        // Behaviour
        const getWorkflowRunResultPromise = getWorkflowRunResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          cancelTimeoutMs: cancelTimeoutMs,
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);
        const result = await getWorkflowRunResultPromise;

        expect(result).toStrictEqual({ success: false, reason: "timeout" });
        expect(apiRequestWorkflowRunCancelMock).toHaveBeenCalledOnce();

        // Logging
        assertOnlyCalled(coreDebugLogMock, coreWarningLogMock);
        expect(coreWarningLogMock).toHaveBeenCalledOnce();
      });

      it("retries a failed cancellation on the next poll", async () => {
        apiRequestWorkflowRunCancelMock
          .mockResolvedValue({ success: true })
          .mockResolvedValueOnce({ success: false, reason: "failed" });

        // Behaviour
        const getWorkflowRunResultPromise = getWorkflowRunResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          cancelTimeoutMs: cancelTimeoutMs,
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);
        const result = await getWorkflowRunResultPromise;

        expect(result).toStrictEqual({ success: false, reason: "timeout" });
        // The failed request is retried, the successful one is not.
        expect(apiRequestWorkflowRunCancelMock).toHaveBeenCalledTimes(2);

        // Logging
        assertOnlyCalled(coreDebugLogMock, coreWarningLogMock);
        expect(coreWarningLogMock).toHaveBeenCalledTimes(2);
      });

      it("requests cancellation even while the run state cannot be fetched", async () => {
        apiRetryOnErrorMock.mockResolvedValue({
          success: false,
          reason: "timeout",
        });
        apiRequestWorkflowRunCancelMock.mockResolvedValue({ success: true });

        // Behaviour
        const getWorkflowRunResultPromise = getWorkflowRunResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          cancelTimeoutMs: cancelTimeoutMs,
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);
        const result = await getWorkflowRunResultPromise;

        expect(result).toStrictEqual({ success: false, reason: "timeout" });
        expect(apiRequestWorkflowRunCancelMock).toHaveBeenCalledOnce();

        // Logging
        assertOnlyCalled(coreDebugLogMock, coreWarningLogMock);
        expect(coreWarningLogMock).toHaveBeenCalledOnce();
      });

      it("does not request cancellation if the run concludes first", async () => {
        apiFetchWorkflowRunStateMock.mockResolvedValue({
          status: WorkflowRunStatus.Completed,
          conclusion: WorkflowRunConclusion.Success,
        });

        // Behaviour
        const getWorkflowRunResultPromise = getWorkflowRunResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          cancelTimeoutMs: cancelTimeoutMs,
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);
        const result = await getWorkflowRunResultPromise;

        expect(result).toStrictEqual({
          success: true,
          value: {
            status: WorkflowRunStatus.Completed,
            conclusion: WorkflowRunConclusion.Success,
          },
        });
        expect(apiRequestWorkflowRunCancelMock).not.toHaveBeenCalled();

        // Logging
        assertNoneCalled();
      });
    });

    describe("getWorkflowRunJobsResult", () => {
      const pollIntervalMs = 100;
      const runTimeoutMs = 1000;
      const succeeded = {
        name: "build",
        status: "completed",
        conclusion: "success",
      } satisfies WorkflowRunJobState;

      let apiFetchWorkflowRunJobStatesMock: MockInstance<
        typeof api.fetchWorkflowRunJobStates
      >;

      beforeEach(() => {
        apiFetchWorkflowRunJobStatesMock = vi.spyOn(
          api,
          "fetchWorkflowRunJobStates",
        );
        apiRetryOnErrorMock.mockImplementation(async (toTry) => ({
          success: true,
          value: await toTry(),
        }));
        apiFetchWorkflowRunStateMock.mockResolvedValue({
          status: WorkflowRunStatus.InProgress,
          conclusion: null,
        });
      });

      it("resolves while the rest of the run is still in flight", async () => {
        apiFetchWorkflowRunJobStatesMock.mockResolvedValue([
          succeeded,
          { name: "deploy", status: "in_progress", conclusion: null },
        ]);

        // Behaviour
        const resultPromise = getWorkflowRunJobsResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          jobs: ["build"],
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);

        expect(await resultPromise).toStrictEqual({
          success: true,
          value: [succeeded],
        });
        // Resolving early never cancels the run the deploy is still using.
        expect(apiRequestWorkflowRunCancelMock).not.toHaveBeenCalled();

        // Logging
        assertNoneCalled();
      });

      it("polls until the awaited Job appears", async () => {
        apiFetchWorkflowRunJobStatesMock
          .mockResolvedValue([succeeded])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { name: "build", status: "in_progress", conclusion: null },
          ]);

        // Behaviour
        const resultPromise = getWorkflowRunJobsResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          jobs: ["build"],
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);

        expect(await resultPromise).toMatchObject({ success: true });
        expect(apiFetchWorkflowRunJobStatesMock).toHaveBeenCalledTimes(3);

        // Logging
        assertNoneCalled();
      });

      it("fails once the run concludes without the awaited Job", async () => {
        apiFetchWorkflowRunStateMock.mockResolvedValue({
          status: WorkflowRunStatus.Completed,
          conclusion: WorkflowRunConclusion.Success,
        });
        apiFetchWorkflowRunJobStatesMock.mockResolvedValue([succeeded]);

        // Behaviour
        const resultPromise = getWorkflowRunJobsResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          jobs: ["deploy"],
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);

        expect(await resultPromise).toStrictEqual({
          success: false,
          reason: "missing",
          value: { missing: ["deploy"], observed: ["build"] },
        });
        // Completion must hold for two polls before `missing` is terminal.
        expect(apiFetchWorkflowRunJobStatesMock).toHaveBeenCalledTimes(2);

        // Logging
        assertOnlyCalled(coreErrorLogMock);
      });

      it("succeeds when the Jobs listing lags the run completing", async () => {
        apiFetchWorkflowRunStateMock.mockResolvedValue({
          status: WorkflowRunStatus.Completed,
          conclusion: WorkflowRunConclusion.Success,
        });
        // The awaited Job succeeded, but the listing has yet to reflect it.
        apiFetchWorkflowRunJobStatesMock
          .mockResolvedValue([succeeded])
          .mockResolvedValueOnce([
            { name: "build", status: "in_progress", conclusion: null },
          ]);

        // Behaviour
        const resultPromise = getWorkflowRunJobsResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          jobs: ["build"],
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);

        expect(await resultPromise).toStrictEqual({
          success: true,
          value: [succeeded],
        });

        // Logging
        assertNoneCalled();
      });

      it("times out while the awaited Job never completes", async () => {
        apiRequestWorkflowRunCancelMock.mockResolvedValue({ success: true });
        apiFetchWorkflowRunJobStatesMock.mockResolvedValue([
          { name: "build", status: "in_progress", conclusion: null },
        ]);

        // Behaviour
        const resultPromise = getWorkflowRunJobsResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          cancelTimeoutMs: 300,
          jobs: ["build"],
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);

        expect(await resultPromise).toStrictEqual({
          success: false,
          reason: "timeout",
        });
        // Cancellation still applies to the timeout path.
        expect(apiRequestWorkflowRunCancelMock).toHaveBeenCalledOnce();

        // Logging
        assertOnlyCalled(coreWarningLogMock);
      });

      it("retries on request failures", async () => {
        apiRetryOnErrorMock
          .mockImplementation(async (toTry) => ({
            success: true,
            value: await toTry(),
          }))
          .mockResolvedValueOnce({ success: false, reason: "timeout" });
        apiFetchWorkflowRunJobStatesMock.mockResolvedValue([succeeded]);

        // Behaviour
        const resultPromise = getWorkflowRunJobsResult({
          startTime: Date.now(),
          pollIntervalMs: pollIntervalMs,
          runId: 0,
          runTimeoutMs: runTimeoutMs,
          jobs: ["build"],
        });
        await vi.advanceTimersByTimeAsync(runTimeoutMs);

        expect(await resultPromise).toMatchObject({ success: true });

        // Logging
        assertOnlyCalled(coreDebugLogMock);
        expect(coreDebugLogMock).toHaveBeenCalledOnce();
        expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
          `"Failed to fetch run Jobs, attempt 1..."`,
        );
      });
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
