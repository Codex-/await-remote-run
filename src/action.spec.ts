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
        cancel_timeout_seconds: "",
        poll_interval_ms: "2500",
        jobs: "",
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
          case "cancel_timeout_seconds":
            return mockEnvConfig.cancel_timeout_seconds;
          case "poll_interval_ms":
            return mockEnvConfig.poll_interval_ms;
          case "jobs":
            return mockEnvConfig.jobs;
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
      expect(config.cancelTimeoutSeconds).toBeUndefined();
      expect(config.pollIntervalMs).toStrictEqual(2500);
      expect(config.jobs).toBeUndefined();

      // Logging
      assertNoneCalled();
    });

    describe("jobs", () => {
      it("should split jobs on newlines", () => {
        mockEnvConfig.jobs = "build\ntest\n";

        // Behaviour
        const config: ActionConfig = getConfig();
        expect(config.jobs).toStrictEqual(["build", "test"]);

        // Logging
        assertNoneCalled();
      });

      it("should not split a matrix job name on its commas", () => {
        mockEnvConfig.jobs = "build (ubuntu-latest, 20)";

        // Behaviour
        const config: ActionConfig = getConfig();
        expect(config.jobs).toStrictEqual(["build (ubuntu-latest, 20)"]);

        // Logging
        assertNoneCalled();
      });

      it("should trim surrounding whitespace and drop blank entries", () => {
        mockEnvConfig.jobs = "  build  \n\n   \n\ttest\t\n";

        // Behaviour
        const config: ActionConfig = getConfig();
        expect(config.jobs).toStrictEqual(["build", "test"]);

        // Logging
        assertNoneCalled();
      });

      it("should discard duplicate job names", () => {
        mockEnvConfig.jobs = "build\ntest\nbuild";

        // Behaviour
        const config: ActionConfig = getConfig();
        expect(config.jobs).toStrictEqual(["build", "test"]);

        // Logging
        assertNoneCalled();
      });

      it.each([
        { jobs: "", label: "an empty input" },
        { jobs: "\n  \n", label: "only blanks" },
      ])("should be undefined for $label", ({ jobs }) => {
        mockEnvConfig.jobs = jobs;

        // Behaviour
        const config: ActionConfig = getConfig();
        expect(config.jobs).toBeUndefined();

        // Logging
        assertNoneCalled();
      });
    });

    it("should return cancel_timeout_seconds if one is supplied", () => {
      mockEnvConfig.cancel_timeout_seconds = "120";

      // Behaviour
      const config: ActionConfig = getConfig();
      expect(config.cancelTimeoutSeconds).toStrictEqual(120);

      // Logging
      assertNoneCalled();
    });

    it.each(["0", "-1"])(
      "should throw if cancel_timeout_seconds (%s) is not positive",
      (cancelTimeoutSeconds) => {
        mockEnvConfig.cancel_timeout_seconds = cancelTimeoutSeconds;

        // Behaviour
        expect(() => getConfig()).toThrow(
          `cancel_timeout_seconds (${cancelTimeoutSeconds}) must be a positive number.`,
        );

        // Logging
        assertNoneCalled();
      },
    );

    it.each(["300", "301"])(
      "should throw if cancel_timeout_seconds (%s) is not less than run_timeout_seconds",
      (cancelTimeoutSeconds) => {
        mockEnvConfig.cancel_timeout_seconds = cancelTimeoutSeconds;

        // Behaviour
        expect(() => getConfig()).toThrow(
          `cancel_timeout_seconds (${cancelTimeoutSeconds}) must be less than run_timeout_seconds (300).`,
        );

        // Logging
        assertNoneCalled();
      },
    );

    it("should compare cancel_timeout_seconds against the default run_timeout_seconds", () => {
      mockEnvConfig.run_timeout_seconds = "";
      mockEnvConfig.cancel_timeout_seconds = "600";

      // Behaviour
      expect(() => getConfig()).toThrow(
        "cancel_timeout_seconds (600) must be less than run_timeout_seconds (300).",
      );

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
      expect(() => getConfig()).toThrow("Unable to parse value: invalid value");

      // Logging
      assertNoneCalled();
    });

    it("should throw if no run ID value is provided", () => {
      mockEnvConfig.run_id = "";

      // Behaviour
      expect(() => getConfig()).toThrow("Run ID must be provided");

      // Logging
      assertNoneCalled();
    });
  });
});
