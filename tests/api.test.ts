import * as core from "@actions/core";
import * as github from "@actions/github";

import {
  getWorkflowRunFailedJobs,
  getWorkflowRunState,
  init,
} from "../src/api";

interface MockResponse {
  data: any;
  status: number;
}

const mockOctokit = {
  rest: {
    actions: {
      getWorkflowRun: async (_req?: any): Promise<MockResponse> => {
        throw new Error("Should be mocked");
      },
      listJobsForWorkflowRun: async (_req?: any): Promise<MockResponse> => {
        throw new Error("Should be mocked");
      },
    },
  },
};

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
    jest.spyOn(core, "getInput").mockReturnValue("");
    jest.spyOn(github, "getOctokit").mockReturnValue(mockOctokit as any);
    init(cfg);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("getWorkflowRunState", () => {
    it("should return the workflow run state for a given run ID", async () => {
      const mockData = {
        status: "completed",
        conclusion: "cancelled",
      };
      jest.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockReturnValue(
        Promise.resolve({
          data: mockData,
          status: 200,
        })
      );

      const state = await getWorkflowRunState(123456);
      expect(state.conclusion).toStrictEqual(mockData.conclusion);
      expect(state.status).toStrictEqual(mockData.status);
    });

    it("should throw if a non-200 status is returned", async () => {
      const errorStatus = 401;
      jest.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockReturnValue(
        Promise.resolve({
          data: undefined,
          status: errorStatus,
        })
      );

      await expect(getWorkflowRunState(0)).rejects.toThrow(
        `Failed to get Workflow Run state, expected 200 but received ${errorStatus}`
      );
    });
  });

  describe("getWorkflowRunFailedJobs", () => {
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

    it("should return the jobs for a failed workflow run given a run ID", async () => {
      jest
        .spyOn(mockOctokit.rest.actions, "listJobsForWorkflowRun")
        .mockReturnValue(
          Promise.resolve({
            data: mockData,
            status: 200,
          })
        );

      const jobs = await getWorkflowRunFailedJobs(123456);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toStrictEqual(mockData.jobs[0].id);
      expect(jobs[0].name).toStrictEqual(mockData.jobs[0].name);
      expect(jobs[0].status).toStrictEqual(mockData.jobs[0].status);
      expect(jobs[0].conclusion).toStrictEqual(mockData.jobs[0].conclusion);
      expect(jobs[0].url).toStrictEqual(mockData.jobs[0].html_url);
      expect(Array.isArray(jobs[0].steps)).toStrictEqual(true);
    });

    it("should throw if a non-200 status is returned", async () => {
      const errorStatus = 401;
      jest
        .spyOn(mockOctokit.rest.actions, "listJobsForWorkflowRun")
        .mockReturnValue(
          Promise.resolve({
            data: undefined,
            status: errorStatus,
          })
        );

      await expect(getWorkflowRunFailedJobs(0)).rejects.toThrow(
        `Failed to get Jobs for Workflow Run, expected 200 but received ${errorStatus}`
      );
    });

    it("should return the steps for a failed Job", async () => {
      const mockSteps = mockData.jobs[0].steps;
      jest
        .spyOn(mockOctokit.rest.actions, "listJobsForWorkflowRun")
        .mockReturnValue(
          Promise.resolve({
            data: mockData,
            status: 200,
          })
        );

      const { steps } = (await getWorkflowRunFailedJobs(123456))[0];
      expect(steps).toHaveLength(mockData.jobs[0].steps.length);
      for (let i = 0; i < mockSteps.length; i++) {
        expect(steps[i].name).toStrictEqual(mockSteps[i].name);
        expect(steps[i].number).toStrictEqual(mockSteps[i].number);
        expect(steps[i].status).toStrictEqual(mockSteps[i].status);
        expect(steps[i].conclusion).toStrictEqual(mockSteps[i].conclusion);
      }
    });
  });
});
