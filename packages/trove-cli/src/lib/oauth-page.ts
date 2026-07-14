/**
 * The page the browser lands on after authorizing the CLI.
 *
 * It is served by a loopback server on `127.0.0.1`, which means two things.
 * First, it is the only part of the CLI a user ever SEES, so it should look like
 * Trove rather than like a default `<h2>`. Second, it must be entirely
 * self-contained: no fonts, no stylesheets, no images fetched from anywhere. A
 * page that reaches for a CDN would sit there blank on a plane, at a conference,
 * or behind a corporate proxy — during a login the user has already completed.
 *
 * @module
 */

/**
 * Trove's single accent — and the one colour that is NOT it.
 *
 * A failed sign-in must not wear the brand: an error drawn in the same blue as a
 * success reads as decoration, and the eye skips it. The mark carries the state.
 */
const BRAND = {
  accent: '#3366cc',
  accentDark: '#7aa2f7',
  danger: '#c8342b',
  dangerDark: '#f08a84',
} as const;

/** What the browser is being told. */
export type CallbackOutcome =
  | { ok: true }
  | {
      ok: false;
      /** What went wrong, in the user's terms. */
      message: string;
    };

/**
 * Render the CLI's OAuth callback page.
 *
 * The failure page is not an afterthought: this handler used to serve "You may
 * close this window" no matter what came back, so a DENIED or malformed login
 * looked exactly like a successful one — and the user would return to a terminal
 * that was still waiting, or had failed, with no idea why.
 *
 * @param outcome - Whether the authorization succeeded, and why not if it didn't.
 * @returns A complete, self-contained HTML document.
 */
export function callbackPage(outcome: CallbackOutcome): string {
  const title = outcome.ok ? 'You’re signed in' : 'Sign-in failed';
  const detail = outcome.ok
    ? 'You can close this tab and return to your terminal.'
    : escapeHtml(outcome.message);

  const tone = outcome.ok ? 'ok' : 'danger';
  const mark = outcome.ok
    ? // A check, drawn rather than fetched.
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <path d="M20 6 9 17l-5-5"/>
       </svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <path d="M18 6 6 18M6 6l12 12"/>
       </svg>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Trove</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fcfcfd;
    --fg: #1b1f2a;
    --muted: #6b7280;
    --card: #ffffff;
    --border: #e5e7eb;
    --accent: ${BRAND.accent};
    --ok-bg: #eef3fc;
    --danger: ${BRAND.danger};
    --danger-bg: #fdeeed;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1117;
      --fg: #e6e8ec;
      --muted: #9099a8;
      --card: #151a22;
      --border: #262c36;
      --accent: ${BRAND.accentDark};
      --ok-bg: #172033;
      --danger: ${BRAND.dangerDark};
      --danger-bg: #2a1a1a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
          Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 26rem;
    padding: 32px;
    text-align: center;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
  }
  .mark {
    width: 44px;
    height: 44px;
    margin: 0 auto 20px;
    display: grid;
    place-items: center;
    border-radius: 999px;
  }
  .mark--ok { background: var(--ok-bg); color: var(--accent); }
  .mark--danger { background: var(--danger-bg); color: var(--danger); }
  .mark svg { width: 22px; height: 22px; }
  h1 {
    margin: 0 0 8px;
    font-size: 1.125rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  p { margin: 0; color: var(--muted); }
  .wordmark {
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    font-size: 0.75rem;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
</style>
</head>
<body>
  <main class="card">
    <div class="mark mark--${tone}">${mark}</div>
    <h1>${title}</h1>
    <p>${detail}</p>
    <div class="wordmark">Trove CLI</div>
  </main>
</body>
</html>`;
}

/** Escape text destined for the page. The message can carry an upstream string. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
