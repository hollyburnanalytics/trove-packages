/**
 * SDK-enforced egress guards (defense in depth).
 *
 * In the hosted runtime, `ctx.fetch` is backed by an egress proxy that blocks
 * requests to private/loopback/link-local addresses and enforces the manifest
 * `egress` allowlist. But the published package defaults to
 * `globalThis.fetch`, so a standalone embedder would otherwise have no protection.
 * These guards run inside the SDK on *every* `ctx.fetch` call regardless of the
 * backing fetch, so the package is not a trivial open SSRF proxy:
 *
 *  - only `http:` / `https:` schemes are allowed;
 *  - requests to private, loopback, link-local, CGNAT, multicast, or reserved IP
 *    literals (and `localhost`) are refused — this blocks the cloud metadata
 *    endpoint `169.254.169.254` and internal services;
 *  - when the server declares an `egress` host allowlist, any host not on it is
 *    refused (deny by default).
 *
 * Hostname-based SSRF via DNS rebinding (a public name resolving to a private IP)
 * is not defeatable at this layer without resolving; the hosted egress proxy
 * handles that. The literal-IP block is the meaningful, testable guard here.
 *
 * @module
 */

import { ToolError } from './errors.js';

/** True if a dotted-quad IPv4 literal is in a private/loopback/reserved range. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → refuse rather than guess
  }
  const [a, b, c] = nums;
  if (a === undefined || b === undefined || c === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a >= 224) return true; // multicast + reserved 224.0.0.0/3
  return false;
}

/**
 * True if `hostname` (as returned by `URL.hostname`) is one the SDK refuses to
 * reach: `localhost`, or an IP literal in a private/loopback/link-local/reserved
 * range (IPv4, or bracketed IPv6 incl. IPv4-mapped).
 *
 * @param hostname - The `URL.hostname` to test.
 * @returns Whether egress to this host is blocked.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  if (host.startsWith('[') && host.endsWith(']')) {
    const ip = host.slice(1, -1);
    if (ip === '::1' || ip === '::') return true; // loopback / unspecified
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local fc00::/7
    if (
      ip.startsWith('fe8') ||
      ip.startsWith('fe9') ||
      ip.startsWith('fea') ||
      ip.startsWith('feb')
    ) {
      return true; // link-local fe80::/10
    }
    // IPv4-mapped IPv6: `::ffff:a.b.c.d`, or its hex-compressed `::ffff:HHHH:HHHH`
    // form — which is how the URL parser normalizes the dotted form (so
    // `[::ffff:169.254.169.254]` arrives here as `::ffff:a9fe:a9fe`). Decode either
    // shape to IPv4 and reuse the IPv4 block; refuse any `::ffff:` we can't decode.
    if (ip.startsWith('::ffff:')) {
      const rest = ip.slice('::ffff:'.length);
      const dotted = rest.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)?.[0];
      if (dotted !== undefined) return isBlockedIpv4(dotted);
      const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hex?.[1] !== undefined && hex[2] !== undefined) {
        const hi = Number.parseInt(hex[1], 16);
        const lo = Number.parseInt(hex[2], 16);
        return isBlockedIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
      }
      return true; // unrecognized mapped form → refuse rather than guess
    }
    return false;
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return isBlockedIpv4(host);
  return false;
}

/**
 * Throw a non-retryable {@link ToolError} unless `url` is a safe egress target:
 * an `http(s)` URL to a non-private host that — if an allowlist is supplied — is
 * on it. Called for every `ctx.fetch` and for the OAuth mint request.
 *
 * @param url - The egress target.
 * @param allowlist - Optional list of allowed hosts (hostname or host:port).
 */
export function assertEgressAllowed(url: string | URL, allowlist?: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError('Refusing to fetch a malformed URL.', { retryable: false });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError(`Refusing non-HTTP(S) egress (${parsed.protocol}).`, { retryable: false });
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new ToolError('Refusing egress to a private, loopback, or link-local address.', {
      retryable: false,
    });
  }
  if (allowlist && allowlist.length > 0) {
    const host = parsed.host.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const allowed = allowlist.some((entry) => {
      const e = entry.toLowerCase();
      return e === host || e === hostname;
    });
    if (!allowed) {
      throw new ToolError(
        `Egress to "${parsed.hostname}" is not in the server's egress allowlist.`,
        {
          retryable: false,
        },
      );
    }
  }
}
