import type { CliAdapter } from '../adapter.js';
import type { ProviderId } from '../../types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { OpenCodeAdapter } from './opencode.js';

/**
 * Returns a NEW adapter for the provider (adapters hold per-run parse state). `command`
 * overrides the executable, e.g. `config.providers[id].command`.
 */
export function getAdapter(id: ProviderId, command?: string): CliAdapter {
  switch (id) {
    case 'claude':
      return new ClaudeAdapter(command);
    case 'codex':
      return new CodexAdapter(command);
    case 'opencode':
      return new OpenCodeAdapter(command);
  }
}
