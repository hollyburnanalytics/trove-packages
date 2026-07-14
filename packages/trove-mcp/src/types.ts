/**
 * Public type surface for the `@ontrove/mcp` SDK.
 *
 * These types describe the authoring contract:
 * a tool definition is "declare a Zod input schema + write a handler"; the SDK
 * owns protocol, schema compilation, auth-context injection, and error
 * envelopes. The handler receives validated args and a deliberately small
 * {@link ToolContext} capability object — no ambient authority.
 *
 * @module
 */

import type { z } from 'zod';
import type { ToolError } from './errors.js';

/**
 * Parameters to {@link TroveClient.search}.
 */
export interface TroveSearchOpts {
  /** Maximum number of results to return. */
  limit?: number;
  /** Restrict to a single source (fuzzy, case-insensitive). */
  source?: string;
  /** Restrict to a single author (fuzzy, case-insensitive). */
  author?: string;
}

/**
 * A single semantic-search hit from the user's knowledge base.
 */
export interface TroveSearchResult {
  /** The document id (the `[doc:ID]` handle). */
  id: string;
  /** The document title. */
  title: string;
  /** A relevance-ranked snippet. */
  snippet: string;
  /** The document author / podcast show name, if known. */
  author?: string;
  /** Cosine relevance score in `[0, 1]`. */
  score: number;
}

/**
 * A full document fetched by id.
 */
export interface TroveDocument {
  /** The document id. */
  id: string;
  /** The document title. */
  title: string;
  /** The full (possibly paged) document text. */
  text: string;
  /** The document author / podcast show name, if known. */
  author?: string;
}

/**
 * The feed (sub-grouping) a document belongs to within its toolkit's source —
 * the toolkit's own choice of grouping entity: a channel, show, account,
 * company, series, property, and so on. Optional: omit it and a toolkit's
 * documents form one flat list under its source; declare it and they cluster
 * into named feeds. The `key` is the entity's stable upstream id, so re-saving
 * the same entity lands in the same feed (it is also the dedup boundary).
 */
/**
 * The artifact to capture when the preferred one turns out not to exist. See
 * {@link TroveIngestDoc.fallback}.
 */
export interface TroveIngestFallback {
  /** URL of the fallback artifact — the one that always exists. */
  fileUrl: string;
  /** Its MIME type (e.g. `application/pdf`). */
  mimeType: string;
}

export interface TroveIngestFeed {
  /** Stable upstream id of the grouping entity (channel id, CIK, series id, …). */
  key: string;
  /** Human-readable feed name (e.g. "MKBHD", "Apple Inc.", "Real GDP"). */
  name: string;
  /**
   * Optional word for what kind of thing this feed is — "Channel", "Show",
   * "Company", "Series" — so a client can label the grouping ("grouped by
   * Company") rather than the generic "feed".
   */
  label?: string;
}

/**
 * A document to write into the knowledge base via {@link TroveClient.ingest}.
 */
