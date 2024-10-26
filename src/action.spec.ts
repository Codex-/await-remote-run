import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ActionConfig, getConfig } from "./action.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";

vi.mock("@actions/core");

describe("Action", () => {
  const { assertNoneCalled } = mockLoggingFunctions();

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

      vi.spyOn(core, "getInput").mockImplementation((input: string) => {
        /* eslint-disable @typescript-eslint/no-unsafe-return */
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
        /* eslint-enable @typescript-eslint/no-unsafe-return */
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should return a valid config", () => {
      // Behaviour
      const config: ActionConfig = getConfig();

      // Assert that the numbers / types have been properly loaded.
      expect(config.token).toStrictEqual("secret");
      expect(config.repo).toStrictEqual("repository");
      expect(config.owner).toStrictEqual("owner");
      expect(config.runId).toStrictEqual(123456);
      expect(config.runTimeoutSeconds).toStrictEqual(300);
      expect(config.pollIntervalMs).toStrictEqual(2500);

      // Logging
      assertNoneCalled();
    });

    it("should provide a default run timeout if none is supplied", () => {
      mockEnvConfig.run_timeout_seconds = "";

      // Behaviour
      const config: ActionConfig = getConfig();
      expect(config.runTimeoutSeconds).toStrictEqual(300);

      // Logging
      assertNoneCalled();
    });

    it("should provide a default polling interval if none is supplied", () => {
      mockEnvConfig.poll_interval_ms = "";

      // Behaviour
      const config: ActionConfig = getConfig();
      expect(config.pollIntervalMs).toStrictEqual(5000);

      // Logging
      assertNoneCalled();
    });

    it("should throw if an invalid number value is provided", () => {
      mockEnvConfig.run_timeout_seconds = "invalid value";

      // Behaviour
      expect(() => getConfig()).toThrowError(
        "Unable to parse value: invalid value",
      );

      // Logging
      assertNoneCalled();
    });

    it("should throw if no run ID value is provided", () => {
      mockEnvConfig.run_id = "";

      // Behaviour
      expect(() => getConfig()).toThrowError("Run ID must be provided");

      // Logging
      assertNoneCalled();
    });
  });
});
