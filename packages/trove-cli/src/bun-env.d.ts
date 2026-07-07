/**
 * Minimal ambient declarations for the Bun runtime globals the CLI uses. The
 * `trove` CLI ships as a Bun single-binary, so `Bun.*` is always present at
 * runtime; this shim gives `tsc` (which typechecks under Node) just the surface
 * we call, without pulling in the full `bun-types` package. Keep it narrow — add
 * only what `src/` actually uses.
 */

interface BunBuildArtifact {
  text(): Promise<string>;
}

interface BunBuildResult {
  success: boolean;
  outputs: BunBuildArtifact[];
  logs: unknown[];
}

interface BunBuildOptions {
  entrypoints: string[];
  target?: 'browser' | 'bun' | 'node';
  conditions?: string[];
  minify?: boolean;
  plugins?: unknown[];
}

declare const Bun: {
  plugin(plugin: unknown): void;
  build(options: BunBuildOptions): Promise<BunBuildResult>;
};

/**
 * Minimal `bun:test` surface for the Bun smoke suite (`test:smoke`, run with
 * `bun test`). Typed here so `tsc` — which runs under Node and has no `bun:test`
 * — can typecheck `*.smoke.test.ts`. Keep narrow; add matchers as used.
 */
interface BunTestMatchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeGreaterThan(expected: number): void;
  toMatch(expected: RegExp | string): void;
  readonly not: BunTestMatchers;
}

declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): BunTestMatchers;
}
