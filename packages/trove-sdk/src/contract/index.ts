/**
 * THE deployed-source invoke contract, as data plus a typed view of it.
 *
 * This file is the canonical home. It used to live in the Trove backend, which
 * made it the backend's contract that other implementations were welcome to
 * read — and reading is not the same as executing. Three programs claim to
 * speak this contract and only one of them ran the fixtures:
 *
 *  1. Trove's `source-shim.mjs`, bundled into every deployed source.
 *  2. `createSourceWorker`, in this repo, which the CLI deploys.
 *  3. `trove-macos/Runtime/runner.js`, which ships INSIDE AN INSTALLED BINARY
 *     with no forced update.
 *
 * That third one is why the contract is a fixture rather than a paragraph. The
 * Mac runner cannot be fixed retroactively: a contract change it does not catch
 * reaches users as a silently broken sync on a build nobody can recall. The
 * only defence is a shared artefact every side executes, so whichever side
 * changes, the others go red first.
 *
 * It lives in the published SDK because that is the one artefact all three can
 * reach — the three repositories share no other dependency. The cost is real
 * and worth stating: changing the contract now means publishing before the
 * other two can test against the change. That is the trade taken deliberately,
 * against the alternative of copies kept in step by a checker that can only run
 * where both copies happen to be present.
 *
 * The raw JSON is exported too, at `@ontrove/sdk/contract/source-invoke.json`,
 * because the Mac's runner is plain JavaScript with no TypeScript build.
 *
 * @module
 */

// The attribute is required, not decorative: Node's ESM loader refuses a JSON
// module without it, so the compiled package throws on import in any plain-Node
// consumer — which is every consumer that is not running through a bundler.
import raw from './source-invoke.json' with { type: 'json' };

/** A long string written compactly, so a 64 KB cursor fits in a readable file. */
interface RepeatSpec {
  /** The unit repeated. */
  unit: string;
  /** How many times to repeat it. */
  times: number;
}

/**
 * Whether a value is the `{"$repeat": …}` placeholder.
 *
 * @param value - The candidate node.
 * @returns True when it expands to a string.
 */
function isRepeat(value: object): value is { $repeat: RepeatSpec } {
  if (!('$repeat' in value)) return false;
  const spec: unknown = (value as { $repeat: unknown }).$repeat;
  return (
    typeof spec === 'object' &&
    spec !== null &&
    typeof (spec as RepeatSpec).unit === 'string' &&
    typeof (spec as RepeatSpec).times === 'number'
  );
}

/**
 * Expand every `{"$repeat": {unit, times}}` node into its string.
 *
 * Done at load time rather than in the runners so that every implementation
 * reading this file agrees on what the fixture *is*, instead of each inventing
 * its own way to build the oversized values.
 *
 * @param value - Any node of the parsed fixture.
 * @returns The node with placeholders replaced.
 */
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (typeof value !== 'object' || value === null) return value;
  if (isRepeat(value)) return value.$repeat.unit.repeat(value.$repeat.times);
  return Object.fromEntries(Object.entries(value).map(([key, node]) => [key, expand(node)]));
}

/** Limits and identifiers every implementation must agree on. */
export interface ContractConstants {
  /** The one route a deployed source answers. */
  invokeUrl: string;
  /** Serialized cursor ceiling. */
  maxCursorBytes: number;
  /** Response body ceiling. */
  maxResponseBytes: number;
  /** The deadline an invoke body without `deadlineMs` implies. */
  defaultDeadlineMs: number;
}

/** One request the hosted runtime must accept or refuse purely on method and path. */
export interface RouteCase {
  /** What this case pins. */
  name: string;
  /** The failure it prevents. */
  why: string;
  /** HTTP method. */
  method: string;
  /** Absolute request URL. */
  url: string;
  /** The status the hosted runtime must answer with. */
  status: number;
}

/** What the adapter must be able to see, given one invoke body. */
export interface ContextCase {
  /** What this case pins. */
  name: string;
  /** The failure it prevents. */
  why: string;
  /** The invoke request body. */
  request: Record<string, unknown>;
  /** The expected projection onto `ctx`. */
  expect: {
    /** Expected `ctx.config`, when asserted. */
    config?: unknown;
    /** Expected `ctx.credentials`, when asserted. */
    credentials?: unknown;
    /** Expected `ctx.cursor`, when asserted. */
    cursor?: unknown;
    /** Whether `ctx.cursor` must be `undefined`. */
    cursorAbsent?: boolean;
    /** Expected `ctx.deadline - Date.now()`, within tolerance. */
    deadlineOffsetMs?: number;
    /** Context properties that must be callable. */
    functions?: string[];
    /** Log levels `ctx.log` must offer. */
    logLevels?: string[];
    /** Context properties that must NOT exist. */
    absent?: string[];
  };
}

/** How the adapter behaves in one round-trip case. */
export interface AdapterSpec {
  /** Lines to write, as `[level, ...parts]`. */
  log?: [string, ...unknown[]][];
  /** What `sync` resolves to. */
  returns?: unknown;
  /** Set when `sync` must fall off the end without a value. */
  returnsUndefined?: boolean;
  /** The message `sync` throws instead of returning. */
  throws?: string;
}

