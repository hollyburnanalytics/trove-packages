import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ontroveSdk from '@ontrove/extend/source';
import * as ontroveMcp from '@ontrove/extend/toolkit';
import { usageError } from '../errors.js';

/**
 * The local build step: a source's `index.ts` or an MCP server's `server.ts`
 * is TypeScript, so the CLI transpiles and runs it in-process. The `trove` CLI
 * ships as a single Bun binary (`bun build --compile`) with a Node-compatible
 * runtime and a TypeScript loader embedded, so this uses Bun natively — no
 * separate bundler and no toolchain for the user to install. The `@ontrove/extend/source`
 * and `@ontrove/extend/toolkit` packages are embedded in the binary and supplied to the
 * user's code by a runtime resolver, so an `index.ts`/`server.ts` in any
 * directory runs even with no `node_modules` of its own. The *result* never
 * crosses the boundary (that is `ingestDocuments`/`deployServer`'s job).
 *
 * @module
 */

/**
 * A loaded module's namespace.
 *
 * Deliberately open past `default`: a source may export its `sync` by name and
 * nothing else, which is how the catalogue is written, so a type that admitted
 * only `default` described a narrower world than the one the loaders serve.
 */
interface ModuleNamespace {
  /** The default export, when the module has one. */
  default?: unknown;
  /** Any named export — read structurally by the source loaders. */
  [name: string]: unknown;
}

/** Options for {@link loadModule}/{@link bundleServer} (injection points for tests). */
export interface LoadModuleOptions {
  /**
   * Transpile the entry file and import it, returning its module namespace.
   * Injected so the Node-instrumented unit suite runs without the Bun loader;
   * defaults to the Bun loader (exercised by the Bun smoke test).
   */
  loadImpl?: (entry: string) => Promise<ModuleNamespace>;
  /**
   * Produce the deployable hosted-runtime bundle text for a server entry.
   * Injected in tests; defaults to the Bun deploy bundler.
   */
  bundleImpl?: (entry: string) => Promise<string>;
}

/**
 * The bare specifiers the deploy bundlers answer from the embedded runtime.
 *
 * Declared once and used BOTH to write the wrapper module and to build the
 * resolver filter, because holding the same specifier in two places is how this
 * broke: the rename to `@ontrove/extend` updated the wrapper's import text and
 * left the `onResolve` regex matching the retired name. Nothing failed — the
 * bundler quietly fell through to on-disk resolution, which exists in a
 * workspace and does not exist in the compiled binary.
 */
const TOOLKIT_SPECIFIER = '@ontrove/extend/toolkit';
/** The source-authoring specifier an author writes in `index.ts`. */
const SOURCE_SPECIFIER = '@ontrove/extend/source';
/**
 * A VIRTUAL specifier — no such package is published. The source deploy wrapper
 * imports it to reach the pre-bundled shim, which re-exports the whole source
 * library so {@link SOURCE_SPECIFIER} resolves to the SAME module.
 */
const SOURCE_RUNTIME_SPECIFIER = '@ontrove/source-runtime';
/**
 * The shared spine. Supplied to a SOURCE deploy — `@ontrove/extend/source`
 * re-exports every root export, so the embedded shim already contains them.
 * NOT supplied to a toolkit deploy: `@ontrove/extend/toolkit` does not re-export
 * the guarded-fetch helpers, so answering it there would hand back a module
 * missing `fetchPage` and fail as `undefined` at the first call instead of here.
 */
const ROOT_SPECIFIER = '@ontrove/extend';

/**
 * An exact-match filter over bare specifiers, with regex metacharacters escaped.
 *
 * @param specifiers - Specifiers to match exactly.
 * @returns A regex matching any one of them and nothing else.
 */
