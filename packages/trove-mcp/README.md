# @ontrove/mcp

The thin standard library for authoring **your own tools for Claude** — every
toolkit runs as a full MCP server on Trove's cloud. You declare tools + write
handlers; the SDK owns the MCP protocol, JSON-RPC, schema validation,
auth-context injection, secret access, and error envelopes.

It is symmetric with the source SDK ([`@ontrove/sdk`](https://www.npmjs.com/package/@ontrove/sdk))
`sync(ctx)` contract: a source returns documents to be _stored_; a toolkit's
tools return results to be _read live_. The full
[Hosted MCP SDK Reference](https://docs.ontrove.sh/hosted-mcp/sdk-reference/)
lives in the Trove docs.

## Install

```bash
npm install @ontrove/mcp zod    # or: bun add @ontrove/mcp zod
```

`zod` is a **peer dependency** — the SDK accepts your Zod schemas across its API,
so author and SDK must share a single `zod` instance (two copies would break
`instanceof` checks). It is re-exported as `z`, so in your code you can simply
`import { z } from '@ontrove/mcp'` and never import `zod` directly. Modern npm/bun
install the peer automatically; the explicit `zod` above is just belt-and-suspenders.

## Quickstart

Your `server.ts` must `export default defineMcpServer(...)`:

```ts
import { defineMcpServer, z, ToolError } from '@ontrove/mcp';

export default defineMcpServer({
  tools: [
    {
      name: 'lookup_order',
      // `title` is a friendly display name for client tool pickers.
      title: 'Look up order',
      description:
        "Look up the status, line items, and ship date of an order by ID. " +
        "Use when the user asks about a specific order number.",
      // A read-only tool: declaring this once means the host won't add
      // confirmation friction. (You usually don't need to — see "Annotations"
      // below: the SDK derives `readOnlyHint: true` for non-mutating tools.)
      annotations: { readOnlyHint: true },
      input: z.object({
        orderId: z.string().describe("The order ID, e.g. 'ORD-10423'."),
        includeLineItems: z.boolean().optional().default(false),
      }),
      // An `output` schema compiles to `outputSchema` in `tools/list`, and the
      // handler's `structured` value is emitted as spec `structuredContent`
      // (alongside the human-readable `text` mirror) — validatable data by default.
      output: z.object({
        status: z.string(),
        shipDate: z.string(),
        lineItems: z.array(z.object({ sku: z.string(), qty: z.number() })).optional(),
      }),
      async handler({ orderId, includeLineItems }, ctx) {
        // ctx.requireSecret pulls from the encrypted vault at call time (never
        // bundled) and throws a clear "not set" error if the secret is missing.
        const token = await ctx.requireSecret('ORDERS_API_TOKEN');

        // ctx.fetchJson is the batteries-included egress path: it routes through
        // the manifest egress allowlist, maps non-2xx → ToolError, guards JSON
        // parsing, and validates the body against a (lenient) schema.
        const order = await ctx.fetchJson(`https://api.example.com/orders/v1/${orderId}`, {
          init: { headers: { authorization: `Bearer ${token}` } },
          schema: z.object({ status: z.string(), shipDate: z.string() }).passthrough(),
          errorMap: (res) =>
            res.status === 404
              ? new ToolError(`Order ${orderId} not found`, { retryable: false })
              : undefined, // other statuses → SDK default mapping
        });

        return {
          text: `Order ${orderId}: ${order.status}, ships ${order.shipDate}.`,
          structured: order, // surfaced as `structuredContent` (matches `output`)
        };
      },
    },
  ],
});
```

## The `ctx` capability object

A deliberately small object — no ambient authority. Everything `ctx` can do is
something the manifest declared and the calling user authorized.

| Member | Description |
|--------|-------------|
| `ctx.userId` | The authenticated Clerk user id of the caller (identity, not a credential). |
| `ctx.requireSecret(name)` | Fetch a **required** secret; throws a clear, non-retryable `ToolError` (`"<name> is not set. Run \`trove secret set …\`"`) when missing or empty. The ergonomic default for credentials. |
| `ctx.secret(name)` | Fetch one declared secret from the encrypted vault, decrypted for this invocation. Throws a generic error if absent — the escape hatch for optional secrets; prefer `requireSecret` for required ones. `name` must appear in `manifest.json` `secrets`. |
| `ctx.fetchJson(url, opts?)` | Batteries-included JSON egress (see below): routes through `ctx.fetch`, maps non-2xx → `ToolError`, guards JSON parsing, and optionally Zod-validates the body to a typed result. **The recommended way to call JSON APIs.** |
| `ctx.fetch(url, init?)` | The lower-level egress path; routes through an egress proxy that blocks requests to private/loopback/link-local addresses and enforces the `egress` allowlist. Public-internet hosts only — `localhost`, LAN/private ranges, and reserved addresses are blocked (SSRF), so a hosted server can't reach your own machine. A default browser `User-Agent` is added when you don't set one (many public APIs reject the default runtime UA); an explicit `user-agent` always wins. Use it directly for non-JSON bodies (HTML, XML, streaming). |
| `ctx.trove` | Scoped client over the caller's own knowledge base (`search` / `getDocument` / `ingest`). Present only if `manifest.scopes` granted `trove:search` / `trove:ingest`. |
| `ctx.log(...args)` | Structured log entry, redacted against known secret values, surfaced in `trove logs`. |

### `ctx.fetchJson` — calling JSON APIs

`fetchJson` collapses the fetch → status-check → `ToolError` → guarded-`.json()`
dance every tool repeats into one call, with optional typing:

```ts no-typecheck
import { z } from '@ontrove/mcp';

