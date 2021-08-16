import * as core from "@actions/core";
import * as github from "@actions/github";

import { getWorkflowRunState, init } from "../src/api";

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
});