function exactly(...specifiers: string[]): RegExp {
  const alternatives = specifiers.map((s) => s.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')).join('|');
  return new RegExp(`^(?:${alternatives})$`);
}

/** Whether the embedded `@ontrove/*` resolver has been registered. */
let embeddedResolverRegistered = false;

/* v8 ignore start -- Bun-only; verified by the Bun smoke test, not the Node-instrumented unit suite. */

/**
 * Register a Bun runtime resolver that maps bare `@ontrove/extend/source`/`@ontrove/extend/toolkit`
 * imports to the copies embedded in the binary. This is what lets a user's
 * `index.ts`/`server.ts` — living in a directory with no `node_modules` — run
 * inside the compiled CLI: their `import { defineSource } from '@ontrove/extend/source'`
 * resolves to the exact version the CLI ships, with no install and no drift.
 */
function registerEmbeddedResolver(): void {
  if (embeddedResolverRegistered) return;
  Bun.plugin({
    name: 'ontrove-embedded',
    setup(build: { module: (specifier: string, cb: () => unknown) => void }): void {
      build.module('@ontrove/extend/source', () => ({ exports: ontroveSdk, loader: 'object' }));
      build.module('@ontrove/extend/toolkit', () => ({ exports: ontroveMcp, loader: 'object' }));
    },
  });
  embeddedResolverRegistered = true;
}

/**
 * The default loader: register the embedded `@ontrove/*` resolver, then import
 * the entry directly — Bun transpiles the TypeScript. The URL is cache-busted so
 * repeated loads (e.g. `dev` reruns) re-import fresh code.
 */
async function defaultLoad(entry: string): Promise<ModuleNamespace> {
  registerEmbeddedResolver();
  const url = `${pathToFileURL(resolve(entry)).href}?t=${String(Date.now())}`;
  return (await import(/* @vite-ignore */ url)) as ModuleNamespace;
}

/**
 * Flatten whatever `Bun.build` threw into a reason a user can act on.
 *
 * `Bun.build` rejects with an `AggregateError` whose own message is the useless
 * `"Bundle failed"`; the real reasons — the unresolved specifier, the syntax
 * error, the missing export — are in `.errors`. Reporting only the outer message
 * tells someone their deploy failed and nothing about why.
 *
 * @param error - The value `Bun.build` threw.
 * @returns The collected reasons, newline-separated, or the plain message.
 */
function bundleFailureReason(error: unknown): string {
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => String((e as { message?: unknown }).message ?? e)).join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * `Bun.build`, but a failure says why.
 *
 * @param entry - The user's entry file, for the message.
 * @param config - The build configuration to run.
 * @returns The build result.
 * @throws {@link CliError} (usage) carrying the underlying bundler reasons.
 */
async function buildOrExplain(
  entry: string,
  config: Parameters<typeof Bun.build>[0],
): Promise<Awaited<ReturnType<typeof Bun.build>>> {
  try {
    return await Bun.build(config);
  } catch (error) {
    throw usageError(`Failed to bundle ${entry} for deployment:\n${bundleFailureReason(error)}`);
  }
}

/**
 * Reject any `@ontrove/*` specifier the embedded resolver does not answer.
 *
 * Registered AFTER the specific handlers, so it only sees what they declined.
 * Without it an unhandled specifier is not an error: the bundler falls through
 * to on-disk resolution, which succeeds in a workspace and fails in the
 * compiled binary — so the break surfaces at a user's deploy rather than in
 * CI. It also silently admits a SECOND copy of the library, which would make
 * `defineSource` a different function from the one `runSource` expects.
 *
 * @param build - The Bun build plugin builder to register on.
 * @param handled - The specifiers the plugin does answer, for the message.
 */
function rejectUnhandledOntroveSpecifiers(build: BunBuildPluginBuilder, handled: string[]): void {
  build.onResolve({ filter: /^@ontrove\// }, (args: { path: string }) => {
    throw new Error(
      `Cannot bundle ${args.path} for deployment: the embedded runtime supplies ` +
        `${handled.join(' and ')}, and nothing else. Import one of those instead.`,
    );
  });
}

/**
 * The default deploy bundler: build the server + `toFetchHandler` wrapper into a
 * single ESM module for the hosted runtime (worker conditions). The compiled
 * binary has no on-disk `@ontrove/extend/toolkit` to bundle, so the MCP runtime is embedded
 * (pre-bundled for the worker target by `scripts/build-mcp-worker-runtime.mjs`)
 * and supplied to `Bun.build` via a resolver plugin.
 */
async function defaultBundleForDeploy(entry: string): Promise<string> {
  const mcpRuntime = (await import('../vendor/mcp-worker-runtime.js')).default;
  const tmp = mkdtempSync(join(tmpdir(), 'trove-deploy-'));
  const wrapper = join(tmp, 'entry.mjs');
  // Import the server via an ABSOLUTE path: the wrapper lives in a temp dir, so a
  // relative specifier would resolve against that dir, not the project.
  writeFileSync(
    wrapper,
    `import server from ${JSON.stringify(resolve(entry))};\n` +
      `import { toFetchHandler } from ${JSON.stringify(TOOLKIT_SPECIFIER)};\n` +
      `export default toFetchHandler(server);\n`,
  );
  try {
    const result = await buildOrExplain(entry, {
      entrypoints: [wrapper],
      target: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      plugins: [
        {
          name: 'ontrove-mcp-embedded',
          setup(build: BunBuildPluginBuilder): void {
            build.onResolve({ filter: exactly(TOOLKIT_SPECIFIER) }, () => ({
              path: TOOLKIT_SPECIFIER,
              namespace: 'ontrove-mcp',
            }));
            build.onLoad({ filter: /.*/, namespace: 'ontrove-mcp' }, () => ({
              contents: mcpRuntime,
              loader: 'js',
            }));
            rejectUnhandledOntroveSpecifiers(build, [TOOLKIT_SPECIFIER]);
          },
        },
      ],
    });
    const out = result.outputs[0];
    if (!result.success || out === undefined) {
      throw usageError(`Failed to bundle ${entry} for deployment.`);
    }
    return await out.text();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The default source deploy bundler: build the source + the runtime shim into a
 * single ESM module for the deployed-source sandbox (worker conditions). The
 * shim adapts the sandbox's `POST /sync` invoke to the `sync(ctx)` the author
 * already wrote, so nothing in `index.ts` is deployment-specific.
 *
 * `@ontrove/source-runtime` is a VIRTUAL specifier — no such package exists.
 * The plugin below answers it with the pre-bundled shim
 * (`scripts/build-source-worker-runtime.mjs`), because the compiled binary has
 * no on-disk `@ontrove/extend/source` to bundle. The author's own `@ontrove/extend/source` import
 * resolves to the SAME module, which is why the shim re-exports the SDK: two
 * copies would mean `defineSource` was not the function `runSource` expects.
 */
async function defaultBundleSourceForDeploy(entry: string): Promise<string> {
  const sourceRuntime = (await import('../vendor/source-worker-runtime.js')).default;
  const tmp = mkdtempSync(join(tmpdir(), 'trove-source-deploy-'));
  const wrapper = join(tmp, 'entry.mjs');
  // Import the source via an ABSOLUTE path: the wrapper lives in a temp dir, so
  // a relative specifier would resolve against that dir, not the project.
  writeFileSync(
    wrapper,
    // A NAMESPACE import, not a default one: a bare `export async function
    // sync(ctx)` is a complete adapter and is how the catalogue is written, so
    // a default import would bundle `undefined` and the hosted runtime would 500
    // on its first invoke rather than fail here. `createSourceWorker` normalises
    // a bare function to `{ sync }` itself.
    `import * as source from ${JSON.stringify(resolve(entry))};\n` +
      `import { createSourceWorker } from ${JSON.stringify(SOURCE_RUNTIME_SPECIFIER)};\n` +
      `export default createSourceWorker(source.default ?? source.sync);\n`,
  );
  try {
    const result = await buildOrExplain(entry, {
      entrypoints: [wrapper],
      target: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      plugins: [
        {
          name: 'ontrove-source-runtime-embedded',
          setup(build: BunBuildPluginBuilder): void {
            build.onResolve(
              { filter: exactly(SOURCE_RUNTIME_SPECIFIER, SOURCE_SPECIFIER, ROOT_SPECIFIER) },
              () => ({ path: SOURCE_RUNTIME_SPECIFIER, namespace: 'ontrove-source-runtime' }),
            );
            build.onLoad({ filter: /.*/, namespace: 'ontrove-source-runtime' }, () => ({
              contents: sourceRuntime,
              loader: 'js',
            }));
            rejectUnhandledOntroveSpecifiers(build, [SOURCE_SPECIFIER, ROOT_SPECIFIER]);
          },
        },
      ],
    });
    const out = result.outputs[0];
    if (!result.success || out === undefined) {
      throw usageError(`Failed to bundle ${entry} for deployment.`);
    }
    return await out.text();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* v8 ignore stop */

/**
 * Transpile a single TypeScript entry file and dynamically import the result,
 * returning the module's `default` export.
 *
 * The `@ontrove/extend/source`/`@ontrove/extend/toolkit` packages are supplied to the user's code from
 * the CLI itself (embedded, via {@link registerEmbeddedResolver}), so the
 * `index.ts`/`server.ts` runs even though its project directory has no
 * `node_modules`. The CLI then drives the loaded value structurally
 * (`runSource`/`toFetchHandler` read `sync`/`tools`/`handle`) — no
 * `instanceof` across the boundary.
 *
 * @param entry - Absolute path to the `.ts` entry file.
 * @param options - Injection points for tests.
 * @returns The module's `default` export.
 * @throws {@link CliError} (usage) when the load fails or has no default export.
 */
export async function loadModule<T = unknown>(
  entry: string,
  options: LoadModuleOptions = {},
): Promise<T> {
  const load = options.loadImpl ?? defaultLoad;
  const mod = await load(entry);
  if (mod.default === undefined || mod.default === null) {
    throw usageError(`${entry} has no default export.`);
  }
  return mod.default as T;
}

/**
 * Load a SOURCE entry, accepting either export shape an adapter is written in.
 *
 * `defineSource({ sync })` as a default export is what `source init` scaffolds,
 * and it is what {@link loadModule} demands. But a source's whole contract is
 * one `sync(ctx)` function, so a bare `export async function sync(ctx)` is a
 * complete adapter and needs no wrapper — which is how every source in the
 * catalogue is in fact written. Requiring the wrapper made the source commands
 * reject the entire corpus they exist to serve, including adapters already
 * running in production.
 *
 * A named `sync` is normalised to `{ sync }` here, exactly as
 * `createSourceWorker` already does at the other end of the pipe, so
 * everything downstream sees one shape.
 *
 * @param entry - Absolute path to the `.ts`/`.mjs` entry file.
 * @param options - Injection points for tests.
 * @returns The source object.
 * @throws {@link CliError} (usage) when the entry exports neither shape.
 */
export async function loadSourceModule<T = unknown>(
  entry: string,
  options: LoadModuleOptions = {},
): Promise<T> {
  const load = options.loadImpl ?? defaultLoad;
  const mod = (await load(entry)) as { default?: unknown; sync?: unknown };
  if (mod.default !== undefined && mod.default !== null) return mod.default as T;
  if (typeof mod.sync === 'function') return { sync: mod.sync } as T;
  throw usageError(
    `${entry} exports neither a default source nor a \`sync\` function. ` +
      'A source is either `export default defineSource({ sync })` or `export async function sync(ctx)`.',
  );
}

/** A cached tool descriptor extracted from a bundled server's `tools/list`. */
interface BundledTool {
  /** The tool name (becomes `{slug}__{name}` on the wire). */
  name: string;
  /** Human-readable display name (MCP `title`), when set. */
  title?: string;
  /** The human-readable description, when the tool declares one. */
  description?: string;
  /** Compiled JSON Schema for the tool's arguments (so clients see parameters). */
  inputSchema?: unknown;
  /** Compiled JSON Schema for structured output, when declared. */
  outputSchema?: unknown;
  /** MCP behavioral hints (`readOnlyHint`, …) so clients categorize correctly. */
  annotations?: unknown;
  /** Budget hint mirrored from the definition. */
  alwaysOn?: boolean;
}

/** The result of {@link bundleServer}: the deployable script + its tool list. */
export interface ServerBundle {
  /** The bundled ESM module (default export = the runtime's fetch handler). */
  bundle: string;
  /** The server's tool descriptors, cached on the deployment for `tools/list`. */
  tools: BundledTool[];
}

/** Minimal shape of the `Bun.build` plugin builder we use. */
interface BunBuildPluginBuilder {
  onResolve(
    filter: { filter: RegExp },
    // The callback receives the specifier being resolved. Handlers that answer a
    // fixed specifier ignore it; the catch-all needs it to name what it refused.
    cb: (args: { path: string }) => { path: string; namespace: string },
  ): void;
  onLoad(
    filter: { filter: RegExp; namespace: string },
    cb: () => { contents: string; loader: string },
  ): void;
}

/**
 * Bundle an MCP server's `server.ts` into a deployable module for the hosted
 * runtime and extract its tool descriptors.
 *
 * Two outputs from one source:
 *
 *   1. **`bundle`** — the server + a generated wrapper
 *      (`import server from '<entry>'; export default toFetchHandler(server)`)
 *      built for the hosted runtime. The default export is the `fetch` contract
 *      the runtime invokes, so the uploaded script serves `GET → tools` /
 *      `POST → run` with no extra glue.
 *   2. **`tools`** — the server is also loaded in-process ({@link loadModule}) to
 *      read its `tools` array, reduced to the descriptors cached on the
 *      deployment so `tools/list` needs no sandbox spin-up.
 *
 * @param entry - Absolute path to the server's `server.ts`.
 * @param options - Injection points for tests (loader + bundler).
 * @returns The deployable bundle string and the extracted tool descriptors.
 * @throws {@link CliError} (usage) when the bundle fails or the entry is not a server.
 */
/**
 * Reduce one loaded tool to its cached descriptor (null when it has no name).
 * Carries the full tools/list metadata so clients see parameters + annotations
 * (a tool with no annotations falls into the client's "other / needs approval"
 * bucket instead of "read-only").
 */
function toBundledTool(t: Record<string, unknown>): BundledTool | null {
  if (typeof t?.name !== 'string' || t.name.length === 0) return null;
  const tool: BundledTool = { name: t.name };
  if (typeof t.title === 'string') tool.title = t.title;
  if (typeof t.description === 'string') tool.description = t.description;
  if (typeof t.inputSchema === 'object' && t.inputSchema !== null) {
    tool.inputSchema = t.inputSchema;
  }
  if (typeof t.outputSchema === 'object' && t.outputSchema !== null) {
    tool.outputSchema = t.outputSchema;
  }
  if (typeof t.annotations === 'object' && t.annotations !== null) {
    tool.annotations = t.annotations;
  }
  if (t.alwaysOn === true) tool.alwaysOn = true;
  return tool;
}

export async function bundleServer(
  entry: string,
  options: LoadModuleOptions = {},
): Promise<ServerBundle> {
  // Tool descriptors come from loading the server in-process.
  const server = await loadModule<{
    tools?: ReadonlyArray<Record<string, unknown>>;
  }>(entry, options);
  if (!server || !Array.isArray(server.tools)) {
    throw usageError(`${entry} default export is not a server (expected defineToolkit(...)).`);
  }
  const tools = server.tools
    .map((t) => toBundledTool(t))
    .filter((tool): tool is BundledTool => tool !== null);

  const bundleFor = options.bundleImpl ?? defaultBundleForDeploy;
  const bundle = await bundleFor(entry);
  return { bundle, tools };
}

/**
 * Bundle a source's `index.ts` into a deployable module for the deployed-source
 * sandbox.
 *
 * The symmetric sibling of {@link bundleServer}, and deliberately smaller: a
 * source has no tool list to cache, so there is one output. The entry is still
 * loaded in-process first — the same check `trove source dev` makes — so
 * "this is not a source" is reported here rather than as a sandbox that
 * uploads cleanly and then fails on its first sync.
 *
 * @param entry - Absolute path to the source's `index.ts`.
 * @param options - Injection points for tests (loader + bundler).
 * @returns The deployable ESM module (default export = the invoke handler).
 * @throws {@link CliError} (usage) when the entry is not a source or the bundle fails.
 */
export async function bundleSource(
  entry: string,
  options: LoadModuleOptions = {},
): Promise<string> {
  const source = await loadSourceModule<{ sync?: unknown }>(entry, options);
  if (typeof source.sync !== 'function') {
    throw usageError(
      `${entry} is not a source: it must export a \`sync(ctx)\` function, ` +
        'either directly or as `export default defineSource({ sync })`.',
    );
  }
  const bundleFor = options.bundleImpl ?? defaultBundleSourceForDeploy;
  return await bundleFor(entry);
}

/**
 * Write `content` to `path` only if `path` does not already exist; otherwise
 * throw a usage error. Shared by the `init` scaffolders so a re-run never
 * silently clobbers an author's work.
 *
 * @param path - The file path to create.
 * @param content - The file content.
 * @throws {@link CliError} (usage) when the file already exists.
 */
export function writeNew(path: string, content: string): void {
  try {
    writeFileSync(path, content, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw usageError(`Refusing to overwrite existing file: ${path}`);
    }
    throw err;
  }
}