export interface TroveIngestDoc {
  /** The document title. */
  title: string;
  /**
   * The document text to index. Optional when a {@link fileUrl}/{@link audioUrl}
   * is supplied (the captured file becomes the body); required otherwise.
   */
  text?: string;
  /** Optional canonical URL of the source. */
  url?: string;
  /** Optional author / byline. */
  author?: string;
  /**
   * The content's own publish date — when the paper/episode/video was
   * **published**, NOT when you are saving it (Trove records the ingest time
   * separately). ISO 8601; a bare `"2024-05-01"` is fine.
   *
   * Set this whenever the upstream tells you. Only the toolkit knows the real
   * date, and it's what recency ranking and date filters sort on — a document
   * saved without one is only ever as old as the day it was ingested.
   */
  date?: string;
  /**
   * Optional tags to file the document under. Trimmed and deduped; at most 32
   * tags of 64 characters each.
   */
  tags?: string[];
  /**
   * The upstream's own stable id for this content — a video id, an arXiv id, an
   * episode id. It is the **dedup key**: saving the same `externalId` into the
   * same {@link feed} twice is idempotent, and the second save returns the
   * document already there instead of creating a duplicate.
   *
   * Set it whenever the upstream has an id, which is nearly always. Omit it and
   * every save is a new document, so a user who saves the same video twice ends
   * up with it twice.
   */
  externalId?: string;
  /**
   * A file to capture into the knowledge base by URL (PDF, audio, …). Trove
   * fetches and stores the artifact; with {@link captureOnly} it is retained
   * as-is, otherwise it is processed (PDF → text, audio → transcript) when the
   * tenant is entitled. Public-internet URL only (egress is SSRF-guarded).
   */
  fileUrl?: string;
  /** Back-compat alias for an audio file URL; treated as `fileUrl` + `audio/mpeg`. */
  audioUrl?: string;
  /** MIME type for {@link fileUrl} (e.g. `application/pdf`, `audio/mpeg`). */
  mimeType?: string;
  /**
   * A second artifact to capture if {@link fileUrl} isn't there.
   *
   * Some sources publish the same document in more than one form, and only one of
   * them reliably exists. arXiv is the example: it has back-rendered HTML for many
   * papers but not all, while every paper has a PDF. Without this, a toolkit has to
   * find out for itself — a HEAD request per candidate, before the save can even
   * begin, on a tool call the platform cancels after about eight seconds. That is
   * what made a burst of arXiv saves time out.
   *
   * Name the preferred artifact as {@link fileUrl} and the sure thing here, and
   * Trove finds out which exists SERVER-side, off the tool's clock. A miss costs a
   * retry nobody is waiting on, and the fallback lands on the same document — it is
   * a retry, not a second copy.
   */
  fallback?: TroveIngestFallback;
  /**
   * Store the artifact + a searchable metadata record only; skip the AI
   * processing (transcription / text extraction). Lets a caller capture now and
   * enrich later, decoupled from the (possibly gated, possibly costly) pipeline.
   */
  captureOnly?: boolean;
  /**
   * The feed (sub-grouping) this document belongs to within the toolkit's
   * source. Optional — omit for a flat list under the source. See
   * {@link TroveIngestFeed}.
   */
  feed?: TroveIngestFeed;
}

/**
 * The result of an {@link TroveClient.ingest} call.
 */
export interface TroveIngestResult {
  /** Number of documents accepted for ingestion. */
  ingested: number;
}

/**
 * A scoped client over the calling user's own Trove knowledge base.
 *
 * Present on {@link ToolContext.trove} only when the manifest `scopes`
 * granted it (`trove:search` for reads, `trove:ingest` for writes); otherwise
 * `ctx.trove` is `undefined`.
 */
export interface TroveClient {
  /** Semantic search over the user's knowledge base. Requires `trove:search`. */
  search(query: string, opts?: TroveSearchOpts): Promise<TroveSearchResult[]>;
  /** Fetch a full document by id. Requires `trove:search`. */
  getDocument(id: string): Promise<TroveDocument>;
  /** Write documents into the knowledge base. Requires `trove:ingest`. */
  ingest(docs: TroveIngestDoc[]): Promise<TroveIngestResult>;
}

/**
 * The invocation context handed to every tool handler — a small capability
 * object with no ambient authority.
 *
 * Each member maps to a Trove-provided callback the SDK closes over the
 * short-TTL `ctxToken`; the blast radius of a handler is exactly its declared
 * `secrets ∪ scopes ∪ egress`.
 */
