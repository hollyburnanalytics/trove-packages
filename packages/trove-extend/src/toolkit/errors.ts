/**
 * The {@link ToolError} class — the authored, model-safe error envelope.
 *
 * Throwing `ToolError` from a handler returns a clean, intentional error to the
 * model with a controlled message and `retryable` hint. Uncaught exceptions are
 * also caught by the SDK and returned as a generic error, but `ToolError` lets
 * the author own the message. See the hosted-MCP SDK reference for details.
 *
 * @module
 */

/**
 * Options for {@link ToolError}.
 */
export interface ToolErrorOptions {
  /** Whether the model should consider retrying the call. Defaults to `false`. */
  retryable?: boolean;
  /** Optional structured data attached to the error (carried to logs, not the model). */
  data?: unknown;
}

/**
 * An intentional, model-visible tool error.
 *
 * Never include secret values or internal stack traces in the message — it is
 * visible to the model and potentially the user. Describe the problem at the
 * level of the tool's semantics, not the implementation.
 *
 * @example
 * ```ts
 * throw new ToolError(`Order ${orderId} not found`, { retryable: false });
 * ```
 */
export class ToolError extends Error {
  /** Whether the model should consider retrying the call. */
  readonly retryable: boolean;
  /** Optional structured data attached to the error. */
  readonly data: unknown;

  /**
   * @param message - Human-readable, model-safe error message.
   * @param options - Optional `retryable` hint and structured `data`.
   */
  constructor(message: string, options?: ToolErrorOptions) {
    super(message);
    this.name = 'ToolError';
    this.retryable = options?.retryable ?? false;
    this.data = options?.data;
    // Restore the prototype chain when compiled to older targets.
    Object.setPrototypeOf(this, ToolError.prototype);
  }
}
