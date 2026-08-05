import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ActionConfig } from "./action.ts";
import { resetEtagCache } from "./etag/cache.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";

/**
 * Leaves `@actions/github` unmocked, unlike api.spec.ts, so a real Octokit
 * handles the 304 it would otherwise raise as an `HttpError`.
 *
 * Responses are keyed on request count rather than `If-None-Match`. Keying on
 * the header would pass against a client that never sends one.
 */
const transport = vi.hoisted(() => {
  type FetchInit = Parameters<typeof globalThis.fetch>[1];

  interface Call {
    url: string;
    ifNoneMatch: string | null;
  }

  const calls: Call[] = [];
  let responder: ((callNo: number) => Response) | undefined;

  return {
    calls,
    respondWith: (next: (callNo: number) => Response): void => {
      responder = next;
    },
    reset: (): void => {
      calls.length = 0;
      responder = undefined;
    },
    fetch: (url: string, init?: FetchInit): Promise<Response> => {
      const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
      calls.push({ url, ifNoneMatch });

      if (responder === undefined) {
        throw new Error("transport was called before a responder was set");
      }
      return Promise.resolve(responder(calls.length));
    },
  };
});

// `api.ts` wraps this fetch, so replacing it puts the transport under Octokit.
vi.mock("@actions/github/lib/utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@actions/github/lib/utils")>();
  return {
    ...actual,
    defaults: {
      ...actual.defaults,
      request: { ...actual.defaults.request, fetch: transport.fetch },
    },
  };
});

vi.mock("@actions/core");

const { fetchWorkflowRunState, init } = await import("./api.ts");

const ETAG = 'W/"37c2311495bbea359329d0bb72561bdb2b2fffea"';

function runResponse(
  state: { status: string; conclusion: string | null },
  etag: string,
): Response {
  return new Response(JSON.stringify(state), {
    status: 200,
    headers: { "content-type": "application/json", etag },
  });
}

const IN_PROGRESS = { status: "in_progress", conclusion: null };
const COMPLETED = { status: "completed", conclusion: "success" };

function notModified(): Response {
  return new Response(null, { status: 304, headers: { etag: ETAG } });
}

describe("API conditional requests", () => {
  const cfg: ActionConfig = {
    token: "secret",
    repo: "repository",
    owner: "owner",
    runId: 123456,
    runTimeoutSeconds: 300,
    cancelTimeoutSeconds: undefined,
    pollIntervalMs: 2500,
  };

  mockLoggingFunctions();

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    transport.reset();
    resetEtagCache();
    init(cfg);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should route Octokit's requests through the ETag caching fetch", async () => {
    transport.respondWith(() => runResponse(IN_PROGRESS, ETAG));

    // Behaviour
    await fetchWorkflowRunState(cfg.runId);
    expect(transport.calls).toStrictEqual([
      {
        url: `https://api.github.com/repos/owner/repository/actions/runs/${cfg.runId}`,
        ifNoneMatch: null,
      },
    ]);
  });

  it("should condition a repeat poll on the ETag Octokit received", async () => {
    transport.respondWith(() => runResponse(IN_PROGRESS, ETAG));

    // Behaviour
    await fetchWorkflowRunState(cfg.runId);
    await fetchWorkflowRunState(cfg.runId);
    expect(transport.calls[1]?.ifNoneMatch).toStrictEqual(ETAG);
  });

  it("should return the saved state when GitHub answers 304", async () => {
    transport.respondWith((callNo) =>
      callNo === 1 ? runResponse(IN_PROGRESS, ETAG) : notModified(),
    );

    // Behaviour
    const first = await fetchWorkflowRunState(cfg.runId);
    // Octokit would reject with an HttpError were the 304 left to it.
    await expect(fetchWorkflowRunState(cfg.runId)).resolves.toStrictEqual(
      first,
    );
    expect(transport.calls).toHaveLength(2);
  });

  it("should return the fresh state when the run has changed", async () => {
    transport.respondWith((callNo) =>
      callNo === 1
        ? runResponse(IN_PROGRESS, ETAG)
        : runResponse(COMPLETED, 'W/"changed"'),
    );

    // Behaviour
    await fetchWorkflowRunState(cfg.runId);
    await expect(fetchWorkflowRunState(cfg.runId)).resolves.toStrictEqual({
      status: "completed",
      conclusion: "success",
    });
  });
});
