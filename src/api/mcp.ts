import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context, Hono } from 'hono';
import type { HandleTool, ToolResult } from '../core/harness/tools/handlers.js';
import { ROLE_TOOLS, TOOL_DESCRIPTIONS, toolJsonSchema, type ToolName } from '../core/harness/tools/registry.js';
import type { TokenRegistry } from '../core/harness/tokens.js';

export type McpDeps = {
  tokens: Pick<TokenRegistry, 'resolve'>;
  handle: HandleTool;
};

function toCallToolResult(r: ToolResult): CallToolResult {
  if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.error }] };
  const content: CallToolResult['content'] = [
    { type: 'text', text: r.data === undefined ? 'ok' : JSON.stringify(r.data) },
  ];
  for (const img of r.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  return { content };
}

/**
 * Mounts the harness MCP server at `/mcp/:token` and at `/mcp` with a bearer token (streamable HTTP, stateless: a fresh MCP server
 * per HTTP request, bound to the run resolved from the token). `tools/list` returns only the
 * role's tools; calls go through `handle`, which re-checks the role scope. Unknown, revoked or
 * finished-run tokens get HTTP 401 before any MCP processing.
 *
 * Long-blocking tools (`request_approval`) keep the POST open as an SSE stream with keep-alive
 * comments, so the HTTP server must not impose a response timeout on this route.
 */
export function mountMcp(app: Hono, deps: McpDeps): void {
  const serve = async (c: Context, token: string) => {
    const ctx = deps.tokens.resolve(token);
    if (!ctx) {
      console.warn('[bif] mcp: rejected unknown or inactive run token');
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown or inactive run token' }, id: null }, 401);
    }
    const allowed: ToolName[] = ROLE_TOOLS[ctx.role];
    const server = new Server({ name: 'bif', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allowed.map((name) => ({
        name,
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: toolJsonSchema(name) as { type: 'object'; [k: string]: unknown },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      // Abort a blocked call when the MCP client cancels it or the HTTP connection goes away.
      const signal = AbortSignal.any([extra.signal, c.req.raw.signal]);
      const result = await deps.handle(ctx, req.params.name as ToolName, req.params.arguments ?? {}, { signal });
      return toCallToolResult(result);
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
  app.all('/mcp/:token', (c) => serve(c, c.req.param('token')));
  // Same server, token in `Authorization: Bearer <token>` (Codex reads it from an env var, so the
  // token never appears on the command line).
  app.all('/mcp', (c) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    return serve(c, m?.[1] ?? '');
  });
}
