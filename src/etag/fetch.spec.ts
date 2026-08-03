import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { mockLoggingFunctions } from "../test-utils/logging.mock.ts";

import { resetEtagCache } from "./cache.ts";
import { withEtagCache } from "./fetch.ts";

vi.mock("@actions/core");

interface StubResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

interface StubCall {
  url: string;
  method: string;
  ifNoneMatch: string | null;
}

type FetchFn = typeof globalThis.fetch;

interface StubFetch {
  fetch: FetchFn;
  calls: StubCall[];
}

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * A transport that records what it was asked for.
 */
function stubFetch(responder: (call: StubCall) => StubResponse): StubFetch {
  const calls: StubCall[] = [];

  const fetch: FetchFn = (input, init) => {
    const headers = new Headers(init?.headers);
    const call: StubCall = {
      url: urlOf(input),
      method: init?.method ?? "GET",
      ifNoneMatch: headers.get("if-none-match"),
    };
    calls.push(call);

    const { status, body, headers: responseHeaders } = responder(call);
    return Promise.resolve(
      new Response(status === 304 ? null : (body ?? ""), {
        status,
        headers: responseHeaders,
      }),
    );
  };

  return { fetch, calls };
}

const ETAG = 'W/"37c2311495bbea359329d0bb72561bdb2b2fffea"';

/**
 * A resource that is unchanged after the first request.
 */
function unchangingResource(body = '{"status":"in_progress"}'): StubFetch {
  return stubFetch(({ ifNoneMatch }): StubResponse =>
    ifNoneMatch === ETAG
      ? { status: 304, headers: { etag: ETAG } }
      : {
          status: 200,
          body,
          headers: { "content-type": "application/json", etag: ETAG },
        },
  );
}

const URL_A = "https://api.github.com/repos/o/r/actions/runs/1";
const URL_B = "https://api.github.com/repos/o/r/actions/runs/2";

describe("etag-fetch", () => {
  const { coreDebugLogMock, assertOnlyCalled, assertNoneCalled } =
    mockLoggingFunctions();

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    resetEtagCache();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("withEtagCache", () => {
    it("should not condition the first request for a resource", async () => {
      const stub = unchangingResource();

      // Behaviour
      const response = await withEtagCache(stub.fetch)(URL_A);
      expect(response.status).toStrictEqual(200);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.ifNoneMatch).toBeNull();

      // Logging
      assertNoneCalled();
    });

    it("should send the saved etag verbatim on a repeat request", async () => {
      const stub = unchangingResource();
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A);
      await fetch(URL_A);
      expect(stub.calls).toHaveLength(2);
      // Trimming the prefix or quotes would leave a value GitHub cannot match.
      expect(stub.calls[1]?.ifNoneMatch).toStrictEqual(ETAG);
    });

    it("should replay the saved body as a 200 when the server answers 304", async () => {
      const stub = unchangingResource('{"status":"queued"}');
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A);
      const response = await fetch(URL_A);
      expect(response.status).toStrictEqual(200);
      expect(response.headers.get("content-type")).toStrictEqual(
        "application/json",
      );
      await expect(response.json()).resolves.toStrictEqual({
        status: "queued",
      });

      // Logging
      assertOnlyCalled(coreDebugLogMock);
      expect(coreDebugLogMock).toHaveBeenCalledOnce();
      expect(coreDebugLogMock.mock.lastCall?.[0]).toMatchInlineSnapshot(
        `"Reusing cached response for GET https://api.github.com/repos/o/r/actions/runs/1 ()"`,
      );
    });

    it("should replay a saved body more than once", async () => {
      const stub = unchangingResource();
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A);
      const bodies: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        bodies.push(await (await fetch(URL_A)).json());
      }
      expect(bodies).toStrictEqual(
        Array.from({ length: 3 }, () => ({ status: "in_progress" })),
      );
    });

    it("should take the rate limit headers from the 304 rather than the saved response", async () => {
      const stub = stubFetch(({ ifNoneMatch }): StubResponse =>
        ifNoneMatch === ETAG
          ? {
              status: 304,
              headers: { etag: ETAG, "x-ratelimit-remaining": "4999" },
            }
          : {
              status: 200,
              body: "{}",
              headers: {
                "content-type": "application/json",
                etag: ETAG,
                "x-ratelimit-remaining": "4998",
              },
            },
      );
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A);
      const response = await fetch(URL_A);
      expect(response.headers.get("x-ratelimit-remaining")).toStrictEqual(
        "4999",
      );
    });

    it("should not condition a non-GET request", async () => {
      const stub = unchangingResource();
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A);
      await fetch(URL_A, { method: "POST" });
      expect(stub.calls[1]?.ifNoneMatch).toBeNull();
    });

    it("should not cache a response that carries no etag", async () => {
      const stub = stubFetch(() => ({
        status: 200,
        body: "{}",
        headers: { "content-type": "application/json" },
      }));
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A);
      await fetch(URL_A);
      expect(stub.calls[1]?.ifNoneMatch).toBeNull();
    });

    it("should not cache a 2xx other than 200, as replay reconstructs a 200", async () => {
      const stub = stubFetch(() => ({
        status: 203,
        body: "{}",
        headers: { "content-type": "application/json", etag: ETAG },
      }));
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A);
      await fetch(URL_A);
      expect(stub.calls[1]?.ifNoneMatch).toBeNull();
    });

    it("should pass a 304 through untouched when nothing is cached for it", async () => {
      const stub = stubFetch(() => ({ status: 304, headers: { etag: ETAG } }));

      // Behaviour
      const response = await withEtagCache(stub.fetch)(URL_A, {
        headers: { "if-none-match": ETAG },
      });
      expect(response.status).toStrictEqual(304);

      // Logging
      assertNoneCalled();
    });

    it("should cache each URL separately", async () => {
      const stub = unchangingResource();
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A);
      await fetch(URL_B);
      expect(stub.calls[1]?.ifNoneMatch).toBeNull();
    });

    it("should cache each negotiated media type separately", async () => {
      const stub = unchangingResource();
      const fetch = withEtagCache(stub.fetch);

      // Behaviour
      await fetch(URL_A, { headers: { accept: "application/json" } });
      await fetch(URL_A, { headers: { accept: "application/vnd.github.raw" } });
      expect(stub.calls[1]?.ifNoneMatch).toBeNull();
    });
  });
});
