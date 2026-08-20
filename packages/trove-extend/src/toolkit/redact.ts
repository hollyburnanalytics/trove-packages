/**
 * Secret redaction for `ctx.log`.
 *
 * `types.ts` promises log lines are "redacted against known secret values". The
 * SDK keeps a per-invocation set of the secret *values* it has resolved (every
 * `ctx.secret`/`ctx.requireSecret` result) and scrubs them from anything passed
 * to `ctx.log` — and from the detail of an uncaught handler error — before it
 * reaches the log sink. This is best-effort string replacement, not a guarantee
 * against a handler that deliberately transforms a secret, but it stops the
 * common accidental leak (logging a token, a URL with a key, or an error whose
 * message echoes a credential).
 *
 * @module
 */

const REDACTED = '[redacted]';

/** Replace every occurrence of each known secret value in `text`. */
function redactString(text: string, secrets: ReadonlySet<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

/**
 * Deep-redact `value`, replacing any substring equal to a known secret value
 * with `[redacted]`. Strings, arrays, plain objects, and Errors are walked;
 * other primitives pass through. Cycles are handled.
 *
 * @param value - The value to redact (typically `ctx.log` args).
 * @param secrets - The set of resolved secret values to scrub.
 * @returns A redacted copy (the input is never mutated).
 */
export function redactSecrets(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (secrets.size === 0) return value;
  return walk(value, secrets, new WeakSet());
}

function walk(value: unknown, secrets: ReadonlySet<string>, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Error) {
    const detail = value.stack ?? `${value.name}: ${value.message}`;
    return redactString(detail, secrets);
  }

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, secrets, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[redactString(key, secrets)] = walk(v, secrets, seen);
  }
  return out;
}
