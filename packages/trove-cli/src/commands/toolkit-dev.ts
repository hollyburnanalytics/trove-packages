import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { type FetchHandler, type ToolkitDefinition, toFetchHandler } from '@ontrove/extend/toolkit';
import type { CommandContext } from '../context.js';
import { ExitCode, usageError } from '../errors.js';
import { intFlag, type ParsedArgs } from '../lib/args.js';
import { type LoadModuleOptions, loadModule, writeNew } from '../lib/bundle.js';
import { renderJson, renderTable } from '../output.js';

/**
 * The toolkit dev toolchain, over `@ontrove/extend/toolkit`. `init`
 * scaffolds `manifest.json` + `server.ts`; `dev` loads `server.ts` with Bun,
 * wraps it in the SDK's runtime fetch handler, and serves it over
 * `http://127.0.0.1:<port>` so a client can connect; `logs` explains that
 * per-script logs come from the deployed hosted runtime (there is no logs GraphQL
 * op) and points at the deployed endpoint.
 *
 * @module
 */

/** Injection points so tests run without the Bun loader/network. */
export interface ToolkitDevDeps {
  /** Module loader (transpile + import). Defaults to the Bun loader. */
  load?: <T>(entry: string, options?: LoadModuleOptions) => Promise<T>;
  /**
   * Start the local HTTP server for a fetch handler, returning the bound port
   * and a stop function. Defaults to a real `127.0.0.1` listener.
   */
  serve?: (handler: FetchHandler, port: number) => Promise<LocalServer>;
}

/** A started local dev server. */
export interface LocalServer {
  /** The bound port. */
  port: number;
  /** Stop the server. */
  close(): Promise<void>;
}

/** Resolve the toolkit project directory from an optional path positional. */
function projectDir(args: ParsedArgs): string {
  const p = args.positionals[0] ?? '.';
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * `trove toolkit init <name>` — scaffold `<name>/manifest.json` + `<name>/server.ts`
 * (a `defineToolkit` stub with a sample tool, `annotations`, and `output`). No
 * GraphQL.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`<name>`).
 * @returns The process exit code.
 */
export async function init(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const name = args.positionals[0];
  if (!name) throw usageError('Usage: trove toolkit init <name>');
  const dir = isAbsolute(name) ? name : resolve(process.cwd(), name);
  mkdirSync(dir, { recursive: true });

  const slug = basename(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // ONE declaration, used twice: written into `server.ts` as the argument to
  // `defineToolkit`, and emitted as `manifest.json` from the same object. The
  // two used to be written separately, and the manifest half had no `icon` or
  // `version` at all — fields the directory shows and the deploy records.
  const declaration = {
    id: slug || 'my-toolkit',
    name: basename(name),
    description: `The ${basename(name)} toolkit.`,
    icon: '🧰',
    version: '1.0.0',
    visibility: 'private',
    secrets: [] as string[],
    egress: [] as string[],
    scopes: [] as string[],
  };
  writeNew(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ ...declaration, generated: true }, null, 2)}\n`,
  );
  writeNew(join(dir, 'server.ts'), serverStub(declaration));

  ctx.writer.err(ctx.style.green(`✓ scaffolded toolkit '${basename(name)}' in ${dir}`));
  ctx.writer.err(
    ctx.style.dim('Next: edit server.ts, then `trove toolkit dev` to serve it locally.'),
  );
  return Promise.resolve(ExitCode.Success);
}

/**
 * The scaffolded `server.ts`, built from the same declaration the manifest is.
 *
 * @param declaration - The toolkit's manifest fields.
 * @returns The `server.ts` contents.
 */
function serverStub(declaration: Record<string, unknown>): string {
  const fields = JSON.stringify(declaration, null, 2).slice(2, -2);
  return `import { defineToolkit, z } from '@ontrove/extend/toolkit';

/**
 * A hosted Trove toolkit: declare tools with a Zod \`input\` schema and a
 * handler. The handler receives validated args and a capability \`ctx\` (no
 * ambient authority). See the toolkit SDK reference.
 */
export default defineToolkit({
${fields},
  tools: [
    {
      name: 'echo',
      description: 'Echo a message back to the caller.',
      input: z.object({ message: z.string().describe('The message to echo.') }),
      output: z.object({ message: z.string() }),
      annotations: { readOnlyHint: true },
      async handler({ message }) {
        return { text: message, structured: { message } };
      },
    },
  ],
});
`;
}

/**
 * `trove toolkit dev [path]` — load `server.ts` (Bun), wrap it with the SDK
 * runtime fetch handler, and serve it over `http://127.0.0.1:<port>`. Prints the
 * local URL and the tool list. `ctx.secret`/`ctx.trove` callbacks resolve
 * against the local dev shim wired here.
 *
 * The server runs until interrupted; in tests the injected `serve` returns a
 * stub immediately and `--once` makes the command return without blocking.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`[path]`) + `--port`/`--once`.
 * @param deps - Injectable loader + server starter (tests).
 * @returns The process exit code.
 */
