/**
 * `createSourceWorker` executed against the shared invoke contract.
 *
 * The fixture file names this runner by hand as the implementation that "must
 * run this file as its own gate before it is published, not merely be read
 * against it". It was written before this worker existed, and then this worker
 * existed and still did not run it. This file closes that.
 *
 * The point is not that these assertions are hard. It is that they are the SAME
 * assertions Trove's shim runs, from one artefact, so a contract change cannot
 * be made on one side and merely intended on the other.
 *
 * @module
 */

import {
  type AdapterSpec,
  CASE_SECTIONS,
  type ContractFixtures,
  contract,
  PRODUCER_SECTIONS,
  READER_SECTIONS,
} from '@ontrove/extend/contract';
import type { SourceContext } from '@ontrove/extend/source';
import { describe, expect, it } from 'vitest';
import { createSourceWorker } from '../src/runtime/source-shim.js';

/**
 * Build a worker whose source behaves as a fixture's `adapter` spec says.
 *
 * @param spec - How the adapter should behave.
 * @returns A worker wrapping it.
 */
function adapterWorker(spec: AdapterSpec): ReturnType<typeof createSourceWorker> {
  return createSourceWorker({
    async sync(ctx) {
      for (const [level, ...parts] of spec.log ?? []) {
        // The spine's `log` is callable; the level is carried as the first part
        // so a fixture written for the levelled harness still says the same
        // thing here. Presentation differs between hosts; the contract is that
        // the line survives to the response at all.
        ctx.log(level, ...parts);
      }
      if (spec.throws !== undefined) throw new Error(spec.throws);
      if (spec.returnsUndefined === true) return undefined as never;
      return spec.returns as never;
    },
  });
}

describe('the contract fixture, as this repo sees it', () => {
  it('classifies every section as one side or the other', () => {
    // A section nobody classified is a section nobody runs — the exact failure
    // this fixture exists to prevent, reintroduced one level up. Adding a
    // section to the JSON breaks this until somebody decides who owns it.
    expect([...PRODUCER_SECTIONS, ...READER_SECTIONS].sort()).toEqual([...CASE_SECTIONS].sort());
  });

  it('states plainly which sections this implementation does NOT run', () => {
    // `response` and `http` hold the READER's obligations: what Trove must
    // accept or refuse from a body it did not produce. This package produces
    // bodies; it has no reader. Saying so in a test beats silence, because
    // silence here reads as coverage.
    expect([...READER_SECTIONS]).toEqual(['response', 'http']);
  });

  it('leaves no producer section empty', () => {
    for (const section of PRODUCER_SECTIONS) {
      expect(contract[section] as unknown[], `${section} is empty`).not.toHaveLength(0);
    }
  });
});

describe('createSourceWorker answers the contract route', () => {
  it.each(contract.route)('$name', async (routeCase) => {
    const worker = adapterWorker({ returns: { documents: [] } });
    const response = await worker.fetch(
      new Request(routeCase.url, {
        method: routeCase.method,
        ...(routeCase.method === 'POST' ? { body: '{}' } : {}),
      }),
    );
    expect(response.status).toBe(routeCase.status);
  });
});

describe('createSourceWorker builds the contract context', () => {
  // `context` is a PRODUCER section, and this package produces. It was the one
  // producer section nobody ran here — which is how a shim that reshapes the
  // cursor passed every test in this file while breaking the case named
  // "config, credentials and cursor reach the adapter unchanged".
  it.each(contract.context)('$name', async (contextCase) => {
    let seen: SourceContext | undefined;
    const worker = createSourceWorker({
      async sync(ctx) {
        seen = ctx;
        return { documents: [] };
      },
    });
    await worker.fetch(
      new Request(contract.constants.invokeUrl, {
        method: 'POST',
        body: JSON.stringify(contextCase.request),
      }),
    );
    const ctx = seen as unknown as Record<string, unknown> & {
      log: Record<string, unknown>;
      deadline: number;
    };
    const want = contextCase.expect;

    if ('config' in want) expect(ctx.config).toEqual(want.config);
    if ('cursor' in want) expect(ctx.cursor).toEqual(want.cursor);
    if (want.cursorAbsent === true) expect(ctx.cursor).toBeUndefined();
    for (const name of want.functions ?? []) expect(typeof ctx[name]).toBe('function');
    for (const level of want.logLevels ?? []) expect(typeof ctx.log[level]).toBe('function');
  });
});

describe('createSourceWorker produces the contract wire body', () => {
  // The producer half of each round-trip. The reader half — what Trove makes of
  // this body — is asserted in Trove against the same cases, which is the whole
  // arrangement: two programs, one file, neither able to drift quietly.
  it.each(contract.roundTrip)('$name', async (tripCase) => {
    const response = await adapterWorker(tripCase.adapter).fetch(
      new Request(contract.constants.invokeUrl, { method: 'POST', body: '{"config":{}}' }),
    );

    expect(response.status).toBe(tripCase.wireStatus ?? 200);
    const wire = (await response.json()) as Record<string, unknown>;

    // Optional keys are subtracted from BOTH sides rather than merely allowed
    // on one: an implementation that emits an optional key is as conformant as
    // one that omits it, and the mandatory set stays exact either way.
    const optional = new Set(tripCase.wireKeysOptional ?? []);
    const required = [...tripCase.wireKeys].filter((key) => !optional.has(key)).sort();
    expect(
      Object.keys(wire)
        .filter((key) => !optional.has(key))
        .sort(),
    ).toEqual(required);
  });
});

describe('the fixture the two repos share is the same fixture', () => {
  it('carries the version both sides pin', () => {
    // A bump here means an installed Mac runtime may no longer satisfy the
    // contract, so it is the one number worth asserting outright rather than
    // reading past.
    expect(contract.version).toBe(1);
  });

  it('states why every case exists', () => {
    for (const section of CASE_SECTIONS) {
      for (const testCase of contract[section] as { name: string; why: string }[]) {
        expect(testCase.why, `${section}: ${testCase.name}`).toBeTruthy();
      }
    }
  });

  it('is typed the same on both sides', () => {
    const declared = (Object.keys(contract) as (keyof ContractFixtures)[]).filter(
      (key) => !key.startsWith('$') && Array.isArray(contract[key]),
    );
    expect(declared.sort()).toEqual([...CASE_SECTIONS].sort());
  });
});
