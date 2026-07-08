# @ontrove/sdk

The thin standard library for authoring **Trove sources** — scheduled adapters
that fetch content into your knowledge base. (Source authoring is an early,
still-developing surface.) You write a `sync(ctx)` that fetches new content and returns
documents; the SDK owns the document shape, the typed `ctx` capability object,
the watermark/cursor model, the local-run harness the CLI drives, and manifest
validation.

It is symmetric with the toolkit-authoring SDK
([`@ontrove/mcp`](https://www.npmjs.com/package/@ontrove/mcp)) `defineMcpServer`
contract: a source returns documents to be _stored_ (batch `sync`); a toolkit's
tools return results to be _read live_.

See the full [SDK Reference](https://docs.ontrove.sh/sources/sdk-reference/),
the [manifest.json reference](https://docs.ontrove.sh/sources/manifest/), and
the [cursors & feeds model](https://docs.ontrove.sh/sources/cursors-and-feeds/)
in the docs.

## Install

```bash
npm install @ontrove/sdk
```

## Quickstart

A source's `index.ts` must `export default defineSource(...)`. Your `sync`
fetches new content and returns documents — each field maps 1:1 onto the
`IngestDocumentInput` the Mac app pushes via `ingestDocuments`.

### Hacker News front page

```ts
import { defineSource } from '@ontrove/sdk';

export default defineSource({
  async sync(ctx) {
    const res = await ctx.fetch('https://hn.algolia.com/api/v1/search?tags=front_page');
    const { hits } = await res.json();
    ctx.log(`fetched ${hits.length} front-page stories`);

    return {
      documents: hits.map((hit) => ({
        id: hit.objectID, // → externalId; the dedup key
        title: hit.title,
        text: hit.story_text ?? hit.title,
        url: hit.url,
        author: hit.author,
        date: new Date(hit.created_at_i * 1000).toISOString(),
        contentType: 'bookmark',
      })),
      // Advance the cursor to the newest story's timestamp.
      cursor: { type: 'date', value: new Date(hits[0].created_at_i * 1000).toISOString() },
    };
  },
});
```

### RSS feed (incremental, date watermark)

> `parseRss` / `stripHtml` below are **your own helpers** — the SDK ships no XML
> parser. Bring your own (e.g. [`fast-xml-parser`](https://www.npmjs.com/package/fast-xml-parser)).

```ts no-typecheck
import { defineSource } from '@ontrove/sdk';
// import { parseRss, stripHtml } from './rss-helpers'; // your own — see note above

export default defineSource({
  async sync(ctx) {
    const feedUrl = ctx.config.feedUrl as string;
    const since = ctx.cursor.type === 'date' ? new Date(ctx.cursor.value) : new Date(0);

    const res = await ctx.fetch(feedUrl);
    if (!res.ok) {
      // Throw to fail the run; the Mac app retries next tick. Already-pushed docs persist.
      throw new Error(`feed returned ${res.status} ${res.statusText}`);
    }

    const items = parseRss(await res.text()).filter((i) => new Date(i.pubDate) > since);
    const documents = items.map((item) => ({
      id: item.guid,
      title: item.title,
      text: stripHtml(item.contentEncoded ?? item.description),
      url: item.link,
      author: item.creator ?? feedUrl,
      date: item.pubDate,
    }));

    const newest = items[0]?.pubDate;
    return newest
      ? { documents, cursor: { type: 'date', value: newest } }
      : { documents };
  },
});
```

A bare array is accepted too — `return documents;` is shorthand for
`{ documents }` with no cursor change.

## The `ctx` object

| Member        | Type                                        | Description                                                                 |
| ------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `ctx.config`  | `C` (typed preferences)                     | The user's setup preferences. **Never credentials.**                        |
| `ctx.cursor`  | `Watermark` (read-only)                     | The feed's current watermark; `{ type: 'none' }` on first sync.             |
| `ctx.fetch`   | `(url, init?) => Promise<Response>`         | Standard `fetch` — routes through the Mac app's networking.                 |
| `ctx.log`     | `(...args) => void`                         | Structured log entry, surfaced in the source's logs.                        |
| `ctx.now`     | `() => Date`                                | Injected clock (deterministic under test).                                  |

`ctx.credentials` (Keychain-resolved auth) and `ctx.browser` (Playwright) are
**proposed**, not part of the shipped contract, and intentionally absent.

## The document shape → `IngestDocumentInput`

`SourceDocument` maps 1:1 onto the GraphQL `IngestDocumentInput` wire type:

| `SourceDocument`    | `IngestDocumentInput` | Required                       |
| ------------------- | --------------------- | ------------------------------ |
| `id`                | `externalId`          | **Yes**                        |
| `title`             | `title`               | No                             |
| `text`              | `text`                | One of `text` / `audioUrl`     |
| `audioUrl`          | `audioUrl`            | One of `text` / `audioUrl`     |
| `url`               | `url`                 | No                             |
| `author`            | `author`              | No                             |
| `date`              | `date` (ISO 8601)     | No                             |
| `tags`              | `tags`                | No                             |
| `metadata`          | `metadata` (JSON)     | No                             |
| `contentType`       | `contentType`         | No (default `text`)            |

Dedup is keyed on `(feed, id)`, so `sync` is safe to retry — re-returning the
same `id` is skipped.

## Watermarks

A `Watermark` describes how a feed resumes between syncs:

- `{ type: 'date', value }` — time-ordered feeds with "since &lt;date&gt;" filtering (RSS, most APIs).
- `{ type: 'idSet', values, max? }` — monotonic ids, no reliable date filter.
- `{ type: 'none' }` — re-fetch everything; rely on dedup. Always correct, less efficient.

## Local run harness

`runSource` is what `trove source dev` / `trove source test` call. It
builds a `ctx`, runs `sync`, validates and dedups the documents:

```ts no-typecheck
import { runSource } from '@ontrove/sdk';
import source from './index.js';

const { documents, cursor, duplicatesSkipped } = await runSource(source, {
  config: { feedUrl: 'https://example.com/feed.xml' },
  cursor: { type: 'date', value: '2026-06-01T00:00:00Z' },
});
```

## Manifest validation

`validateSourceManifest` backs `trove source validate`. It checks required
fields and the `id`/`version` patterns, and lints `config` for credential-shaped
keys — the same spirit as the cloud's `validateConfig` (config holds preferences
only; credentials live in the macOS Keychain).

```ts no-typecheck
import { validateSourceManifest } from '@ontrove/sdk';

const { valid, errors } = validateSourceManifest(manifest);
if (!valid) throw new Error(errors.join('\n'));
```

## Support

Guides and the full reference live at [docs.ontrove.sh](https://docs.ontrove.sh).

Report bugs or security issues to <matt@hollyburnanalytics.com>.

## License

Released under the [MIT License](./LICENSE). © 2026 Hollyburn Analytics Inc.
