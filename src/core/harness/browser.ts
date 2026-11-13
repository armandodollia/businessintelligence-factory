import { resolve } from 'node:path';
import type { BifConfig } from '../config/schema.js';

/**
 * MCP servers handed to browser-using runs. Backend `mcp`: `browser.mcpServers` with every
 * `{{profileDir}}` placeholder replaced by the absolute dedicated research profile directory
 * (never the user's everyday browser profile). Backend `t3`: `{}`; agents use the T3 Code
 * browser tools instead (see `browserPromptNote`).
 */
export function browserMcpServers(cfg: Pick<BifConfig, 'browser'>): Record<string, unknown> {
  if (cfg.browser.backend === 't3') return {};
  const profileDir = resolve(cfg.browser.profileDir);
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split('{{profileDir}}').join(profileDir);
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(cfg.browser.mcpServers) as Record<string, unknown>;
}

/** Browser instructions appended to the system prompt of browser-using runs. */
export function browserPromptNote(cfg: Pick<BifConfig, 'browser'>): string {
  const common =
    'The browser uses a dedicated, persistent research profile that stays logged into accounts created ' +
    'for research. Open your own tabs and close them when you are done; other agents share the browser.';
  if (cfg.browser.backend === 't3') {
    return `## Browser\nUse the T3 Code browser tools (not a browser MCP server) for all browsing. ${common}`;
  }
  return `## Browser\nUse the browser MCP tools for all browsing. ${common}`;
}