export interface ToolContext {
  /** The authenticated Clerk user id of the caller — identity, not a credential. */
  readonly userId: string;
  /**
   * Fetch one declared secret from the encrypted vault, decrypted only for
   * this invocation. `name` must appear in the manifest `secrets` array.
   * Throws a generic error if the secret is missing — prefer {@link requireSecret}
   * for required credentials, which throws a clear, model-visible message.
   */
  secret(name: string): Promise<string>;
  /**
   * Fetch a required secret, throwing a clear non-retryable {@link ToolError}
   * (`"<name> is not set. Run `trove secret set …`"`) when it is missing or
   * empty. The ergonomic default for credentials; `secret` is the escape hatch.
   */
  requireSecret(name: string): Promise<string>;
  /**
   * The only egress path out of the server. Behaves like the standard `fetch`.
   * The SDK itself enforces a baseline guard on every call — only `http(s)` is
   * allowed, and requests to private/loopback/link-local/reserved IP literals (and
   * `localhost`) are refused — and, when the server declares an `egress` allowlist,
   * denies any host not on it (deny by default). In the hosted runtime this is
   * backed by an egress proxy that blocks requests to private/loopback/link-local
   * addresses, which additionally enforces the manifest `egress` allowlist (and
   * defeats DNS-rebinding). A default `User-Agent` is added
   * when the caller does not set one; an explicit `user-agent` header always wins.
   */
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  /**
   * Fetch JSON with batteries included: routes through {@link fetch} (so the
   * default UA and any declarative `auth` apply), maps a non-2xx status to a
   * {@link ToolError} (4xx≠429 → non-retryable; 429/5xx/network → retryable),
   * guards malformed JSON, and — when `opts.schema` is supplied — validates the
   * body and returns the typed result. Omit `schema` to receive parsed `unknown`.
   * Keep the schema lenient (`.default()`/`.nullish()`); it is for parsing the
   * upstream shape, not the tool's strict `output` contract.
   */
  fetchJson<S extends z.ZodTypeAny>(
    url: string | URL,
    opts: FetchJsonOpts & { schema: S },
  ): Promise<z.infer<S>>;
  fetchJson(url: string | URL, opts?: FetchJsonOpts): Promise<unknown>;
  /**
   * A scoped client over the caller's own knowledge base — present only if
   * the manifest `scopes` requested `trove:search` and/or `trove:ingest`.
   */
  readonly trove?: TroveClient;
  /** Structured log entry, redacted against known secret values, surfaced in `trove logs`. */
  log(...args: unknown[]): void;
}

/**
 * Options for {@link ToolContext.fetchJson}. Supply `schema` (as part of the
 * call, not this base type) to validate and type the result via `z.infer`.
 */
export interface FetchJsonOpts {
  /** Standard `fetch` init (method, headers, body). */
  init?: RequestInit;
  /**
   * Map a non-2xx response to a custom {@link ToolError}, given the response and
   * its already-read body text (so the upstream's own error message can be
   * surfaced). Return `undefined` to fall back to the default status mapping.
   */
  errorMap?: (res: Response, body: string) => ToolError | undefined;
}

/**
 * Declarative OAuth2 client-credentials auth. When set on {@link McpServerConfig},
 * the SDK mints, caches, and attaches a `Bearer` token to egress automatically,
 * so handlers never touch the token dance. The client id/secret are resolved
 * from the vault by name (both must appear in the manifest `secrets`), and the
 * `tokenUrl` host and `apiHost` must appear in the manifest `egress`.
 */
export interface OAuth2ClientCredentials {
  /** Discriminant; the only supported flow today. */
  type: 'oauth2_client_credentials';
  /** The token endpoint (client-credentials grant, HTTP Basic client auth). */
  tokenUrl: string;
  /** Manifest secret name holding the client id. */
  clientIdSecret: string;
  /** Manifest secret name holding the client secret. */
  clientSecretSecret: string;
  /** Optional space-delimited scope string sent with the grant. */
  scope?: string;
  /**
   * Required. The Bearer is attached ONLY to requests whose host equals this
   * value — never to any other egress target, and never to the mint call. This
   * scoping is what prevents the token from leaking to a third-party host.
   */
  apiHost: string;
}

/**
 * Behavioral hints for a tool (MCP `annotations`, spec 2025-06-18 / 2025-11-25).
 *
 * Hosts use these to decide confirmation friction and whether a tool reaches the
 * open world. Per the spec, the conservative *absence* default treats a tool as
 * `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true` — so the
 * SDK auto-derives a safer `readOnlyHint` default (see {@link ToolDefinition}).
 * Clients MUST treat annotations as untrusted unless the server is trusted.
 */
