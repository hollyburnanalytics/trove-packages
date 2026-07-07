/**
 * Exit codes for the `trove` CLI. Honest, scriptable exit codes
 * let pipelines branch on failure class without parsing stderr.
 */
export const ExitCode = {
  /** Success. */
  Success: 0,
  /** Usage / validation error (bad flags; client-side validation rejection). */
  Usage: 2,
  /** Auth error — not logged in, expired token, or insufficient permissions. */
  Auth: 4,
  /** Not found (`document(id)` / `source(id)` returned null). */
  NotFound: 5,
  /** Transport / server error (5xx, network, otherwise-unclassified errors[]). */
  Transport: 7,
  /** Retryable conflict — `ingestDocuments` cursor CAS rejection. */
  Conflict: 8,
} as const;

/** A numeric exit code value (one of {@link ExitCode}). */
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * A CLI error carrying a process exit code. Thrown by commands and the client
 * layer; caught at the top level (`src/cli.ts`), which prints `message` to
 * stderr and exits with `code`.
 */
export class CliError extends Error {
  /** The process exit code to use when this error reaches the top level. */
  readonly code: ExitCodeValue;
  /**
   * Optional structured payload (e.g. the raw `{ data, errors }` GraphQL
   * envelope) so `--json` mode can still emit a machine-readable body.
   */
  readonly payload: unknown;

  /**
   * @param message - Human-readable error text (printed to stderr).
   * @param code - The exit code to surface (default {@link ExitCode.Transport}).
   * @param payload - Optional structured body for `--json` mode.
   */
  constructor(message: string, code: ExitCodeValue = ExitCode.Transport, payload?: unknown) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.payload = payload;
  }
}

/**
 * Convenience constructor for a usage/validation error (exit code 2).
 *
 * @param message - The validation message.
 * @returns A {@link CliError} with {@link ExitCode.Usage}.
 */
export function usageError(message: string): CliError {
  return new CliError(message, ExitCode.Usage);
}

/**
 * Convenience constructor for an auth error (exit code 4).
 *
 * @param message - The auth message.
 * @returns A {@link CliError} with {@link ExitCode.Auth}.
 */
export function authError(message: string): CliError {
  return new CliError(message, ExitCode.Auth);
}
