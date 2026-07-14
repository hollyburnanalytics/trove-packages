---
'@ontrove/mcp': minor
---

`TroveIngestDoc` gains `fallback` — a second artifact to capture when `fileUrl` turns out not to exist.

Some sources publish the same document in more than one form, and only one of them reliably exists: arXiv has back-rendered HTML for many papers but not all, while every paper has a PDF. Name the preferred artifact as `fileUrl` and the sure thing as `fallback`, and Trove finds out which is real **server-side** — off the tool's clock, where a miss costs a retry nobody is waiting on.

```ts
await ctx.trove.ingest([
  {
    title: paper.title,
    text: abstract,
    fileUrl: `https://arxiv.org/html/${paper.id}`,
    mimeType: 'text/html',
    fallback: { fileUrl: paper.pdfUrl, mimeType: 'application/pdf' },
  },
]);
```

Without it a toolkit has to probe for itself — a request per candidate before the save can even begin, on a tool call that is cancelled after about eight seconds.
