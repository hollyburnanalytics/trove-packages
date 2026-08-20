/**
 * The standard library for extending Trove.
 *
 * Two kinds of thing can be built, and this package holds both because they
 * are the same job seen twice. A **source** fills the Library on a schedule; a
 * **toolkit** answers a model's question live. Import the half you are
 * building:
 *
 * ```ts
 * import { defineSource } from '@ontrove/extend/source';
 * import { defineToolkit, tool, z } from '@ontrove/extend/toolkit';
 * ```
 *
 * What is exported HERE is what the two share, and sharing it is the reason
 * they live together. {@link ExtensionContext} is the spine of both context
 * objects — a credential, a guarded fetch, a log line, the clock — so an
 * author learns those once and finds them identical on the other side. It was
 * previously declared twice, in two packages that could not import each other,
 * with a type-level assertion in a third holding them together; one
 * declaration needs no assertion.
 *
 * The guarded fetch is here for the same reason: a source and a toolkit both
 * reach the network, both are handed an address they did not choose, and both
 * must refuse a private host. One implementation, one set of tests, one thing
 * to fix when the guard is wrong.
 *
 * @module
 */

export {
  assertPublicHttpUrl,
  FETCH_TIMEOUT_MS,
  type FetchedPage,
  fetchBytes,
  fetchPage,
  fetchPageWithMeta,
  type GuardedFetchOptions,
  HttpStatusError,
  isTooLargeError,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  TROVE_USER_AGENT,
} from './http.js';
export type {
  ExtensionCache,
  ExtensionContext,
  FetchLike,
  LogChannel,
} from './types.js';
