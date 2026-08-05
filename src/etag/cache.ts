import { ETAG_CACHE_MAX_ENTRIES } from "../constants.ts";

/**
 * `body` is the decoded bytes rather than a `Response`, as a body can only be
 * read once and an entry may be replayed any number of times.
 */
export interface CachedResponse {
  /**
   * The `etag` response header verbatim.
   * See: https://www.rfc-editor.org/rfc/rfc9110#field.etag
   */
  etag: string;
  body: ArrayBuffer;
  headers: [string, string][];
}

/**
 * Process-wide, so a saved response outlives the client that fetched it.
 */
const store = new Map<string, CachedResponse>();

export function getCachedResponse(key: string): CachedResponse | undefined {
  const entry = store.get(key);
  if (entry === undefined) {
    return undefined;
  }

  // Re-insert so that insertion order tracks recency for eviction.
  store.delete(key);
  store.set(key, entry);

  return entry;
}

/**
 * Evicts the least recently used entry if saving takes the cache beyond
 * `ETAG_CACHE_MAX_ENTRIES`.
 */
export function setCachedResponse(key: string, entry: CachedResponse): void {
  store.delete(key);
  store.set(key, entry);

  if (store.size > ETAG_CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) {
      store.delete(oldest.value);
    }
  }
}

export function resetEtagCache(): void {
  store.clear();
}
