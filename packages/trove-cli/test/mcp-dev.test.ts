import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineMcpServer, type McpServerDefinition, z } from '@ontrove/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as mcpDev from '../src/commands/mcp-dev.js';
import { buildContext } from '../src/context.js';
import { ExitCode } from '../src/errors.js';
import { parseArgs } from '../src/lib/args.js';
import { present } from './helpers';
import { type CaptureWriter, captureWriter } from './helpers.js';

const server: McpServerDefinition = defineMcpServer({
  tools: [
    {
      name: 'echo',
      description: 'Echo a message.',
      input: z.object({ message: z.string() }),
      annotations: { readOnlyHint: true },
      async handler({ message }) {
        return { text: message };
      },
    },
  ],
});

/** A loader returning the fixed server, and a stub `serve`. */
function deps(): mcpDev.McpDevDeps {
  return {
    load: async <T>() => server as unknown as T,
    serve: async (_handler, port) => ({ port: port === 0 ? 9999 : port, close: async () => {} }),
  };
}

describe('mcp init', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-mcp-'));
    writer = captureWriter();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('scaffolds manifest.json + server.ts', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    const code = await mcpDev.init(ctx, parseArgs([join(dir, 'my-srv')]));
    expect(code).toBe(ExitCode.Success);
    const proj = join(dir, 'my-srv');
    const manifest = JSON.parse(readFileSync(join(proj, 'manifest.json'), 'utf8'));
    expect(manifest.id).toBe('my-srv');
    expect(Array.isArray(manifest.secrets)).toBe(true);
    expect(existsSync(join(proj, 'server.ts'))).toBe(true);
  });

  it('requires a name', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    await expect(mcpDev.init(ctx, parseArgs([]))).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('sanitizes a name with special characters into a slug', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    await mcpDev.init(ctx, parseArgs([join(dir, 'My Cool Server!')]));
    const manifest = JSON.parse(
      readFileSync(join(dir, 'My Cool Server!', 'manifest.json'), 'utf8'),
    );
    expect(manifest.id).toBe('my-cool-server');
  });
});

describe('mcp dev', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-mcp-'));
    writer = captureWriter();
    writeFileSync(join(dir, 'server.ts'), '// server');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves locally and prints the URL + tools (JSON, --once)', async () => {
    const ctx = buildContext({
      globals: { json: true },
      writer,
      isTTY: false,
      configEnv: { home: dir },
    });
    const code = await mcpDev.dev(
      ctx,
      parseArgs([dir, '--port', '8788', '--once'], { value: ['port'], boolean: ['once'] }),
      deps(),
    );
    expect(code).toBe(ExitCode.Success);
    const out = JSON.parse(writer.stdoutText());
    expect(out.url).toContain('127.0.0.1');
    expect(out.tools[0].name).toBe('echo');
  });

  it('renders a human tool table', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: true, configEnv: { home: dir } });
    await mcpDev.dev(ctx, parseArgs([dir, '--once'], { boolean: ['once'] }), deps());
    expect(writer.stdoutText()).toContain('echo');
    expect(writer.stderrText()).toContain('serving MCP server');
  });

  it('renders a write tool as KIND=write and surfaces titles in JSON', async () => {
    const writeServer: McpServerDefinition = defineMcpServer({
      tools: [
        {
          name: 'create_thing',
          title: 'Create Thing',
          description: 'Create a thing.',
          input: z.object({ name: z.string() }),
          mutating: true,
          async handler() {
            return { text: 'ok' };
          },
        },
      ],
    });
    const ctx = buildContext({ globals: {}, writer, isTTY: true, configEnv: { home: dir } });
    await mcpDev.dev(ctx, parseArgs([dir, '--once'], { boolean: ['once'] }), {
      load: async <T>() => writeServer as unknown as T,
      serve: async (_h, port) => ({ port, close: async () => {} }),
    });
    expect(writer.stdoutText()).toContain('write');

    const w2 = captureWriter();
    const ctx2 = buildContext({
      globals: { json: true },
      writer: w2,
      isTTY: false,
      configEnv: { home: dir },
    });
    await mcpDev.dev(ctx2, parseArgs([dir, '--once'], { boolean: ['once'] }), {
      load: async <T>() => writeServer as unknown as T,
      serve: async (_h, port) => ({ port, close: async () => {} }),
    });
    expect(JSON.parse(w2.stdoutText()).tools[0].title).toBe('Create Thing');
  });

  it('errors when server.ts is missing', async () => {
    rmSync(join(dir, 'server.ts'));
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    await expect(
      mcpDev.dev(ctx, parseArgs([dir, '--once'], { boolean: ['once'] }), deps()),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('rejects a non-server default export', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: dir } });
    await expect(
      mcpDev.dev(ctx, parseArgs([dir, '--once'], { boolean: ['once'] }), {
        load: async <T>() => ({}) as T,
        serve: async () => ({ port: 1, close: async () => {} }),
      }),
    ).rejects.toMatchObject({ code: ExitCode.Usage });
  });

  it('the served handler answers tools/list and a tool call', async () => {
    let captured: import('@ontrove/mcp').FetchHandler | undefined;
    const ctx = buildContext({
      globals: { json: true },
      writer,
      isTTY: false,
      configEnv: { home: dir },
    });
    await mcpDev.dev(ctx, parseArgs([dir, '--once'], { boolean: ['once'] }), {
      load: async <T>() => server as unknown as T,
      serve: async (handler, port) => {
        captured = handler;
        return { port, close: async () => {} };
      },
    });
    const list = await captured?.fetch(new Request('http://127.0.0.1/', { method: 'GET' }));
    expect(
      ((await present(list, 'tools/list response').json()) as { tools: Array<{ name: string }> })
        .tools[0]?.name,
    ).toBe('echo');
    const call = await captured?.fetch(
      new Request('http://127.0.0.1/', {
        method: 'POST',
        body: JSON.stringify({ tool: 'echo', args: { message: 'hi' } }),
      }),
    );
    expect(
      ((await present(call, 'tools/call response').json()) as { result: { text: string } }).result
        .text,
    ).toBe('hi');
  });
});