export interface ToolAnnotations {
  /** True if the tool does not modify its environment. */
  readOnlyHint?: boolean;
  /** True if the tool may perform destructive updates (meaningful only when not read-only). */
  destructiveHint?: boolean;
  /** True if repeated calls with the same arguments have no additional effect. */
  idempotentHint?: boolean;
  /** True if the tool interacts with external entities (the open world). */
  openWorldHint?: boolean;
}

/**
 * The object a handler returns. `text` is the model-visible body; `structured`
 * is optional JSON-serializable data some clients display. When the tool
 * declares an `output` schema, `structured` is surfaced to the host as the
 * spec `structuredContent` object alongside the `text` mirror.
 *
 * A handler may also return a bare `string` as shorthand for `{ text }`.
 */
export interface ToolResult {
  /** The model-visible response body. Always provide this. */
  text: string;
  /** Optional structured data attached to the result. */
  structured?: unknown;
}

/**
 * A single tool definition. The `input` Zod schema is compiled to JSON Schema
 * for `tools/list` and used to validate arguments before `handler` runs.
 *
 * @typeParam I - The Zod schema type for the tool's arguments.
 * @typeParam O - The Zod schema type for the tool's structured output, if declared.
 */
export interface ToolDefinition<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** A short snake_case identifier, unique within the server. */
  name: string;
  /** A human-readable display name for client tool pickers (MCP `title`). */
  title?: string;
  /** The description Claude reads to decide whether to call this tool. */
  description: string;
  /** A Zod schema describing the tool's arguments. */
  input: I;
  /**
   * An optional Zod schema describing the tool's structured output. When set,
   * it is compiled to an `outputSchema` in `tools/list` and the handler's
   * `structured` field is surfaced as the spec `structuredContent` object.
   */
  output?: O;
  /**
   * Behavioral hints surfaced in `tools/list`. Any field the author omits is
   * filled by a conservative default: `readOnlyHint` is `true` UNLESS the tool
   * declares write intent (`mutating: true`, or the server is invoked with a
   * `trove:ingest` scope). An explicit author value always wins.
   */
  annotations?: ToolAnnotations;
  /** Budget hint: surface this tool even when the per-session cap is reached. */
  alwaysOn?: boolean;
  /** Marks the tool as mutating, which forces client consent. Defaults to `false`. */
  mutating?: boolean;
  /** The async handler — receives validated args and the {@link ToolContext}. */
  handler(args: z.infer<I>, ctx: ToolContext): Promise<ToolResult | string>;
}

/**
 * The configuration passed to {@link defineMcpServer}.
 */
export interface McpServerConfig {
  /** The tools this server exposes. At least one is required. */
  tools: ReadonlyArray<ToolDefinition>;
  /**
   * The manifest-declared Trove capability scopes (e.g. `['trove:search']`).
   * Used only to auto-derive a conservative `readOnlyHint` default: a server
   * that declares `trove:ingest` writes, so its tools are not read-only by
   * default. Authors who set `annotations.readOnlyHint` explicitly override
   * this. Optional and back-compatible — omitting it assumes no write scope.
   */
  scopes?: ReadonlyArray<string>;
  /**
   * Optional declarative auth. When set, the SDK mints/caches/attaches the
   * credential to egress automatically (see {@link OAuth2ClientCredentials}),
   * so handlers issue plain `ctx.fetch`/`ctx.fetchJson` calls.
   */
  auth?: OAuth2ClientCredentials;
  /**
   * Optional egress host allowlist (each entry a hostname or `host:port`). When
   * non-empty, the SDK denies any `ctx.fetch` to a host not on the list
   * (deny-by-default), in addition to the always-on block of private/loopback/
   * link-local addresses. Mirror the manifest `egress` here to make the server
   * self-protecting even when embedded standalone; the hosted egress proxy
   * enforces the manifest allowlist regardless.
   */
  egress?: ReadonlyArray<string>;
}

/**
 * A JSON Schema object for a tool's `inputSchema`, as surfaced in `tools/list`.
 */