// Keep the schema LENIENT — it parses the upstream shape, not your tool's
// strict `output` contract. Use .default()/.nullish()/.passthrough() generously.
const Forecast = z.object({
  temperature: z.number(),
  summary: z.string().nullish(),
});

async handler({ city }, ctx) {
  // With a schema → fully typed result (z.infer), validated.
  const fc = await ctx.fetchJson(`https://api.example.com/forecast?q=${city}`, {
    schema: Forecast,
  });
  return { text: `${city}: ${fc.temperature}°`, structured: fc };
}
```

- **Default error mapping** (override per call with `errorMap`): `4xx` (except
  `429`) → non-retryable `ToolError`; `429` / `5xx` / network / malformed JSON /
  schema mismatch → retryable. `errorMap(res, body)` receives the **already-read
  body text**, so you can surface the upstream's own error message; return
  `undefined` to fall through to the default mapping.
- **Omit `schema`** to receive parsed `unknown` (cast or narrow yourself).
- **Footgun:** a too-strict schema combined with a retryable classification means
  the SDK keeps retrying a response it can never parse. Keep upstream schemas loose.

### `ctx.secret` / `ctx.requireSecret`

Secrets are redeemed from the encrypted vault at call time — never bundled into
the deployed script, never logged. Declare each name in `manifest.json`'s
`secrets` array, then set it with `trove secret set <server> <NAME>`. Use
`requireSecret` for credentials a tool can't run without:

```ts
const [apiKey, recipient] = await Promise.all([
  ctx.requireSecret('RESEND_API_KEY'),
  ctx.requireSecret('RECIPIENT_EMAIL'),
]);
```

### Declarative auth (OAuth2 client-credentials)

For APIs behind an OAuth2 client-credentials grant, set `auth` on the server
config and the SDK **mints, caches, refreshes, and attaches** the `Bearer` token
to your egress automatically — handlers just call `ctx.fetch`/`ctx.fetchJson`
with no token plumbing:

```ts
export default defineMcpServer({
  auth: {
    type: 'oauth2_client_credentials',
    tokenUrl: 'https://api.example.com/identity/v1/oauth2/token',
    clientIdSecret: 'EXAMPLE_CLIENT_ID',      // a manifest `secrets` name
    clientSecretSecret: 'EXAMPLE_CLIENT_SECRET',
    scope: 'https://api.example.com/scope',   // optional
    apiHost: 'api.example.com',               // required: attach the Bearer ONLY to this host
  },
  tools: [/* … handlers issue plain ctx.fetchJson(...) … */],
});
```

The token is cached per resolved client id (a tenant boundary in the shared
hosted runtime), refreshed shortly before expiry, and re-minted on a `401`/`403`. Both
secret names must appear in the manifest `secrets`, and both the `tokenUrl` host
and `apiHost` must appear in the manifest `egress`. `apiHost` is required — it
scopes the Bearer to a single host so the token never leaks to another egress
target. When you only need a
static key as a query param or header, use `requireSecret` instead.

### `ctx.trove` — reading and writing the knowledge base

Present only when the manifest `scopes` asked for it: `trove:search` gives you
`search` / `getDocument`, `trove:ingest` gives you `ingest`. Reads and writes are
scoped to the calling user's own knowledge base.

```ts no-typecheck
async handler({ id }, ctx) {
  const paper = await fetchPaper(ctx, id);
  const { ingested } = await ctx.trove!.ingest([
    {
      title: paper.title,
      text: paper.abstract,
      url: paper.url,
      author: paper.authors.join(', '),
      date: paper.published,   // the paper's publish date, not today
      externalId: paper.id,    // re-saving this paper won't duplicate it
      feed: { key: paper.category, name: paper.category, label: 'Category' },
    },
  ]);
  return `Saved ${ingested} paper.`;
}
```

You never name a source: a saved document is attributed to **your toolkit**
automatically, from the toolkit identity the runtime verified for this
invocation. A caller cannot forge that attribution, and you cannot write into
another toolkit's documents.

Each `TroveIngestDoc`:

| Field | Description |
|---|---|
| `title` | Required. The document title. |
| `text` | The body to index. Optional when you supply a `fileUrl`/`audioUrl` (the captured file becomes the body); required otherwise. |
| `url` | Canonical URL of the original. |
| `author` | Free-text byline. |
| `date` | The content's own **publish** date (ISO 8601; a bare `2024-05-01` is fine) — not the time you're saving it, which Trove records separately. See below. |
| `tags` | Tags to file the document under. Trimmed and deduped; max 32 tags × 64 chars. |
| `externalId` | The upstream's own stable id (a video id, an arXiv id). The **dedup key**: saving it twice into the same feed returns the existing document instead of a duplicate. See below. |
| `fileUrl` | A file to capture by URL (PDF, audio, …). Trove fetches and stores it, then processes it (PDF → text, audio → transcript). Public-internet URL only — egress is SSRF-guarded. |
| `audioUrl` | Alias for an audio `fileUrl` (implies `audio/mpeg`). |
| `mimeType` | MIME type for `fileUrl`, e.g. `application/pdf`. |
| `captureOnly` | Store the artifact plus a searchable metadata record, and skip the AI processing. Capture now, enrich later. |
| `feed` | The sub-group this document belongs to within your toolkit. See below. |

#### `externalId` — so a second save isn't a second document

Set `externalId` to whatever the upstream calls this thing. It is the dedup key
within the feed, so a user who saves the same video twice ends up with **one**
document, not two — the second save quietly resolves to the one already there.

```ts no-typecheck
externalId: video.id,     // "eWKY0OnPByg"
```

Omit it and every save is a new document. That is right for content with no
upstream identity (a note, a snippet of a conversation) and wrong for everything
else.

#### Dates — always send the publish date

Set `date` whenever the upstream tells you, even approximately. **Only your
toolkit knows the real one**, and it's what recency ranking and date filters sort
on. A document saved without it is only ever as old as the day it was ingested,
so a paper from 2017 and one from last week look equally fresh — which quietly
degrades every date-aware query the user makes later.

```ts no-typecheck
date: paper.published,        // "2017-06-12" — the upstream's own field
```

Trove normalizes whatever `Date` can parse. A value it can't parse is dropped
rather than stored, so a malformed date never poisons the ranking.

#### Feeds — grouping your documents

A toolkit's documents can sit in one flat list, or cluster into named **feeds**:
a YouTube toolkit groups by channel, a podcast toolkit by show, a filings toolkit
by company, an economic-data toolkit by series. You choose the grouping entity —
it's the thing a user would say "show me everything from ___" about.

`feed` is optional. Omit it entirely and your documents form a flat list under
your toolkit. Declare it and they group:

```ts no-typecheck
feed: {
  key: 'UCBJycsmduvYEL83R_U4JriQ',  // stable upstream id of the entity
  name: 'MKBHD',                    // what the user sees
  label: 'Channel',                 // optional: what kind of thing it is
}
```

`key` must be the entity's **stable upstream id**, not its display name — it's
what makes re-saving the same channel land in the same feed even after a rename,
and it is the boundary Trove dedups within. `label` is the word a client uses to
describe the grouping ("grouped by Channel" rather than the generic "feed").

Pick a grouping that is **single-valued and stably keyed**. A joined multi-author
string is neither, so it makes a poor feed even though it makes a fine `author`.

## Returning results

Return either a `{ text, structured? }` object or a bare string (shorthand for
`{ text }`). `text` is the model-visible body. When the tool declares an
`output` schema, `structured` is also emitted as the spec `structuredContent`
object, so clients get validatable data and the `text` mirror for free.

## Annotations & structured output (best practices, by default)

The SDK makes the MCP best practices the **default** so every hosted server is
conformant by construction:

- **`title`** — an optional friendly display name surfaced in `tools/list`.
- **`annotations`** — the four MCP behavioral hints (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`). You rarely need to set
  these: the SDK derives a **conservative default** so read tools aren't
  advertised as destructive + open-world (which would add needless confirmation
  friction). The heuristic, applied field by field, **an explicit author value
  always wins**:
  - `readOnlyHint` defaults to **`true`** UNLESS the tool declares write intent —
    either `mutating: true` on the tool, or the server's manifest `scopes`
    include `trove:ingest`. A write-intent tool defaults to `readOnlyHint: false`.
  - When the resolved tool is read-only, `destructiveHint` and `openWorldHint`
    default to `false` (a reader neither destroys nor reaches the open world).
  - The SDK never *invents* a destructive/open-world claim for a write tool, and
    never overrides a hint you set explicitly.
