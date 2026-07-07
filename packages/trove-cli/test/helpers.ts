import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writer } from '../src/output.js';

/** A recorded GraphQL request body the mock fetch captured. */
export interface CapturedRequest {
  url: string;
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
  authorization?: string;
}

/** A mock fetch plus the list of requests it captured. */
export interface MockFetch {
  fetch: typeof fetch;
  calls: CapturedRequest[];
}

/**
 * Build a mock `fetch` that returns a fixed GraphQL envelope (or a per-call
 * response factory) and records every request body + auth header.
 *
 * @param respond - A static envelope, or a function of the captured request.
 * @param status - HTTP status to return (default 200).
 * @returns A {@link MockFetch}.
 */
export function mockFetch(
  respond: unknown | ((req: CapturedRequest) => unknown),
  status = 200,
): MockFetch {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const captured: CapturedRequest = {
      url,
      query: body.query,
      variables: body.variables ?? {},
      ...(body.operationName !== undefined ? { operationName: body.operationName } : {}),
      ...(headers.authorization !== undefined ? { authorization: headers.authorization } : {}),
    };
    calls.push(captured);
    const payload = typeof respond === 'function' ? respond(captured) : respond;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** An in-memory writer capturing stdout/stderr lines. */
export interface CaptureWriter extends Writer {
  /** Collected stdout lines. */
  stdout: string[];
  /** Collected stderr lines. */
  stderr: string[];
  /** Joined stdout. */
  out(line: string): void;
  /** Joined stderr. */
  err(line: string): void;
  /** All stdout joined by newlines. */
  stdoutText(): string;
  /** All stderr joined by newlines. */
  stderrText(): string;
}

/** Create a {@link CaptureWriter} backed by arrays. */
export function captureWriter(): CaptureWriter {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
    stdoutText: () => stdout.join('\n'),
    stderrText: () => stderr.join('\n'),
  };
}

/** A temporary `$HOME` with cleanup, for config-file tests. */
export interface TempHome {
  home: string;
  cleanup(): void;
}

/** Create a temp home dir (caller calls `cleanup()`). */
export function tempHome(): TempHome {
  const home = mkdtempSync(join(tmpdir(), 'trove-cli-test-'));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