export interface JsonSchema {
  /** Always `"object"` for tool argument schemas. */
  type: 'object';
  /** Per-property JSON Schema fragments. */
  properties?: Record<string, unknown>;
  /** Required property names. */
  required?: string[];
  /** Whether properties beyond those declared are permitted. */
  additionalProperties?: boolean;
  /** Any further JSON Schema keywords emitted by the compiler. */
  [key: string]: unknown;
}

/**
 * The `tools/list`-shaped descriptor of a single tool.
 */
export interface ToolListEntry {
  /** The tool name (un-namespaced; the gateway adds the `{slug}__` prefix). */
  name: string;
  /** The human-readable display name (MCP `title`), when set. */
  title?: string;
  /** The tool description. */
  description: string;
  /** The compiled JSON Schema for the tool's arguments. */
  inputSchema: JsonSchema;
  /**
   * The compiled JSON Schema for the tool's structured output, present only
   * when the definition declares an `output` schema (MCP `outputSchema`).
   */
  outputSchema?: JsonSchema;
  /**
   * Behavioral hints (MCP `annotations`), always present — either the author's
   * explicit values or the SDK's conservative auto-derived defaults.
   */
  annotations: ToolAnnotations;
  /** Budget hint mirrored from the definition, when set. */
  alwaysOn?: boolean;
  /** Mutating hint mirrored from the definition, when set. */
  mutating?: boolean;
}

/**
 * A normalized tool-call request as POSTed by the gateway into the hosted
 * runtime. `callbackBase` is the Trove-provided origin the SDK's `ctx`
 * callbacks target; it is appended to the egress allowlist server-side.
 */
export interface McpToolCall {
  /** The (un-namespaced) tool name to invoke. */
  tool: string;
  /** The raw, unvalidated arguments object. */
  args: unknown;
  /** The short-TTL signed capability token for this invocation. */
  ctxToken: string;
  /** The Trove-provided base URL the `ctx` callbacks POST to. */
  callbackBase: string;
  /** The authenticated Clerk user id of the caller. */
  userId: string;
  /** The manifest scopes granted, controlling whether `ctx.trove` is present. */
  scopes?: ReadonlyArray<string>;
}

/**
 * A normalized successful tool result, as returned to the gateway.
 */
export interface McpToolCallOk {
  /** Discriminant: the call succeeded. */
  ok: true;
  /** The wrapped result (`{ text, structured? }`). */
  result: ToolResult;
  /**
   * The spec `structuredContent` object — present only when the invoked tool
   * declared an `output` schema and the handler returned a `structured` value.
   * Mirrors `result.structured` so a host can lift it straight into the
   * `tools/call` result alongside the `text` content block.
   */
  structuredContent?: unknown;
}

/**
 * A normalized failed tool result, as returned to the gateway.
 */
export interface McpToolCallErr {
  /** Discriminant: the call failed. */
  ok: false;
  /** A model-safe error message — never a stack trace. */
  error: string;
  /** Whether the model should consider retrying. */
  retryable: boolean;
  /** A stable error code, e.g. `INVALID_PARAMS`, `UNKNOWN_TOOL`, `TOOL_ERROR`. */
  code: McpErrorCode;
}

/** The discriminated union of normalized tool-call outcomes. */
export type McpToolCallResult = McpToolCallOk | McpToolCallErr;

/** Stable machine-readable error codes the SDK emits. */
export type McpErrorCode = 'INVALID_PARAMS' | 'UNKNOWN_TOOL' | 'TOOL_ERROR' | 'BAD_REQUEST';

/**
 * The compiled server, produced by {@link defineMcpServer}. It carries the
 * `tools/list` descriptors and a normalized request handler the runtime entry
 * wires to the hosted runtime's `fetch`.
 */
export interface McpServerDefinition {
  /** The `tools/list` descriptors (names un-namespaced, schemas compiled). */
  readonly tools: ReadonlyArray<ToolListEntry>;
  /**
   * Handle one normalized tool call: validate args, build `ctx`, run the
   * handler inside a try/catch, and normalize the outcome.
   */
  handle(call: McpToolCall): Promise<McpToolCallResult>;
}