- **`output`** — an optional Zod schema. When present it compiles to an
  `outputSchema` in `tools/list`, and the handler's `structured` value is
  emitted as `structuredContent` (plus the `text` mirror) — spec-compliant
  structured output, opt-in per tool.

```ts
{
  name: 'search_orders',
  title: 'Search orders',
  description: 'Search recent orders by free-text query.',
  // No annotations needed: a non-mutating tool is auto-derived as read-only.
  input: z.object({ query: z.string().describe('Free-text search.') }),
  output: z.object({
    results: z.array(z.object({ id: z.string(), status: z.string(), score: z.number() })),
  }),
  async handler({ query }, ctx) {
    const results = await searchOrders(ctx, query);
    return { text: `${results.length} order(s) for "${query}".`, structured: { results } };
  },
}
```

## Errors

Throw `ToolError(message, { retryable })` for a clean, intentional error. Any
uncaught throw is caught and returned as a generic `tool failed` — never a stack
trace to the model. Never put secret values in a `ToolError` message.

## How it runs

> **Hosted deployment is in preview.** Authoring and local testing (below) work
> today; `trove deploy` and the hosted runtime are still rolling out. The flow
> below describes how a deployed server runs once hosting is available.

At deploy, `trove deploy` bundles `server.ts` (targeting the hosted runtime),
compiles each Zod `input` to JSON Schema for `tools/list`, and uploads the script
to the hosted runtime. At invocation, the host delivers a
normalized `{ tool, args, ctxToken, callbackBase, userId, scopes }`; the SDK
validates args against the compiled schema (invalid args never reach your handler),
builds `ctx` over the short-TTL `ctxToken`, and normalizes the result. The
`ctx.secret` / `ctx.trove` capabilities are Trove-provided callbacks
(`POST {callbackBase}/internal/secret` and `/internal/trove`), not bindings —
each request runs in an isolated sandbox that holds no ambient authority.

For local tests, wrap your definition with `toFetchHandler(server)` or call
`dispatch(server, call)` directly, injecting a mock fetch via
`defineMcpServer(config, { fetchImpl })`.

## Scripts

```bash
bun run build       # tsc → dist (JS + .d.ts)
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
bun run test        # vitest run
bun run test:coverage
```

## Support

Guides and the full reference live at [docs.ontrove.sh](https://docs.ontrove.sh).

Report bugs or security issues to <matt@hollyburnanalytics.com>.

## License

Released under the [MIT License](./LICENSE). © 2026 Hollyburn Analytics Inc.
