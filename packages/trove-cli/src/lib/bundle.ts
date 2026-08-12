import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ontroveMcp from '@ontrove/mcp';
import * as ontroveSdk from '@ontrove/sdk';
import { usageError } from '../errors.js';

/**
 * The local build step: a source's `index.ts` or an MCP server's `server.ts`
 * is TypeScript, so the CLI transpiles and runs it in-process. The `trove` CLI
 * ships as a single Bun binary (`bun build --compile`) with a Node-compatible
 * runtime and a TypeScript loader embedded, so this uses Bun natively — no
 * separate bundler and no toolchain for the user to install. The `@ontrove/sdk`
 * and `@ontrove/mcp` packages are embedded in the binary and supplied to the
 * user's code by a runtime resolver, so an `index.ts`/`server.ts` in any
 * directory runs even with no `node_modules` of its own. The *result* never
 * crosses the boundary (that is `ingestDocuments`/`deployServer`'s job).
 *
 * @module
 */

/** Options for {@link loadModule}/{@link bundleServer} (injection points for tests). */
export interface LoadModuleOptions {
  /**
   * Transpile the entry file and import it, returning its module namespace.
   * Injected so the Node-instrumented unit suite runs without the Bun loader;
   * defaults to the Bun loader (exercised by the Bun smoke test).
   */
  loadImpl?: (entry: string) => Promise<{ default?: unknown }>;
  /**
   * Produce the deployable hosted-runtime bundle text for a server entry.
   * Injected in tests; defaults to the Bun deploy bundler.
   */
  bundleImpl?: (entry: string) => Promise<string>;
}

/** Whether the embedded `@ontrove/*` resolver has been registered. */
let embeddedResolverRegistered = false;

/* v8 ignore start -- Bun-only; verified by the Bun smoke test, not the Node-instrumented unit suite. */

/**
 * Register a Bun runtime resolver that maps bare `@ontrove/sdk`/`@ontrove/mcp`
 * imports to the copies embedded in the binary. This is what lets a user's
 * `index.ts`/`server.ts` — living in a directory with no `node_modules` — run
 * inside the compiled CLI: their `import { defineSource } from '@ontrove/sdk'`
 * resolves to the exact version the CLI ships, with no install and no drift.
 */
function registerEmbeddedResolver(): void {
  if (embeddedResolverRegistered) return;
  Bun.plugin({
    name: 'ontrove-embedded',
    setup(build: { module: (specifier: string, cb: () => unknown) => void }): void {
      build.module('@ontrove/sdk', () => ({ exports: ontroveSdk, loader: 'object' }));
      build.module('@ontrove/mcp', () => ({ exports: ontroveMcp, loader: 'object' }));
    },
  });
  embeddedResolverRegistered = true;
}

/**
 * The default loader: register the embedded `@ontrove/*` resolver, then import
 * the entry directly — Bun transpiles the TypeScript. The URL is cache-busted so
 * repeated loads (e.g. `dev` reruns) re-import fresh code.
 */
async function defaultLoad(entry: string): Promise<{ default?: unknown }> {
  registerEmbeddedResolver();
  const url = `${pathToFileURL(resolve(entry)).href}?t=${String(Date.now())}`;
  return (await import(/* @vite-ignore */ url)) as { default?: unknown };
}

/**
 * The default deploy bundler: build the server + `toFetchHandler` wrapper into a
 * single ESM module for the hosted runtime (worker conditions). The compiled
 * binary has no on-disk `@ontrove/mcp` to bundle, so the MCP runtime is embedded
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
      `import { toFetchHandler } from '@ontrove/mcp';\n` +
      `export default toFetchHandler(server);\n`,
  );
  try {
    const result = await Bun.build({
      entrypoints: [wrapper],
      target: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      plugins: [
        {
          name: 'ontrove-mcp-embedded',
          setup(build: BunBuildPluginBuilder): void {
            build.onResolve({ filter: /^@ontrove\/mcp$/ }, () => ({
              path: '@ontrove/mcp',
              namespace: 'ontrove-mcp',
            }));
            build.onLoad({ filter: /.*/, namespace: 'ontrove-mcp' }, () => ({
              contents: mcpRuntime,
              loader: 'js',
            }));
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
 * no on-disk `@ontrove/sdk` to bundle. The author's own `@ontrove/sdk` import
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
    `import source from ${JSON.stringify(resolve(entry))};\n` +
      `import { createSourceWorker } from '@ontrove/source-runtime';\n` +
      `export default createSourceWorker(source);\n`,
  );
  try {
    const result = await Bun.build({
      entrypoints: [wrapper],
      target: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      plugins: [
        {
          name: 'ontrove-source-runtime-embedded',
          setup(build: BunBuildPluginBuilder): void {
            build.onResolve({ filter: /^@ontrove\/(source-runtime|sdk)$/ }, () => ({
              path: '@ontrove/source-runtime',
              namespace: 'ontrove-source-runtime',
            }));
            build.onLoad({ filter: /.*/, namespace: 'ontrove-source-runtime' }, () => ({
              contents: sourceRuntime,
              loader: 'js',
            }));
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
 * The `@ontrove/sdk`/`@ontrove/mcp` packages are supplied to the user's code from
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
  onResolve(filter: { filter: RegExp }, cb: () => { path: string; namespace: string }): void;
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
    throw usageError(`${entry} default export is not a server (expected defineMcpServer(...)).`);
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
  const source = await loadModule<{ sync?: unknown }>(entry, options);
  if (typeof source.sync !== 'function') {
    throw usageError(`${entry} default export is not a source (expected defineSource(...)).`);
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
