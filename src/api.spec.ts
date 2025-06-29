import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import {
  getWorkflowRunActiveJobUrl,
  getWorkflowRunActiveJobUrlRetry,
  getWorkflowRunFailedJobs,
  getWorkflowRunState,
  init,
  retryOnError,
} from "./api.ts";
import { clearEtags } from "./etags.ts";

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

  beforeEach(() => {
    vi.spyOn(core, "getInput").mockReturnValue("");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.spyOn(github, "getOctokit").mockReturnValue(mockOctokit as any);
    init(cfg);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getWorkflowRunState", () => {
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

      const state = await getWorkflowRunState(123456);
      expect(state.conclusion).toStrictEqual(mockData.conclusion);
      expect(state.status).toStrictEqual(mockData.status);
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

      await expect(getWorkflowRunState(0)).rejects.toThrow(
        `Failed to get Workflow Run state, expected 200 but received ${errorStatus}`,
      );
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

  describe("getWorkflowRunJobs", () => {
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

    describe("getWorkflowRunFailedJobs", () => {
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

        const jobs = await getWorkflowRunFailedJobs(123456);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.id).toStrictEqual(mockData.jobs[0]?.id);
        expect(jobs[0]?.name).toStrictEqual(mockData.jobs[0]?.name);
        expect(jobs[0]?.status).toStrictEqual(mockData.jobs[0]?.status);
        expect(jobs[0]?.conclusion).toStrictEqual(mockData.jobs[0]?.conclusion);
        expect(jobs[0]?.url).toStrictEqual(mockData.jobs[0]?.html_url);
        expect(Array.isArray(jobs[0]?.steps)).toStrictEqual(true);
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

        await expect(getWorkflowRunFailedJobs(0)).rejects.toThrow(
          `Failed to get Jobs for Workflow Run, expected 200 but received ${errorStatus}`,
        );
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

        const { steps } = (await getWorkflowRunFailedJobs(123456))[0]!;
        expect(steps).toHaveLength(mockData.jobs[0]!.steps.length);
        for (let i = 0; i < mockSteps.length; i++) {
          expect(steps[i]?.name).toStrictEqual(mockSteps[i]?.name);
          expect(steps[i]?.number).toStrictEqual(mockSteps[i]?.number);
          expect(steps[i]?.status).toStrictEqual(mockSteps[i]?.status);
          expect(steps[i]?.conclusion).toStrictEqual(mockSteps[i]?.conclusion);
        }
      });
    });

    describe("getWorkflowRunActiveJobUrl", () => {
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

        const url = await getWorkflowRunActiveJobUrl(123456);
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

        const url = await getWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual(mockData.jobs[0]?.html_url);
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

        await expect(getWorkflowRunActiveJobUrl(0)).rejects.toThrow(
          `Failed to get Jobs for Workflow Run, expected 200 but received ${errorStatus}`,
        );
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

        const url = await getWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual(undefined);
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

        const url = await getWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual("GitHub failed to return the URL");
      });

      describe("getWorkflowRunActiveJobUrlRetry", () => {
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

          const urlPromise = getWorkflowRunActiveJobUrlRetry(123456, 100);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const url = await urlPromise;
          expect(url).toStrictEqual("Unable to fetch URL");
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

          const urlPromise = getWorkflowRunActiveJobUrlRetry(123456, 200);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const url = await urlPromise;
          expect(url).toStrictEqual("Unable to fetch URL");
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

          const urlPromise = getWorkflowRunActiveJobUrlRetry(123456, 200);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const url = await urlPromise;
          expect(url).toStrictEqual(inProgressMockData.jobs[0]?.html_url);
        });
      });
    });
  });

  describe("retryOnError", () => {
    let warningLogSpy: MockInstance<typeof console.warn>;

    beforeEach(() => {
      vi.useFakeTimers();
      warningLogSpy = vi.spyOn(core, "warning");
    });

    afterEach(() => {
      vi.useRealTimers();
      warningLogSpy.mockRestore();
    });

    it("should retry a function if it throws an error", async () => {
      const funcName = "testFunc";
      const errorMsg = "some error";
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementation(() => Promise.resolve("completed"))
        .mockImplementationOnce(() => Promise.reject(Error(errorMsg)));

      const retryPromise = retryOnError(() => testFunc(), funcName);

      // Progress timers to first failure
      vi.advanceTimersByTime(500);
      await vi.advanceTimersByTimeAsync(500);

      expect(warningLogSpy).toHaveBeenCalledOnce();
      expect(warningLogSpy).toHaveBeenCalledWith(
        "retryOnError: An unexpected error has occurred:\n" +
          `  name: ${funcName}\n` +
          `  error: ${errorMsg}`,
      );

      // Progress timers to second success
      vi.advanceTimersByTime(500);
      await vi.advanceTimersByTimeAsync(500);
      const result = await retryPromise;

      expect(warningLogSpy).toHaveBeenCalledOnce();
      expect(result).toStrictEqual("completed");
    });

    it("should throw the original error if timed out while calling the function", async () => {
      const funcName = "testFunc";
      const errorMsg = "some error";
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          throw new Error(errorMsg);
        });

      const retryPromise = retryOnError(() => testFunc(), funcName, 500);

      vi.advanceTimersByTime(500);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      vi.advanceTimersByTimeAsync(500);

      await expect(retryPromise).rejects.toThrowError("some error");
    });
  });
});
