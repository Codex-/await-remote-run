import * as core from "@actions/core";

import {
  getCachedResponse,
  setCachedResponse,
  type CachedResponse,
} from "./cache.ts";

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

/**
 * Wrap a fetch implementation so every GET is issued as a conditional request.
 *
 * GitHub does not charge a 304 against the primary rate limit, provided the
 * request carries an `Authorization` header, so polling an unchanged resource
 * becomes effectively free.
 * See: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests
 *
 * A 304 is converted back into a 200, as `@octokit/request` raises an
 * `HttpError` for any 304 it is handed.
 *
 * Pass the fetch Octokit would otherwise have used rather than
 * `globalThis.fetch`, so proxy configuration is preserved.
 */
export function withEtagCache(baseFetch: FetchFn): FetchFn {
  return async function etagFetch(input, init) {
    const method = requestMethod(input, init);
    const url = requestUrl(input);
    const headers = requestHeaders(input, init);
    const key = cacheKey(method, url, headers);

    const cached = method === "GET" ? getCachedResponse(key) : undefined;
    if (cached !== undefined) {
      // Sent verbatim, as a bare token is not a valid entity-tag and so never
      // matches. https://www.rfc-editor.org/rfc/rfc9110#field.if-none-match
      headers.set("if-none-match", cached.etag);
    }

    const response = await baseFetch(input, { ...init, headers });

    if (response.status === 304 && cached !== undefined) {
      core.debug(`Reusing cached response for ${key}`);
      return replayCached(cached, response);
    }

    // Only a 200 is cached, as `replayCached` reconstructs the entry with
    // that status. https://www.rfc-editor.org/rfc/rfc9110#status.304
    if (method === "GET" && response.status === 200) {
      const etag = response.headers.get("etag");
      if (etag !== null) {
        setCachedResponse(key, {
          etag,
          body: await response.clone().arrayBuffer(),
          headers: [...response.headers],
        });
      }
    }

    return response;
  };
}

/**
 * Describe the wire representation, which no longer matches the decoded buffer
 * being replayed.
 * See: https://www.rfc-editor.org/rfc/rfc9110#field.content-encoding
 */
const REPRESENTATION_HEADERS = new Set(["content-encoding", "content-length"]);

/**
 * A 304 must carry these, and its rate limit counters are live, so both
 * supersede the copies saved alongside the body.
 * See: https://www.rfc-editor.org/rfc/rfc9110#status.304
 */
const REFRESHED_HEADERS = new Set(["date", "etag"]);

function replayCached(cached: CachedResponse, response: Response): Response {
  const headers = new Headers(cached.headers);
  for (const name of REPRESENTATION_HEADERS) {
    headers.delete(name);
  }
  for (const [name, value] of response.headers) {
    if (REFRESHED_HEADERS.has(name) || name.startsWith("x-ratelimit-")) {
      headers.set(name, value);
    }
  }

  const replay = new Response(cached.body, {
    status: 200,
    statusText: "OK",
    headers,
  });
  // A constructed Response reports `url` as empty, which Octokit surfaces.
  // https://fetch.spec.whatwg.org/#dom-response-url
  Object.defineProperty(replay, "url", { value: response.url });

  return replay;
}

/**
 * A saved representation is only interchangeable for the same method, URL, and
 * negotiated media type. `accept` stands in for a full `Vary` treatment.
 * See: https://www.rfc-editor.org/rfc/rfc9111#caching.negotiated.responses
 */
function cacheKey(method: string, url: string, headers: Headers): string {
  return `${method} ${url} (${headers.get("accept") ?? ""})`;
}

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function requestMethod(input: FetchInput, init?: FetchInit): string {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

/**
 * Follows the fetch rule that an `init` supplying headers replaces those on a
 * `Request` input.
 * See: https://fetch.spec.whatwg.org/#dom-request
 */
function requestHeaders(input: FetchInput, init?: FetchInit): Headers {
  return new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
}
