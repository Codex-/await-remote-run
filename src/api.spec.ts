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
} from "./api.ts";
import { clearEtags } from "./etags.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";

vi.mock("@actions/core");
vi.mock("@actions/github");

interface MockResponse {
  data: any;
  status: number;
  headers: Record<string, string>;
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

afterEach(() => {
  clearEtags();
});

describe("API", () => {
  const cfg = {
    token: "secret",
    ref: "feature_branch",
    repo: "repository",
    owner: "owner",
    runId: 123456,
    runTimeoutSeconds: 300,
    pollIntervalMs: 2500,
  };

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

  beforeEach(() => {
    vi.spyOn(core, "getInput").mockReturnValue("");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.spyOn(github, "getOctokit").mockReturnValue(mockOctokit as any);
    init(cfg);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("fetchWorkflowRunState", () => {
    it("should return the workflow run state for a given run ID", async () => {
      const mockData = {
        status: "completed",
        conclusion: "cancelled",
      };
      vi.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockReturnValue(
        Promise.resolve({
          data: mockData,
          status: 200,
          headers: {},
        }),
      );

      // Behaviour
      const state = await fetchWorkflowRunState(123456);
      expect(state.conclusion).toStrictEqual(mockData.conclusion);
      expect(state.status).toStrictEqual(mockData.status);

      // Logging
      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toHaveBeenCalledOnce();
      expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(`
        "Fetched Run:
          Repository: owner/repository
          Run ID: 123456
          Status: completed
          Conclusion: cancelled"
      `);
    });

    it("should throw if a non-200 status is returned", async () => {
      const errorStatus = 401;
      vi.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockReturnValue(
        Promise.resolve({
          data: undefined,
          status: errorStatus,
          headers: {},
        }),
      );

      // Behaviour
      await expect(fetchWorkflowRunState(0)).rejects.toThrowError(
        `Failed to fetch Workflow Run state, expected 200 but received ${errorStatus}`,
      );

      // Logging
      assertOnlyCalled(coreDebugLogMock, coreErrorLogMock);
      expect(coreErrorLogMock).toHaveBeenCalledOnce();
      expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"fetchWorkflowRunState: An unexpected error has occurred: Failed to fetch Workflow Run state, expected 200 but received 401"`,
      );
      expect(coreDebugLogMock).toHaveBeenCalledOnce();
    });

    it("should send the previous etag in the If-None-Match header", async () => {
      const mockData = {
        status: "completed",
        conclusion: "cancelled",
      };
      const etag =
        "37c2311495bbea359329d0bb72561bdb2b2fffea1b7a54f696b5a287e7ccad1e";
      let submittedEtag = null;
      vi.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockReturnValue(
        Promise.resolve({
          data: mockData,
          status: 200,
          headers: {},
        }),
      );
      vi.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockImplementation(
        ({ headers }) => {
          if (headers?.["If-None-Match"]) {
            submittedEtag = headers["If-None-Match"];
            return Promise.resolve({
              data: null,
              status: 304,
              headers: {
                etag: `W/"${submittedEtag}"`,
              },
            });
          }
          return Promise.resolve({
            data: mockData,
            status: 200,
            headers: {
              etag: `W/"${etag}"`,
            },
          });
        },
      );

      // Behaviour
      // First API call will return 200 with an etag response header
      const state = await getWorkflowRunState(123456);
      expect(state.conclusion).toStrictEqual("cancelled");
      expect(state.status).toStrictEqual("completed");
      // Second API call with same parameters should pass the If-None-Match header
      const state2 = await getWorkflowRunState(123456);
      expect(state2.conclusion).toStrictEqual(mockData.conclusion);
      expect(state2.status).toStrictEqual(mockData.status);
    });

    it("should not send the previous etag in the If-None-Match header when different request params are used", async () => {
      const mockData = {
        status: "completed",
        conclusion: "cancelled",
      };
      const etag =
        "37c2311495bbea359329d0bb72561bdb2b2fffea1b7a54f696b5a287e7ccad1e";
      let submittedEtag = null;
      vi.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockImplementation(
        ({ headers }) => {
          if (headers?.["If-None-Match"]) {
            submittedEtag = headers["If-None-Match"];
            return Promise.resolve({
              data: null,
              status: 304,
              headers: {
                etag: `W/"${submittedEtag}"`,
              },
            });
          }
          return Promise.resolve({
            data: mockData,
            status: 200,
            headers: {
              etag: `W/"${etag}"`,
            },
          });
        },
      );

      // Behaviour
      // First API call will return 200 with an etag response header
      const state = await getWorkflowRunState(123456);
      expect(state.conclusion).toStrictEqual("cancelled");
      expect(state.status).toStrictEqual("completed");
      // Second API call, without If-None-Match header because of different parameters
      const state2 = await getWorkflowRunState(123457);
      expect(state2.conclusion).toStrictEqual("cancelled");
      expect(state2.status).toStrictEqual("completed");
    });
  });

  describe("fetchWorkflowRunJobs", () => {
    const mockData = {
      total_count: 1,
      jobs: [
        {
          id: 123456789,
          html_url: "https://github.com/codex-/await-remote-run/runs/123456789",
          status: "completed",
          conclusion: "failure",
          name: "test-run",
          steps: [
            {
              name: "Step 1",
              status: "completed",
              conclusion: "success",
              number: 1,
            },
            {
              name: "Step 2",
              status: "completed",
              conclusion: "failure",
              number: 6,
            },
          ],
        },
      ],
    };

    describe("fetchWorkflowRunFailedJobs", () => {
      it("should return the jobs for a failed workflow run given a run ID", async () => {
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: mockData,
            status: 200,
            headers: {},
          }),
        );

        // Behaviour
        const jobs = await fetchWorkflowRunFailedJobs(123456);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchSnapshot();

        // Logging
        assertOnlyCalled(coreDebugLogMock);
        expect(coreDebugLogMock).toHaveBeenCalledTimes(2);
        expect(coreDebugLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
          "Fetched Jobs for Run:
            Repository: owner/repository
            Run ID: 123456
            Jobs: [test-run]"
        `);
        expect(coreDebugLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(`
          "    Job: test-run
                ID: 123456789
                Status: completed
                Conclusion: failure
                Steps: [1: Step 1, 6: Step 2]"
        `);
      });

      it("should log a warning if no failed jobs are found", async () => {
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: {
              total_count: 0,
              jobs: [],
            },
            status: 200,
          }),
        );

        // Behaviour
        const jobs = await fetchWorkflowRunFailedJobs(123456);
        expect(jobs).toHaveLength(0);

        // Logging
        assertOnlyCalled(coreWarningLogMock);
        expect(coreWarningLogMock).toHaveBeenCalledOnce();
        expect(coreWarningLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
          `"Failed to find failed Jobs for Workflow Run 123456"`,
        );
      });

      it("should throw if a non-200 status is returned", async () => {
        const errorStatus = 401;
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: undefined,
            status: errorStatus,
            headers: {},
          }),
        );

        // Behaviour
        await expect(fetchWorkflowRunFailedJobs(0)).rejects.toThrowError(
          `Failed to fetch Jobs for Workflow Run, expected 200 but received ${errorStatus}`,
        );

        // Logging
        assertOnlyCalled(coreErrorLogMock, coreDebugLogMock);
        expect(coreErrorLogMock).toHaveBeenCalledOnce();
        expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
          `"fetchWorkflowRunFailedJobs: An unexpected error has occurred: Failed to fetch Jobs for Workflow Run, expected 200 but received 401"`,
        );
        expect(coreDebugLogMock).toHaveBeenCalledOnce();
      });

      it("should return the steps for a failed Job", async () => {
        const mockSteps = mockData.jobs[0]!.steps;
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: mockData,
            status: 200,
            headers: {},
          }),
        );

        // Behaviour
        const { steps } = (await fetchWorkflowRunFailedJobs(123456))[0]!;
        expect(steps).toMatchObject(mockSteps);

        // Logging
        assertOnlyCalled(coreDebugLogMock);
        expect(coreDebugLogMock).toHaveBeenCalledTimes(2);
        expect(coreDebugLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
          "Fetched Jobs for Run:
            Repository: owner/repository
            Run ID: 123456
            Jobs: [test-run]"
        `);
        expect(coreDebugLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(`
          "    Job: test-run
                ID: 123456789
                Status: completed
                Conclusion: failure
                Steps: [1: Step 1, 6: Step 2]"
        `);
      });
    });

    describe("fetchWorkflowRunActiveJobUrl", () => {
      let inProgressMockData: any;

      beforeEach(() => {
        inProgressMockData = {
          ...mockData,
          jobs: [
            {
              ...mockData.jobs[0],
              status: "in_progress",
              conclusion: null,
            },
          ],
        };
      });

      it("should return the url for an in_progress workflow run given a run ID", async () => {
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: inProgressMockData,
            status: 200,
            headers: {},
          }),
        );

        const url = await fetchWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual(mockData.jobs[0]?.html_url);
      });

      it("should return the url for an completed workflow run given a run ID", async () => {
        inProgressMockData.jobs[0].status = "completed";

        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: inProgressMockData,
            status: 200,
            headers: {},
          }),
        );

        // Behaviour
        const url = await fetchWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual(mockData.jobs[0]?.html_url);

        // Logging
        assertOnlyCalled(coreDebugLogMock);
        expect(coreDebugLogMock).toHaveBeenCalledOnce();
        expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(`
          "Fetched Jobs for Run:
            Repository: owner/repository
            Run ID: 123456
            Jobs: [test-run (completed)]"
        `);
      });

      it("should throw if a non-200 status is returned", async () => {
        const errorStatus = 401;
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: undefined,
            status: errorStatus,
            headers: {},
          }),
        );

        // Behaviour
        await expect(fetchWorkflowRunActiveJobUrl(0)).rejects.toThrowError(
          `Failed to fetch Jobs for Workflow Run, expected 200 but received ${errorStatus}`,
        );

        // Logging
        assertOnlyCalled(coreErrorLogMock, coreDebugLogMock);
        expect(coreErrorLogMock).toHaveBeenCalledOnce();
        expect(coreErrorLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
          `"fetchWorkflowRunActiveJobUrl: An unexpected error has occurred: Failed to fetch Jobs for Workflow Run, expected 200 but received 401"`,
        );
        expect(coreDebugLogMock).toHaveBeenCalledOnce();
      });

      it("should return undefined if no in_progress job is found", async () => {
        inProgressMockData.jobs[0].status = "unknown";

        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: inProgressMockData,
            status: 200,
            headers: {},
          }),
        );

        // Behaviour
        const url = await fetchWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual(undefined);

        // Logging
        assertOnlyCalled(coreDebugLogMock);
        expect(coreDebugLogMock).toHaveBeenCalledOnce();
        expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
          `
          "Fetched Jobs for Run:
            Repository: owner/repository
            Run ID: 123456
            Jobs: []"
        `,
        );
      });

      it("should return even if GitHub fails to return a URL", async () => {
        inProgressMockData.jobs[0].html_url = null;

        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: inProgressMockData,
            status: 200,
            headers: {},
          }),
        );

        // Behaviour
        const url = await fetchWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual("GitHub failed to return the URL");

        // Logging
        assertOnlyCalled(coreDebugLogMock);
        expect(coreDebugLogMock).toHaveBeenCalledOnce();
        expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
          `
          "Fetched Jobs for Run:
            Repository: owner/repository
            Run ID: 123456
            Jobs: [test-run (in_progress)]"
        `,
        );
      });

      describe("fetchWorkflowRunActiveJobUrlRetry", () => {
        beforeEach(() => {
          vi.useFakeTimers();
        });

        afterEach(() => {
          vi.useRealTimers();
        });

        it("should return a message if no job is found", async () => {
          inProgressMockData.jobs[0].status = "unknown";

          vi.spyOn(
            mockOctokit.rest.actions,
            "listJobsForWorkflowRun",
          ).mockReturnValue(
            Promise.resolve({
              data: inProgressMockData,
              status: 200,
              headers: {},
            }),
          );

          // Behaviour
          const urlPromise = fetchWorkflowRunActiveJobUrlRetry(123456, 100);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const result = await urlPromise;

          if (result.success) {
            expect.fail();
          }

          expect(result.success).toStrictEqual(false);
          expect(result.reason).toStrictEqual("timeout");

          // Logging
          assertOnlyCalled(coreDebugLogMock);
          expect(coreDebugLogMock).toHaveBeenCalledTimes(3);
          expect(coreDebugLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
            `
            "Fetched Jobs for Run:
              Repository: owner/repository
              Run ID: 123456
              Jobs: []"
          `,
          );
          expect(coreDebugLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(
            `"No 'in_progress' or 'completed' Jobs found for Workflow Run 123456, retrying..."`,
          );
          expect(coreDebugLogMock.mock.calls[2]?.[0]).toMatchInlineSnapshot(
            `"Timed out while trying to fetch URL for Workflow Run 123456"`,
          );
        });

        it("should return a message if no job is found within the timeout period", async () => {
          vi.spyOn(mockOctokit.rest.actions, "listJobsForWorkflowRun")
            // Final
            .mockImplementation(() => {
              inProgressMockData.jobs[0].status = "in_progress";

              return Promise.resolve({
                data: inProgressMockData,
                status: 200,
                headers: {},
              });
            })
            // First
            .mockImplementationOnce(() => {
              inProgressMockData.jobs[0].status = "unknown";

              return Promise.resolve({
                data: inProgressMockData,
                status: 200,
                headers: {},
              });
            })
            // Second
            .mockImplementationOnce(() =>
              Promise.resolve({
                data: inProgressMockData,
                status: 200,
                headers: {},
              }),
            );

          // Behaviour
          const urlPromise = fetchWorkflowRunActiveJobUrlRetry(123456, 200);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const result = await urlPromise;

          if (result.success) {
            expect.fail();
          }

          expect(result.success).toStrictEqual(false);
          expect(result.reason).toStrictEqual("timeout");

          // Logging
          assertOnlyCalled(coreDebugLogMock);
          expect(coreDebugLogMock).toHaveBeenCalledTimes(3);
          expect(coreDebugLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
            "Fetched Jobs for Run:
              Repository: owner/repository
              Run ID: 123456
              Jobs: []"
          `);
          expect(coreDebugLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(
            `"No 'in_progress' or 'completed' Jobs found for Workflow Run 123456, retrying..."`,
          );
          expect(coreDebugLogMock.mock.calls[2]?.[0]).toMatchInlineSnapshot(
            `"Timed out while trying to fetch URL for Workflow Run 123456"`,
          );
        });

        it("should return a URL if an in_progress job is found", async () => {
          vi.spyOn(
            mockOctokit.rest.actions,
            "listJobsForWorkflowRun",
          ).mockImplementation(() =>
            Promise.resolve({
              data: inProgressMockData,
              status: 200,
              headers: {},
            }),
          );

          // Behaviour
          const urlPromise = fetchWorkflowRunActiveJobUrlRetry(123456, 200);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const result = await urlPromise;

          if (!result.success) {
            expect.fail();
          }

          expect(result.success).toStrictEqual(true);
          expect(result.value).toStrictEqual(
            inProgressMockData.jobs[0]?.html_url,
          );

          // Logging
          assertOnlyCalled(coreDebugLogMock);
          expect(coreDebugLogMock).toHaveBeenCalledOnce();
          expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(`
            "Fetched Jobs for Run:
              Repository: owner/repository
              Run ID: 123456
              Jobs: [test-run (in_progress)]"
          `);
        });
      });
    });
  });

  describe("retryOnError", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return a success result", async () => {
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementation(() => Promise.resolve("completed"));

      // Behaviour
      const result = await retryOnError(() => testFunc(), 5000);
      if (!result.success) {
        expect.fail();
      }
      expect(result.success).toStrictEqual(true);
      expect(result.value).toStrictEqual("completed");

      // Logging
      assertNoneCalled();
    });

    it("should retry a function if it throws an error", async () => {
      const errorMsg = "some error";
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementation(() => Promise.resolve("completed"))
        .mockImplementationOnce(() => Promise.reject(new Error(errorMsg)));

      // Behaviour
      const retryPromise = retryOnError(testFunc, 5000);
      // Progress timers to first failure
      await vi.advanceTimersByTimeAsync(1000);

      // Logging
      assertOnlyCalled(coreWarningLogMock);
      expect(coreWarningLogMock).toHaveBeenCalledOnce();
      expect(coreWarningLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
        "retryOnError: An unexpected error has occurred:
          name: spy
          error: some error"
      `);
      expect(coreWarningLogMock.mock.calls[0]?.[0]).toContain(testFunc.name);
      coreWarningLogMock.mockReset();

      // Behaviour
      // Progress timers to second success
      await vi.advanceTimersByTimeAsync(1000);
      const result = await retryPromise;
      if (!result.success) {
        expect.fail();
      }

      expect(result.success).toStrictEqual(true);
      expect(result.value).toStrictEqual("completed");

      // Logging
      assertNoneCalled();
    });

    it("should display a fallback function name if none is available", async () => {
      const errorMsg = "some error";
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(() => Promise.reject(new Error(errorMsg)));

      // Behaviour
      // Use anonymous function
      const retryPromise = retryOnError(() => testFunc(), 5000);
      // Progress timers to first failure
      await vi.advanceTimersByTimeAsync(1000);
      // Clean up promise
      await retryPromise;

      // Logging
      assertOnlyCalled(coreWarningLogMock);
      expect(coreWarningLogMock).toHaveBeenCalledOnce();
      expect(coreWarningLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
        "retryOnError: An unexpected error has occurred:
          name: anonymous function
          error: some error"
      `);
      coreWarningLogMock.mockReset();
    });

    it("should return a timeout result", async () => {
      const errorMsg = "some error";
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          throw new Error(errorMsg);
        });

      // Behaviour
      const retryPromise = retryOnError(() => testFunc(), 500);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await retryPromise;

      if (result.success) {
        expect.fail();
      }

      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("timeout");

      // Logging
      assertNoneCalled();
    });
  });
});
