import { describe, expect, it } from 'vitest';
import { callbackPage } from '../src/lib/oauth-page.js';

describe('callbackPage', () => {
  it('is entirely self-contained — it must render with no network', () => {
    // The page is served from a loopback socket after the user has ALREADY
    // signed in. A stylesheet, font or image fetched from anywhere would leave
    // them staring at a blank tab on a plane, at a conference, or behind a
    // corporate proxy, wondering whether the login worked.
    const html = callbackPage({ ok: true });
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/<script\b/);
  });

  it('says the sign-in worked', () => {
    const html = callbackPage({ ok: true });
    expect(html).toContain('You’re signed in');
    expect(html).toContain('return to your terminal');
  });

  it('says the sign-in FAILED, and why', () => {
    // The handler used to answer "You may close this window" whatever came back,
    // so a denied sign-in looked exactly like a successful one — and the user
    // walked back to a terminal that had failed, with no idea why.
    const html = callbackPage({ ok: false, message: 'The sign-in request was denied.' });
    expect(html).toContain('Sign-in failed');
    expect(html).toContain('The sign-in request was denied.');
    expect(html).not.toContain('You’re signed in');
  });

  it('escapes an upstream message rather than injecting it', () => {
    // `error_description` comes from the authorization server, and it lands in
    // the page. It is not ours to trust.
    const html = callbackPage({ ok: false, message: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
