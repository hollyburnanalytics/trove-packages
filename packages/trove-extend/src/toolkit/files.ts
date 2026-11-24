/**
 * `ctx.files` — read files the caller staged in Trove.
 *
 * A tool call is JSON, so a file can only ride inside one as text the model
 * typed out, which damages anything past a few kilobytes. Staging moves the
 * bytes out of band: the caller uploads the file to a one-time link and passes
 * the id it was given as an ordinary argument, and the handler reads the bytes
 * back here, confined to the calling user's own files.
 *
 * The callback answers the file itself, not JSON, with its name and hash in
 * headers. The hash is checked before the bytes are handed over, so a handler
 * never passes a truncated file onward believing it whole.
 *
 * @module
 */

import { ToolError } from './errors.js';

/**
 * A file someone staged in Trove for a toolkit to read, as
 * {@link FilesClient.read} returns it.
 *
 * Staging is how a file reaches a tool without travelling inside the tool
 * call: whoever holds the file uploads it to a one-time link and passes the
 * resulting id as an ordinary string argument. The bytes here are exactly the
 * bytes that were uploaded — {@link FilesClient.read} checks them against the
 * hash Trove took on arrival before handing them over.
 */
export interface StagedFile {
  /** The staged file's id — what the caller passed. */
  id: string;
  /** The name the uploader gave the file, with its extension. */
  name: string;
  /** The declared MIME type; `application/octet-stream` when none was declared. */
  contentType: string;
  /** Size in bytes. */
  size: number;
  /** `sha256(bytes)`, lowercase hex. */
  sha256: string;
  /** The file. */
  bytes: Uint8Array;
}

/**
 * Read access to files the calling user staged in Trove.
 *
 * Present on {@link ToolContext.files} only when the manifest `scopes` include
 * `trove:files`; otherwise `ctx.files` is `undefined`. Reads are confined to
 * the calling user's own files — an id staged by anyone else reads as not
 * found.
 */
export interface FilesClient {
  /**
   * Read a staged file by id.
   *
   * Raises a non-retryable {@link ToolError} when the id is unknown or the file
   * has expired (staged files last a day), naming what to do about it; and a
   * retryable one when the bytes that arrived do not match the hash taken at
   * upload.
   */
  read(fileId: string): Promise<StagedFile>;
}

/** A standard `fetch`-shaped function (the callback transport). */
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** What the files client closes over. */
export interface FilesParams {
  /** The short-TTL signed capability token. */
  ctxToken: string;
  /** The Trove-provided origin the callback POSTs to. */
  callbackBase: string;
  /** The fetch implementation (injectable for tests). */
  fetchImpl: FetchLike;
}

/**
 * Lowercase hex `sha256` of some bytes.
 *
 * @param bytes - The bytes.
 * @returns The digest.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The error text a callback answered with, when it answered JSON `{ error }`.
 *
 * @param res - The response.
 * @returns The message, or an empty string.
 */
async function callbackError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

/**
 * Raise for a response that did not carry a file.
 *
 * Not found is the caller's to fix (stage it again), so it is a non-retryable
 * {@link ToolError} carrying the platform's own sentence. Anything else is the
 * platform failing, and surfaces as an ordinary error.
 *
 * @param res - The non-2xx response.
 * @param id - The file id asked for.
 * @throws {ToolError} On 404.
 * @throws {Error} On anything else.
 */
async function refuse(res: Response, id: string): Promise<never> {
  const message = await callbackError(res);
  if (res.status === 404) {
    throw new ToolError(
      message || `No staged file ${id}: it was never uploaded, or it expired. Stage it again.`,
      { retryable: false },
    );
  }
  throw new Error(
    `ctx.files callback failed: ${res.status}${message ? ` ${message.slice(0, 200)}` : ''}`,
  );
}

/**
 * Decode the percent-encoded file name header, keeping it as sent when it is
 * not valid percent-encoding.
 *
 * @param raw - The header value.
 * @returns The name.
 */
function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Build the {@link FilesClient} backed by the `/internal/file` callback.
 *
 * @param p - The callback parameters.
 * @returns A `FilesClient` instance.
 */
export function makeFilesClient(p: FilesParams): FilesClient {
  return {
    async read(fileId: string): Promise<StagedFile> {
      const id = typeof fileId === 'string' ? fileId.trim() : '';
      if (id === '') throw new ToolError('A file id is required.', { retryable: false });

      const res = await p.fetchImpl(`${p.callbackBase.replace(/\/+$/, '')}/internal/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ctxToken: p.ctxToken, fileId: id }),
      });
      if (!res.ok) return refuse(res, id);

      const bytes = new Uint8Array(await res.arrayBuffer());
      const expected = res.headers.get('x-trove-sha256') ?? '';
      const sha256 = await sha256Hex(bytes);
      if (expected !== '' && expected !== sha256) {
        throw new ToolError(
          `Staged file ${id} arrived damaged (${bytes.byteLength} bytes, hash mismatch). Try again.`,
          { retryable: true },
        );
      }
      return {
        id,
        name: decodeName(res.headers.get('x-trove-file-name') ?? ''),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
        size: bytes.byteLength,
        sha256,
        bytes,
      };
    },
  };
}
