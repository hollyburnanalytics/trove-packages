/**
 * Reading the settings a *user* filled in.
 *
 * `ctx.config` is the one part of a source's input no schema fully guarantees.
 * A manifest declares a field's `type`, and the surfaces that collect it — the
 * web form, the Mac app, the CLI, a directory picker — each interpret that
 * declaration a little differently. A `url[]`/`text[]` field is the place they
 * diverge: one sends a list, another sends the bare string somebody pasted,
 * and a field left alone arrives as `null` or is absent altogether.
 *
 * So a source must narrow before it reads, and the two catalogs each grew the
 * same narrowing function independently — the same name, the same body, in two
 * repositories — which is how the helper ended up here. It belongs with the
 * package that defines `SourceContext.config`, not beside the sources that
 * happen to call it.
 *
 * @module
 */

/**
 * Read a config field as a list of strings.
 *
 * Accepts what the surfaces actually send: a list, a bare string (one entry
 * pasted into a list field), `null`, or nothing. Entries are trimmed and blanks
 * dropped, so a trailing newline in a textarea does not become an empty feed
 * that fails on every run.
 *
 * Both catalogs learned this the same way, from opposite ends of the same bug.
 * Reading a list field as `(config.feeds || []).map(…)` throws
 * `.map is not a function` on a bare string, losing a whole round mid-sync,
 * cursor included. Reading it as `const [first] = config.x ?? []` does not
 * throw — it destructures the string's first CHARACTER, so a pasted-not-picked
 * show uuid became `"6"` and the run failed against a uuid that looked nothing
 * like what the user typed. The second is worse than the first: it produces a
 * plausible wrong value instead of an error, and the report that comes back is
 * "it can't find my show".
 *
 * A `null` INSIDE a list is dropped, not coerced. Both catalogs' copies of
 * this ran the whole entry through `String()` and then `filter(Boolean)`,
 * which keeps `null` — because `String(null)` is the four-character string
 * `"null"`, and that is truthy. A `url[]` field with a hole in it therefore
 * yielded a feed address of `"null"`, resolved as a relative URL against
 * whatever base the caller used, and failed as a 404 from the source's own
 * host rather than as the bad config it was. Found by the tests written when
 * this moved here; neither catalog's copy had a test.
 *
 * @param value - The raw config value, as stored.
 * @returns Its non-empty entries, trimmed; `[]` when there are none.
 *
 * @example
 * ```ts
 * stringList(['https://a.example/feed', ' ']); // ['https://a.example/feed']
 * stringList('https://a.example/feed');        // ['https://a.example/feed']
 * stringList(null);                            // []
 * stringList(['https://a.example/feed', null]); // ['https://a.example/feed']
 * ```
 */
export function stringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}