/** One adapter result driven all the way through the wire and back. */
export interface RoundTripCase {
  /** What this case pins. */
  name: string;
  /** The failure it prevents. */
  why: string;
  /** How the adapter behaves. */
  adapter: AdapterSpec;
  /** The exact JSON body the hosted runtime must produce. */
  wire: Record<string, unknown>;
  /** The exact key set of that body — absence is half the contract. */
  wireKeys: string[];
  /**
   * Keys from `wireKeys` an implementation may legitimately omit.
   *
   * Rare, and never a convenience. It exists for the one case where two
   * spellings are the same statement: a `cursor: null` and no `cursor` key are
   * read identically, so pinning the key set exactly would make one
   * implementation wrong for being tidier. Anything not listed here is
   * mandatory, so widening the contract stays a deliberate edit rather than a
   * thing a failing test can be argued into.
   */
  wireKeysOptional?: string[];
  /** The HTTP status, when not 200. */
  wireStatus?: number;
  /** The runner-facing result, when the wire body is a success. */
  result?: Record<string, unknown>;
  /** The exact key set of that result. */
  resultKeys?: string[];
  /** Pattern the reader's error must match, when the wire body is a failure. */
  rejectMatches?: string;
  /** Log lines the reader must lift onto that error. */
  rejectLogs?: string[];
}

/** One response body the reader must accept or refuse, whoever produced it. */
export interface ResponseCase {
  /** What this case pins. */
  name: string;
  /** The failure it prevents. */
  why: string;
  /** The parsed response body. */
  body: unknown;
  /** The expected runner-facing result, when asserted in full. */
  accept?: Record<string, unknown>;
  /** The exact key set of an accepted result. */
  acceptKeys?: string[];
  /** Pattern the rejection message must match. */
  rejectMatches?: string;
}

/** One HTTP-level case: status, headers and raw bytes, not just shape. */
export interface HttpCase {
  /** What this case pins. */
  name: string;
  /** The failure it prevents. */
  why: string;
  /** The response status. */
  status: number;
  /** A body serialized from JSON. */
  body?: unknown;
  /** A body sent verbatim, for the not-JSON cases. */
  bodyText?: string;
  /** A `content-length` the response claims (which may be a lie). */
  contentLength?: number;
  /** How many documents an accepted read must yield. */
  acceptDocuments?: number;
  /** Pattern the rejection message must match. */
  rejectMatches?: string;
  /** Log lines the reader must lift onto the error. */
  rejectLogs?: string[];
}

/** The whole fixture file, typed. */
export interface ContractFixtures {
  /**
   * Which contract this file IS — `source-invoke`.
   *
   * Present in the JSON from the start and missing from this type until a test
   * asserted on it. It matters most to the reader that cannot use this type at
   * all: the Mac runner opens the raw file and has nothing but these keys to
   * confirm it read the right one.
   */
  contract: string;
  /** Bumped when a change is not backwards compatible for installed runtimes. */
  version: number;
  /** Limits and identifiers. */
  constants: ContractConstants;
  /** Method/path cases. */
  route: RouteCase[];
  /** Request-to-`ctx` cases. */
  context: ContextCase[];
  /** Adapter-to-wire-to-runner cases. */
  roundTrip: RoundTripCase[];
  /** Wire-to-runner cases, for bodies this repo did not produce. */
  response: ResponseCase[];
  /** HTTP-level cases. */
  http: HttpCase[];
}

/**
 * The source-invoke contract fixtures, with placeholders expanded.
 *
 * Every implementation of the invoke contract is expected to run these. A case
 * that only one side executes is a document, not a gate.
 */
export const contract: ContractFixtures = expand(raw) as ContractFixtures;

/**
 * The case-bearing sections, so a runner can prove it left none unexecuted.
 *
 * Adding a section to the JSON without wiring it up is the easiest way to end
 * up with fixtures nobody runs, so the runners assert this list is exactly what
 * they cover.
 */
export const CASE_SECTIONS: readonly (keyof ContractFixtures)[] = [
  'route',
  'context',
  'roundTrip',
  'response',
  'http',
];

/**
 * Sections an implementation that PRODUCES invoke responses must run.
 *
 * A deployed source answers requests; Trove reads the answers. Those are two
 * different obligations, and an implementation that only does one of them
 * cannot execute the other's cases — the split is here so "we do not run that
 * section" is a stated position rather than a silence that reads as coverage.
 */
export const PRODUCER_SECTIONS: readonly (keyof ContractFixtures)[] = [
  'route',
  'context',
  'roundTrip',
];

/**
 * Sections an implementation that READS invoke responses must run.
 *
 * These hold what a reader must accept or refuse from a body it did not
 * produce — an oversized response, a lying `content-length`, a 500 whose logs
 * have to survive onto the error. `roundTrip` appears in both lists on purpose:
 * its `wire` half is the producer's obligation and its `result` half is the
 * reader's, which is precisely why the two are pinned in one case rather than
 * two that could drift.
 */
export const READER_SECTIONS: readonly (keyof ContractFixtures)[] = ['response', 'http'];
