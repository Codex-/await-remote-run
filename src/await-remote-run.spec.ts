import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  fetchWorkflowRunActiveJobUrl,
  fetchWorkflowRunActiveJobUrlRetry,
  fetchWorkflowRunFailedJobs,
  fetchWorkflowRunState,
  init,
  retryOnError,
  WorkflowRunStatus,
} from "./api.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";
import { getWorkflowRunStatusResult } from "./await-remote-run.ts";

vi.mock("@actions/core");
vi.mock("@actions/github");

interface MockResponse {
  data: any;
  status: number;
}

const mockOctokit = {
  rest: {
    actions: {
      getWorkflowRun: (_req?: any): Promise<MockResponse> => {
        throw new Error("Should be mocked");
      },
      listJobsForWorkflowRun: (_req?: any): Promise<MockResponse> => {
        throw new Error("Should be mocked");
      },
    },
  },
};

describe("await-remote-run", () => {
  const {
    coreErrorLogMock,
    coreWarningLogMock,
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
      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toHaveBeenCalledOnce();
      expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Run has completed"`,
      );
    });

    it("should return inconclusive on queued status", () => {
      // Behaviour
      const result = getWorkflowRunStatusResult(WorkflowRunStatus.Queued, 0);
      if (result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("inconclusive");

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
      expect(result.reason).toStrictEqual("inconclusive");

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
      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toHaveBeenCalledOnce();
      expect(coreDebugLogMock.mock.lastCall?.[0]).toStrictEqual(
        `Run has returned an unsupported status: ${status}`,
      );
    });
  });
});
