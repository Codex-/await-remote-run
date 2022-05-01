import * as core from "@actions/core";
import { ActionConfig, getConfig } from "./action";

describe("Action", () => {
  describe("getConfig", () => {
    // Represent the process.env inputs.
    let mockEnvConfig: any;

    beforeEach(() => {
      mockEnvConfig = {
        token: "secret",
        repo: "repository",
        owner: "owner",
        run_id: "123456",
        run_timeout_seconds: "300",
        poll_interval_ms: "2500",
      };

      jest.spyOn(core, "getInput").mockImplementation((input: string) => {
        switch (input) {
          case "token":
            return mockEnvConfig.token;
          case "repo":
            return mockEnvConfig.repo;
          case "owner":
            return mockEnvConfig.owner;
          case "run_id":
            return mockEnvConfig.run_id;
          case "run_timeout_seconds":
            return mockEnvConfig.run_timeout_seconds;
          case "poll_interval_ms":
            return mockEnvConfig.poll_interval_ms;
          default:
            throw new Error("invalid input requested");
        }
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("should return a valid config", () => {
      const config: ActionConfig = getConfig();

      // Assert that the numbers / types have been properly loaded.
      expect(config.token).toStrictEqual("secret");
      expect(config.repo).toStrictEqual("repository");
      expect(config.owner).toStrictEqual("owner");
      expect(config.runId).toStrictEqual(123456);
      expect(config.runTimeoutSeconds).toStrictEqual(300);
      expect(config.pollIntervalMs).toStrictEqual(2500);
    });

    it("should provide a default run timeout if none is supplied", () => {
      mockEnvConfig.run_timeout_seconds = "";
      const config: ActionConfig = getConfig();

      expect(config.runTimeoutSeconds).toStrictEqual(300);
    });

    it("should provide a default polling interval if none is supplied", () => {
      mockEnvConfig.poll_interval_ms = "";
      const config: ActionConfig = getConfig();

      expect(config.pollIntervalMs).toStrictEqual(5000);
    });
  });
});
