import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../context.js';
import { ExitCode, usageError } from '../errors.js';
import { flag, type ParsedArgs } from '../lib/args.js';
import { bundleServer, type ServerBundle } from '../lib/bundle.js';
import * as ops from '../operations.js';
import { renderJson, renderTable } from '../output.js';
import type { McpServer } from '../types.js';

/**
 * Resolve a server slug/id argument to the server's id via `mcpServers`.
 *
 * @param ctx - The command context.
 * @param slugOrId - The server slug or id.
 * @returns The resolved server id.
 * @throws {@link CliError} (not found) when no server matches.
 */
async function resolveServerId(ctx: CommandContext, slugOrId: string): Promise<string> {
  const data = await ctx
    .client()
    .request<{ mcpServers: McpServer[] }>(
      { query: ops.MCP_SERVERS, operationName: 'CliMcpServers' },
      true,
    );
  const match =
    data.mcpServers.find((s) => s.id === slugOrId) ??
    data.mcpServers.find((s) => s.slug === slugOrId);
  if (!match) throw usageError(`No MCP server matching '${slugOrId}'.`);
  return match.id;
}

/** `trove mcp ls` → `query mcpServers`. */
export async function ls(ctx: CommandContext): Promise<number> {
  const data = await ctx
    .client()
    .request<{ mcpServers: McpServer[] }>(
      { query: ops.MCP_SERVERS, operationName: 'CliMcpServers' },
      true,
    );
  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(data.mcpServers, ctx.output.format));
  } else {
    const rows = data.mcpServers.map((s) => [
      s.slug,
      s.name,
      s.status,
      s.visibility,
      String(s.tools.length),
      s.activeDeployment?.version ?? '—',
    ]);
    ctx.writer.out(
      renderTable(['SLUG', 'NAME', 'STATUS', 'VIS', 'TOOLS', 'ACTIVE'], rows, ctx.style),
    );
  }
  return ExitCode.Success;
}

/**
 * `trove mcp deploy` (alias `trove deploy`) → `mutation deployServer`.
 *
 * Reads `manifest.json` from the project directory (`--dir`, default `.`),
 * bundles `server.ts` locally (Bun), uploads the bundle through a
 * Trove-provided callback, and registers/versions the server.
 *
 * @param ctx - The command context.
 * @param args - Parsed flags (`--dir`, `--name`, `--slug`).
 * @returns The process exit code.
 */
/** Injection points for {@link deploy} (so tests run without the Bun bundler). */
export interface McpDeployDeps {
  /** The server bundler. Defaults to {@link bundleServer}. */
  bundle?: (entry: string) => Promise<ServerBundle>;
}

/** Resolve the deploy name/slug from flags, falling back to the manifest. */
function resolveNameAndSlug(
  args: ParsedArgs,
  manifest: Record<string, unknown>,
): { name: string; slug: string } {
  const name =
    flag(args, 'name') ?? (typeof manifest.name === 'string' ? manifest.name : undefined);
  const slug =
    flag(args, 'slug') ??
    (typeof manifest.slug === 'string'
      ? manifest.slug
      : typeof manifest.id === 'string'
        ? manifest.id
        : undefined);
  if (!name || !slug) {
    throw usageError('Manifest must provide name and slug/id (or pass --name/--slug).');
  }
  return { name, slug };
}

