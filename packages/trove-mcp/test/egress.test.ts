import { describe, expect, it } from 'vitest';
import { assertEgressAllowed, isBlockedHost } from '../src/egress.js';
import { ToolError } from '../src/index.js';

describe('isBlockedHost', () => {
  it('blocks localhost and loopback/private/link-local/reserved IPs', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '198.18.0.1', // benchmarking
      '224.0.0.1', // multicast
      '[::1]',
      '[fc00::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]', // IPv4-mapped loopback (dotted)
      '[::ffff:a9fe:a9fe]', // IPv4-mapped metadata 169.254.169.254 (hex-compressed)
      '[::ffff:7f00:1]', // IPv4-mapped loopback 127.0.0.1 (hex-compressed)
    ]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
  });

  it('allows public hostnames and public IPs', () => {
    for (const host of ['api.ebay.com', 'export.arxiv.org', '8.8.8.8', '1.1.1.1', '172.32.0.1']) {
      expect(isBlockedHost(host), host).toBe(false);
    }
  });
});

describe('assertEgressAllowed', () => {
  it('rejects non-HTTP(S) schemes', () => {
    expect(() => assertEgressAllowed('file:///etc/passwd')).toThrow(ToolError);
    expect(() => assertEgressAllowed('ftp://example.com')).toThrow(/non-HTTP/);
  });

  it('rejects private/loopback/metadata targets', () => {
    expect(() => assertEgressAllowed('http://169.254.169.254/latest/meta-data/')).toThrow(
      /private, loopback/,
    );
    expect(() => assertEgressAllowed('http://localhost:8080/')).toThrow(ToolError);
    expect(() => assertEgressAllowed('http://10.0.0.5/')).toThrow(ToolError);
    // The URL parser normalizes the dotted IPv4-mapped form to hex; the guard
    // must still block it (would otherwise reach the metadata endpoint).
    expect(() => assertEgressAllowed('http://[::ffff:169.254.169.254]/')).toThrow(
      /private, loopback/,
    );
  });

  it('allows public https targets', () => {
    expect(() => assertEgressAllowed('https://api.ebay.com/buy/browse/v1/item')).not.toThrow();
  });

  it('enforces an allowlist (deny by default) when provided', () => {
    const allow = ['api.ebay.com'];
    expect(() => assertEgressAllowed('https://api.ebay.com/x', allow)).not.toThrow();
    expect(() => assertEgressAllowed('https://evil.example.com/x', allow)).toThrow(/allowlist/);
  });

  it('throws a non-retryable ToolError', () => {
    try {
      assertEgressAllowed('http://127.0.0.1/');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).retryable).toBe(false);
    }
  });
});