export async function dev(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: ToolkitDevDeps = {},
): Promise<number> {
  const dir = projectDir(args);
  const entry = join(dir, 'server.ts');
  if (!existsSync(entry)) {
    throw usageError(`No server.ts in '${dir}'. Run 'trove toolkit init <name>' first.`);
  }
  const load = deps.load ?? loadModule;
  const server = await load<ToolkitDefinition>(entry);
  if (
    server === null ||
    typeof server !== 'object' ||
    typeof server.handle !== 'function' ||
    !Array.isArray(server.tools)
  ) {
    throw usageError(`${entry} default export is not a server (expected defineToolkit(...)).`);
  }

  const port = intFlag(args, 'port') ?? 8788;
  const handler = toFetchHandler(server);
  const serve = deps.serve ?? defaultServe;
  const local = await serve(handler, port);
  const url = `http://127.0.0.1:${String(local.port)}`;

  if (ctx.output.format !== 'human') {
    ctx.writer.out(
      renderJson(
        { url, tools: server.tools.map((t) => ({ name: t.name, title: t.title })) },
        ctx.output.format,
      ),
    );
  } else {
    ctx.writer.err(ctx.style.green(`✓ serving toolkit at ${url}`));
    const rows = server.tools.map((t) => [
      t.name,
      t.annotations.readOnlyHint ? 'read' : 'write',
      t.description,
    ]);
    ctx.writer.out(renderTable(['TOOL', 'KIND', 'DESCRIPTION'], rows, ctx.style));
    ctx.writer.err(
      ctx.style.dim(`GET ${url} → tools/list · POST ${url} → run a tool. Ctrl-C to stop.`),
    );
  }

  if (args.bools.has('once')) {
    await local.close();
  } else {
    // requires live runtime: block until interrupted in the real CLI.
    await blockUntilSignal(local);
  }
  return ExitCode.Success;
}

/** Block until SIGINT/SIGTERM, then close the server. */
function blockUntilSignal(local: LocalServer): Promise<void> {
  return new Promise<void>((resolveSignal) => {
    const stop = (): void => {
      void local.close().then(resolveSignal);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * Start a real `127.0.0.1` HTTP server bridging Node req/res ⇄ fetch
 * Request/Response. Exported for tests; the default `serve` for `toolkit dev`.
 *
 * @param handler - The SDK fetch handler to serve.
 * @param port - The port to bind (0 for an ephemeral port).
 * @returns The started {@link LocalServer}.
 */
export function defaultServe(handler: FetchHandler, port: number): Promise<LocalServer> {
  // requires live loopback server
  return new Promise((resolveServer, rejectServer) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleNodeRequest(handler, req, res);
    });
    server.on('error', rejectServer);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const bound = addr !== null && typeof addr === 'object' ? (addr as AddressInfo).port : port;
      resolveServer({
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

/** Convert a Node request to a `Request`, run the handler, and write the `Response` back. */
async function handleNodeRequest(
  handler: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body.length > 0 ? { body } : {}),
  });
  const response = await handler.fetch(request);
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(await response.text());
}

/**
 * `trove toolkit logs <server>` — there is no logs GraphQL operation (per-script
 * logs come from the deployed hosted runtime). This
 * command does not invent a fake operation: it explains where logs live and
 * points at the deployed server's endpoint.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`<server>`).
 * @returns The process exit code.
 */
export async function logs(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  if (!target) throw usageError('Usage: trove toolkit logs <server>');

  const message =
    'Per-script logs are produced by the deployed hosted runtime and are ' +
    'not exposed through the GraphQL API. Tail them from the deployed endpoint ' +
    'once the runtime ships.';

  if (ctx.output.format !== 'human') {
    ctx.writer.out(
      renderJson({ server: target, available: false, reason: message }, ctx.output.format),
    );
  } else {
    ctx.writer.err(ctx.style.yellow(`No CLI log stream for '${target}'.`));
    ctx.writer.err(ctx.style.dim(message));
  }
  // Not an error — the command ran and reported accurate status.
  return ExitCode.Success;
}

/** Flag specs for the toolkit dev commands. */
export const flagSpecs = {
  init: {},
  dev: { value: ['port'], boolean: ['once'] },
  logs: {},
};
