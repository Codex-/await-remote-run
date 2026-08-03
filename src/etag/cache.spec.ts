import { beforeEach, describe, expect, it } from "vitest";

import { ETAG_CACHE_MAX_ENTRIES } from "../constants.ts";

import {
  getCachedResponse,
  resetEtagCache,
  setCachedResponse,
  type CachedResponse,
} from "./cache.ts";

function entry(etag: string): CachedResponse {
  return { etag, body: new ArrayBuffer(0), headers: [] };
}

describe("etag-cache", () => {
  beforeEach(() => {
    resetEtagCache();
  });

  it("should return nothing for a key that was never saved", () => {
    // Behaviour
    expect(getCachedResponse("absent")).toBeUndefined();
  });

  it("should return a saved entry", () => {
    // Behaviour
    setCachedResponse("a", entry("etag-a"));
    expect(getCachedResponse("a")?.etag).toStrictEqual("etag-a");
  });

  it("should replace an entry saved against the same key", () => {
    // Behaviour
    setCachedResponse("a", entry("stale"));
    setCachedResponse("a", entry("fresh"));
    expect(getCachedResponse("a")?.etag).toStrictEqual("fresh");
  });

  it("should retain entries up to the cap", () => {
    // Behaviour
    for (let i = 0; i < ETAG_CACHE_MAX_ENTRIES; i++) {
      setCachedResponse(`key-${i}`, entry(`etag-${i}`));
    }
    expect(getCachedResponse("key-0")?.etag).toStrictEqual("etag-0");
  });

  it("should evict the oldest entry once beyond the cap", () => {
    // Behaviour
    for (let i = 0; i <= ETAG_CACHE_MAX_ENTRIES; i++) {
      setCachedResponse(`key-${i}`, entry(`etag-${i}`));
    }
    expect(getCachedResponse("key-0")).toBeUndefined();
    expect(getCachedResponse("key-1")?.etag).toStrictEqual("etag-1");
  });

  it("should treat a read as use, so the evicted entry is the least recent", () => {
    for (let i = 0; i < ETAG_CACHE_MAX_ENTRIES; i++) {
      setCachedResponse(`key-${i}`, entry(`etag-${i}`));
    }

    // Behaviour
    // Reading the oldest entry makes the next one the least recently used.
    getCachedResponse("key-0");
    setCachedResponse("overflow", entry("etag-overflow"));
    expect(getCachedResponse("key-0")?.etag).toStrictEqual("etag-0");
    expect(getCachedResponse("key-1")).toBeUndefined();
  });

  it("should drop every entry when reset", () => {
    setCachedResponse("a", entry("etag-a"));

    // Behaviour
    resetEtagCache();
    expect(getCachedResponse("a")).toBeUndefined();
  });
});
