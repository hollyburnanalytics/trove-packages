import { CliError, ExitCode, type ExitCodeValue } from './errors.js';

/** A single GraphQL error entry from the `errors[]` array. */
export interface GraphQLError {
  /** Human-readable error message. */
  message: string;
  /** Optional structured extensions (e.g. `{ code: 'UNAUTHENTICATED' }`). */
  extensions?: { code?: string } & Record<string, unknown>;
  /** Optional path to the field that errored. */
  path?: ReadonlyArray<string | number>;
}

/** The GraphQL response envelope: `data` and/or `errors`. */
export interface GraphQLResponse<T> {
  /** The `data` payload, present on success (may be partial with errors). */
  data?: T | null;
  /** The `errors` array, present on failure. */
  errors?: GraphQLError[];
}

/** Options for a single GraphQL request. */
export interface RequestOptions {
  /** The GraphQL document text. */
  query: string;
  /** Operation variables. */
  variables?: Record<string, unknown>;
  /** The named operation to execute (required when the doc has several). */
  operationName?: string;
}

/** Construction options for {@link GraphQLClient}. */
export interface ClientOptions {
  /** API base URL (e.g. `https://api.ontrove.sh`); `/graphql` is appended. */
  apiUrl: string;
  /** The Clerk bearer token presented as `Authorization: Bearer`. */
  token: string;
  /** A `fetch` implementation (injected for tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Max retry attempts for idempotent reads on 5xx/network (default 2). */
  maxRetries?: number;
  /**
   * Called once when a request is rejected with 401/403, to obtain a fresh
   * bearer token (e.g. by redeeming a refresh token). Returning a new token
   * makes the client retry the same request with it; returning `null` (no
   * refresh possible, or the refresh itself failed) surfaces the auth error.
   * The access token stored by the CLI is short-lived, so this is how commands
   * recover from an expired token without a re-login.
   */
  onAuthFailure?: () => Promise<string | null>;
}

/**
 * A thin, typed GraphQL transport for the Trove Open Host Service. It is the
 * CLI's one and only data path: every command sends a named
 * operation here with the active profile's bearer token. The class is unaware
 * of any specific operation — commands own their documents.
 */
export class GraphQLClient {
  private readonly endpoint: string;
  private token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly onAuthFailure?: () => Promise<string | null>;

  /**
   * @param options - Endpoint, token, and (optionally) a fetch override.
   */
  constructor(options: ClientOptions) {
    this.endpoint = `${options.apiUrl.replace(/\/$/, '')}/graphql`;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    if (options.onAuthFailure !== undefined) this.onAuthFailure = options.onAuthFailure;
  }

  /**
   * Execute a GraphQL operation and return the typed `data`, throwing a
   * {@link CliError} (with a classified exit code) on any GraphQL or transport
   * error. Use {@link requestEnvelope} when you need the raw `{ data, errors }`.
   *
   * @typeParam T - The expected shape of `data`.
   * @param options - The query, variables, and operation name.
   * @param retryable - When true, retries 5xx/network errors with backoff
   *   (only safe for idempotent reads). Defaults to false.
   * @returns The `data` payload.
   */
  async request<T>(options: RequestOptions, retryable = false): Promise<T> {
    const envelope = await this.requestEnvelope<T>(options, retryable);
    if (envelope.errors && envelope.errors.length > 0) {
      const first = envelope.errors[0];
      const message = first?.message ?? 'Unknown GraphQL error';
      throw new CliError(
        `${options.operationName ?? 'operation'}: ${message}`,
        classifyError(envelope.errors),
        envelope,
      );
    }
    if (envelope.data == null) {
      throw new CliError(
        `${options.operationName ?? 'operation'}: empty response`,
        ExitCode.Transport,
        envelope,
      );
    }
    return envelope.data;
  }

  /**
   * Execute a GraphQL operation and return the raw `{ data, errors }` envelope
   * without throwing on `errors[]`. Transport failures (network, non-2xx after
   * retries, malformed JSON) still throw.
   *
   * @typeParam T - The expected shape of `data`.
   * @param options - The query, variables, and operation name.
   * @param retryable - Whether to retry transport failures.
   * @returns The full GraphQL envelope.
   */
  async requestEnvelope<T>(
    options: RequestOptions,
    retryable = false,
  ): Promise<GraphQLResponse<T>> {
    const body = JSON.stringify({
      query: options.query,
      variables: options.variables ?? {},
      ...(options.operationName ? { operationName: options.operationName } : {}),
    });

    let lastError: unknown;
    const attempts = retryable ? this.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.send<T>(body);
      } catch (err) {
        lastError = err;
        // Auth/validation errors are not retryable; surface immediately.
        if (err instanceof CliError && err.code !== ExitCode.Transport) throw err;
        if (attempt < attempts - 1) await delay(2 ** attempt * 100);
      }
    }
    if (lastError instanceof CliError) throw lastError;
    throw new CliError(
      `Network error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      ExitCode.Transport,
    );
  }

  /**
   * Send a request, and on a 401/403 attempt a single token refresh via
   * {@link ClientOptions.onAuthFailure} before retrying with the new token. This
   * is what lets a command recover from an expired access token silently.
   */
  private async send<T>(body: string): Promise<GraphQLResponse<T>> {
    const res = await this.roundTrip(body);
    if ((res.status === 401 || res.status === 403) && this.onAuthFailure !== undefined) {
      const fresh = await this.onAuthFailure();
      if (fresh !== null && fresh.length > 0) {
        this.token = fresh;
        return this.decode<T>(await this.roundTrip(body));
      }
    }
    return this.decode<T>(res);
  }

  /** Perform one HTTP round-trip with the current bearer token. */
  private roundTrip(body: string): Promise<Response> {
    return this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body,
    });
  }

  /** Classify an HTTP status into a {@link CliError}, else decode the JSON envelope. */
  private async decode<T>(res: Response): Promise<GraphQLResponse<T>> {
    if (res.status === 401 || res.status === 403) {
      throw new CliError(
        `Authentication failed (HTTP ${res.status}). Run 'trove login'.`,
        ExitCode.Auth,
      );
    }
    if (res.status >= 500) {
      throw new CliError(`Server error (HTTP ${res.status}).`, ExitCode.Transport);
    }
    if (!res.ok && res.status !== 400) {
      throw new CliError(`Unexpected HTTP ${res.status}.`, ExitCode.Transport);
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as GraphQLResponse<T>;
    } catch {
      throw new CliError('Malformed response from server (not JSON).', ExitCode.Transport);
    }
  }
}

/**
 * Map a GraphQL `errors[]` array to a CLI exit code. Inspects
 * `extensions.code` and message text for auth/validation/conflict signals.
 *
 * @param errors - The GraphQL errors.
 * @returns The classified exit code.
 */
export function classifyError(errors: GraphQLError[]): ExitCodeValue {
  const codes = errors.map((e) => (e.extensions?.code ?? '').toLowerCase());
  const messages = errors.map((e) => e.message.toLowerCase());

  const has = (needle: string): boolean =>
    codes.some((c) => c.includes(needle)) || messages.some((m) => m.includes(needle));

  if (has('unauthenticated') || has('forbidden') || has('admin') || has('unauthorized')) {
    return ExitCode.Auth;
  }
  if (has('cursor') && (has('conflict') || has('cas') || has('mismatch'))) {
    return ExitCode.Conflict;
  }
  if (has('not found') || has('not_found') || has('notfound')) {
    return ExitCode.NotFound;
  }
  if (has('bad_user_input') || has('validation') || has('invalid')) {
    return ExitCode.Usage;
  }
  return ExitCode.Transport;
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