export async function deploy(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: McpDeployDeps = {},
): Promise<number> {
  const dir = flag(args, 'dir') ?? '.';
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw usageError(`No manifest.json in '${dir}'. Run 'trove mcp init <name>' first.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const { name, slug } = resolveNameAndSlug(args, manifest);

  const serverEntry = join(dir, 'server.ts');
  if (!existsSync(serverEntry)) {
    throw usageError(`No server.ts in '${dir}'. Run 'trove mcp init <name>' first.`);
  }
  ctx.writer.err(ctx.style.dim(`Bundling ${serverEntry}…`));

  // Bundle the server into a deployable bundle and extract its tools, then carry
  // both in the manifest: `bundle` is what Trove uploads to the hosted runtime;
  // `tools` is cached so tools/list needs no sandboxed run.
  const bundleImpl = deps.bundle ?? bundleServer;
  const { bundle, tools } = await bundleImpl(serverEntry);
  const enriched = { ...manifest, bundle, tools };

  const data = await ctx.client().request<{
    deployServer: { id: string; version: string; status: string; tools: Array<{ name: string }> };
  }>({
    query: ops.DEPLOY_SERVER,
    operationName: 'CliDeployServer',
    variables: { name, slug, manifest: enriched },
  });

  const dep = data.deployServer;
  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(dep, ctx.output.format));
  } else {
    ctx.writer.err(ctx.style.green(`✓ deployed ${slug} (version ${dep.version}, ${dep.status})`));
    for (const tool of dep.tools) {
      ctx.writer.out(`${slug}__${tool.name}`);
    }
  }
  return ExitCode.Success;
}

/** `trove mcp pause <server>` → `mutation pauseServer`. */
export async function pause(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  return lifecycle(ctx, args, ops.PAUSE_SERVER, 'CliPauseServer', 'pauseServer', 'paused');
}

/** `trove mcp resume <server>` → `mutation resumeServer`. */
export async function resume(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  return lifecycle(ctx, args, ops.RESUME_SERVER, 'CliResumeServer', 'resumeServer', 'resumed');
}

/** `trove mcp rm <server>` → `mutation deleteServer` (soft-delete). */
export async function rm(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  return lifecycle(ctx, args, ops.DELETE_SERVER, 'CliDeleteServer', 'deleteServer', 'deleted');
}

/** Shared driver for single-id lifecycle mutations. */
async function lifecycle(
  ctx: CommandContext,
  args: ParsedArgs,
  query: string,
  operationName: string,
  field: string,
  verb: string,
): Promise<number> {
  const target = args.positionals[0];
  if (!target) throw usageError(`Usage: trove mcp ${verb.replace(/d$/, '')} <server>`);
  const id = await resolveServerId(ctx, target);
  const data = await ctx
    .client()
    .request<Record<string, { id: string; name: string; status: string }>>({
      query,
      operationName,
      variables: { id },
    });
  const server = data[field];
  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(server, ctx.output.format));
  } else {
    ctx.writer.err(ctx.style.green(`✓ ${verb} ${server?.name ?? target}`));
  }
  return ExitCode.Success;
}

/** `trove mcp rollback <server> <deploymentId>` → `mutation rollbackServer`. */
export async function rollback(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const [target, deploymentId] = args.positionals;
  if (!target || !deploymentId) {
    throw usageError('Usage: trove mcp rollback <server> <deploymentId>');
  }
  const id = await resolveServerId(ctx, target);
  const data = await ctx.client().request<{
    rollbackServer: { id: string; name: string; activeDeployment: { version: string } | null };
  }>({
    query: ops.ROLLBACK_SERVER,
    operationName: 'CliRollbackServer',
    variables: { id, deploymentId },
  });

  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson(data.rollbackServer, ctx.output.format));
  } else {
    ctx.writer.err(
      ctx.style.green(
        `✓ rolled back ${data.rollbackServer.name} → ${data.rollbackServer.activeDeployment?.version ?? deploymentId}`,
      ),
    );
  }
  return ExitCode.Success;
}

/**
 * `trove secret set <server> <name>` → `mutation setServerSecret`. The value is
 * read from `--from-file <path>`, `--from-stdin`, or `--value` so it never
 * lands in argv history when prompted. The value is sealed into the encrypted
 * vault server-side and is never stored in plaintext.
 *
 * @param ctx - The command context.
 * @param args - Parsed flags + positionals (`<server> <name>`).
 * @returns The process exit code.
 */
export async function secretSet(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const [target, name] = args.positionals;
  if (!target || !name) {
    throw usageError(
      'Usage: trove secret set <server> <name> (--value <v>|--from-file <p>|--from-stdin)',
    );
  }
  const fromFile = flag(args, 'from-file');
  const inline = flag(args, 'value');
  let value: string | undefined;
  if (inline !== undefined) value = inline;
  else if (fromFile !== undefined) value = readFileSync(fromFile, 'utf8').replace(/\n$/, '');
  else if (args.bools.has('from-stdin')) value = readFileSync(0, 'utf8').replace(/\n$/, '');
  if (value === undefined) {
    throw usageError('Provide the secret via --value, --from-file <path>, or --from-stdin.');
  }

  const serverId = await resolveServerId(ctx, target);
  const data = await ctx.client().request<{ setServerSecret: boolean }>({
    query: ops.SET_SERVER_SECRET,
    operationName: 'CliSetServerSecret',
    variables: { serverId, name, value },
  });

  if (ctx.output.format !== 'human') {
    ctx.writer.out(renderJson({ setServerSecret: data.setServerSecret }, ctx.output.format));
  } else {
    ctx.writer.err(ctx.style.green(`✓ secret '${name}' sealed for ${target}`));
  }
  return ExitCode.Success;
}

/**
 * `trove secret ls <server>` → `query mcpServers`, reading the `secrets` field
 * (declared secret **names** only — values are unreadable by design). Human
 * output lists one name per line; `--json` emits
 * `{ server, secrets }`.
 *
 * @param ctx - The command context.
 * @param args - Parsed positionals (`<server>`).
 * @returns The process exit code.
 */
export async function secretLs(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  if (!target) throw usageError('Usage: trove secret ls <server>');
  const data = await ctx
    .client()
    .request<{ mcpServers: McpServer[] }>(
      { query: ops.MCP_SERVERS, operationName: 'CliMcpServers' },
      true,
    );
  const server = data.mcpServers.find((s) => s.id === target || s.slug === target);
  if (!server) throw usageError(`No MCP server matching '${target}'.`);

  const secrets = server.secrets ?? [];
  if (ctx.output.format === 'jsonl') {
    ctx.writer.out(renderJson(secrets, 'jsonl'));
  } else if (ctx.output.format === 'json') {
    ctx.writer.out(renderJson({ server: server.slug, secrets }, 'json'));
  } else if (secrets.length === 0) {
    ctx.writer.err(ctx.style.dim(`${server.slug} declares no secrets.`));
  } else {
    for (const name of secrets) ctx.writer.out(name);
  }
  return ExitCode.Success;
}

/** Flag specs for the mcp/secret commands. */
export const flagSpecs = {
  deploy: { value: ['dir', 'name', 'slug'] },
  secretSet: { value: ['value', 'from-file'], boolean: ['from-stdin'] },
};