describe('mcp dev — live serve seam', () => {
  let dir: string;
  let writer: CaptureWriter;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trove-mcp-'));
    writer = captureWriter();
    writeFileSync(join(dir, 'server.ts'), '// server');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaultServe answers a real GET (tools/list) and POST (tool call)', async () => {
    // requires live loopback: exercises the real 127.0.0.1 bridge.
    const local = await mcpDev.defaultServe(
      (await import('@ontrove/mcp')).toFetchHandler(server),
      0,
    );
    try {
      const list = await fetch(`http://127.0.0.1:${local.port}/`);
      expect(((await list.json()) as { tools: Array<{ name: string }> }).tools[0]?.name).toBe(
        'echo',
      );
      const call = await fetch(`http://127.0.0.1:${local.port}/`, {
        method: 'POST',
        body: JSON.stringify({ tool: 'echo', args: { message: 'hi' } }),
      });
      expect(((await call.json()) as { result: { text: string } }).result.text).toBe('hi');
    } finally {
      await local.close();
    }
  });

  it('blocks until SIGINT then closes the server (no --once)', async () => {
    let closed = false;
    const ctx = buildContext({
      globals: { json: true },
      writer,
      isTTY: false,
      configEnv: { home: dir },
    });
    const promise = mcpDev.dev(ctx, parseArgs([dir]), {
      load: async <T>() => server as unknown as T,
      serve: async (_h, port) => ({
        port,
        close: async () => {
          closed = true;
        },
      }),
    });
    // Give the handler a tick to register its signal listener, then interrupt.
    await new Promise((r) => setTimeout(r, 10));
    process.emit('SIGINT');
    expect(await promise).toBe(ExitCode.Success);
    expect(closed).toBe(true);
  });
});

describe('mcp logs', () => {
  let writer: CaptureWriter;
  beforeEach(() => {
    writer = captureWriter();
  });

  it('explains there is no log stream (human) and exits 0', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: true, configEnv: { home: '/tmp' } });
    const code = await mcpDev.logs(ctx, parseArgs(['my-srv']));
    expect(code).toBe(ExitCode.Success);
    expect(writer.stderrText()).toMatch(/hosted runtime/);
  });

  it('returns structured JSON with available=false', async () => {
    const ctx = buildContext({
      globals: { json: true },
      writer,
      isTTY: false,
      configEnv: { home: '/tmp' },
    });
    await mcpDev.logs(ctx, parseArgs(['my-srv']));
    expect(JSON.parse(writer.stdoutText()).available).toBe(false);
  });

  it('requires a server argument', async () => {
    const ctx = buildContext({ globals: {}, writer, isTTY: false, configEnv: { home: '/tmp' } });
    await expect(mcpDev.logs(ctx, parseArgs([]))).rejects.toMatchObject({ code: ExitCode.Usage });
  });
});
