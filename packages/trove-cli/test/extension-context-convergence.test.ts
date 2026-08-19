/**
 * The two SDKs must keep the same context spine.
 *
 * A source gets `SourceContext` from `@ontrove/sdk`; a toolkit gets
 * `ToolContext` from `@ontrove/mcp`. They are different contracts — one is
 * scheduled and resumable, the other answers a call — but the parts an author
 * touches constantly should be identical, so that knowing one means knowing the
 * other: a credential, a guarded fetch, a log line, the clock.
 *
 * Nothing enforced that. The two packages have no dependency between them and
 * should not gain one merely to share a shape, so the shapes drifted: the
 * toolkit side grew `secret()` while the source side had no way to hold a
 * credential at all, and each grew its own idea of what a log call looks like.
 *
 * This file is where the convergence is enforced instead. The CLI already
 * depends on BOTH packages, so it is the one place that can see them at once
 * and say they agree. The assertions are type-level: they cost nothing at
 * runtime and fail at `tsc`, which is the right moment to find out.
 *
 * Adding a member to `ExtensionContext` will break this file until the toolkit
 * side grows it too. That is the intended pressure, and the reason to prefer
 * failing here over a comment asking people to remember.
 *
 * @module
 */

import type { ExtensionContext, SourceContext } from '@ontrove/extend/source';
import type { ToolContext } from '@ontrove/extend/toolkit';
import { describe, expect, it } from 'vitest';

/**
 * `true` when `T` is assignable to `U`, `never` otherwise — so assigning `true`
 * to it fails to compile the moment the relationship breaks.
 */
type Assignable<T, U> = T extends U ? true : never;

describe('the two SDKs share one context spine', () => {
  it("a source's context IS an ExtensionContext", () => {
    // The annotation is the test: it stops compiling if the relationship
    // breaks. The runtime assertion just keeps vitest honest about having run
    // the file.
    const holds: Assignable<SourceContext, ExtensionContext> = true;
    expect(holds).toBe(true);
  });

  it("a toolkit's context supplies the same spine", () => {
    // ToolContext is declared independently in @ontrove/mcp, with no import of
    // @ontrove/sdk. If it drifts — a renamed `fetch`, a `log` that is no longer
    // callable, a `secret` that stops returning a promise — this stops
    // compiling, here, rather than surfacing as two SDKs that feel different.
    //
    // The WHOLE spine, not a chosen subset. An earlier version of this test
    // asserted only `secret`/`requireSecret`/`fetch`, and so failed to notice
    // that a toolkit had no `now()` at all — the assertion agreed with the
    // drift it existed to catch. A gate narrower than the thing it guards is
    // worse than none, because it reads as coverage.
    //
    // NOT asserted the other way round: a toolkit legitimately has members a
    // source does not (`userId`, `trove`, `fetchJson`), and a source has
    // members a toolkit does not (`cursor`, `deadline`, `progress`). The spine
    // is a floor, not an equality.
    const holds: Assignable<ToolContext, ExtensionContext> = true;
    expect(holds).toBe(true);
  });

  it('both log channels accept the same calls', () => {
    // The one member where the two genuinely differed in kind: `@ontrove/mcp`
    // has `log(...args)`, Trove's cloud adapters call `log.info(...)`. The
    // source spine now admits both, so a module can be written once and run
    // under either host. This asserts the callable half stays callable.
    const holds: Assignable<ExtensionContext['log'], (...args: unknown[]) => void> = true;
    expect(holds).toBe(true);
  });
});
