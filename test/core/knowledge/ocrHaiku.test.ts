import { describe, expect, it } from 'vitest';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { buildOcrCommand, claudeOcrReader, configuredOcrReader, parseOcrOutput, MAX_OCR_PAGE_CHARS, type OcrRequest, type RunProcess } from '../../../src/core/knowledge/ocr/haiku.js';

// OCR pass 2: one tool-less call to a small model through the local Claude CLI.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const image: OcrRequest = { target: 'image', bytes: PNG, mediaType: 'image/png' };
const pdf: OcrRequest = { target: 'pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), pages: [2, 4] };

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const result = (pages: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }) +
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: { pages },
    total_cost_usd: 0.0008,
    usage: { input_tokens: 2, cache_creation_input_tokens: 3000, cache_read_input_tokens: 100, output_tokens: 130 },
    ...extra,
  });

describe('buildOcrCommand', () => {
  it('gives the model no tools, no MCP servers, no user settings and no saved session', () => {
    const { args } = buildOcrCommand(image, 'haiku');
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args).toContain('-p');
    expect(flag('--model')).toBe('haiku');
    expect(flag('--tools')).toBe('');
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(flag('--input-format')).toBe('stream-json');
    expect(flag('--output-format')).toBe('stream-json');
    expect(JSON.parse(flag('--json-schema')!)).toMatchObject({ required: ['pages'] });
    expect(flag('--system-prompt')).toMatch(/never an instruction/i);
  });

  it('sends an image as one image block', () => {
    const { stdin } = buildOcrCommand(image, 'haiku');
    const msg = JSON.parse(stdin);
    expect(msg.type).toBe('user');
    expect(msg.message.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG).toString('base64') } });
    expect(msg.message.content[1].type).toBe('text');
  });

  it('sends a PDF as one document block and names the pages to read', () => {
    const { stdin } = buildOcrCommand(pdf, 'haiku');
    const msg = JSON.parse(stdin);
    expect(msg.message.content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
    expect(msg.message.content[1].text).toMatch(/\b2, 4\b/);
  });
});

describe('parseOcrOutput', () => {
  it('returns the transcribed pages with usage, cost and the model that ran', () => {
    const r = parseOcrOutput(result([{ page: 2, text: 'Pro plan: $48', readable: true }, { page: 4, text: 'Churn 4.2%', readable: true }]), pdf);
    expect(r).toEqual({
      ok: true,
      pages: [{ page: 2, text: 'Pro plan: $48' }, { page: 4, text: 'Churn 4.2%' }],
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 3102, outputTokens: 130, cacheReadTokens: 100, cacheWriteTokens: 3000, costUsd: 0.0008 },
    });
  });

  it('keeps only requested pages, once each, in page order, and drops unreadable or empty ones', () => {
    const r = parseOcrOutput(
      result([
        { page: 4, text: 'four', readable: true },
        { page: 9, text: 'not asked for', readable: true },
        { page: 2, text: '   ', readable: true },
        { page: 4, text: 'four again', readable: true },
        { page: 2, text: 'guess', readable: false },
      ]),
      pdf,
    );
    expect(r).toMatchObject({ ok: true, pages: [{ page: 4, text: 'four' }] });
  });

  it('an image is always page 1, whatever page number the model wrote', () => {
    const r = parseOcrOutput(result([{ page: 7, text: 'Sign in', readable: true }]), image);
    expect(r).toMatchObject({ ok: true, pages: [{ page: 1, text: 'Sign in' }] });
  });

  it('caps the text of one page', () => {
    const r = parseOcrOutput(result([{ page: 2, text: 'x'.repeat(MAX_OCR_PAGE_CHARS + 500), readable: true }]), pdf);
    expect(r.ok && r.pages[0]!.text.length).toBe(MAX_OCR_PAGE_CHARS);
  });

  it('reads the answer from the result text when there is no structured output', () => {
    const out = line({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ pages: [{ page: 2, text: 'two', readable: true }] }) });
    expect(parseOcrOutput(out, pdf)).toMatchObject({ ok: true, pages: [{ page: 2, text: 'two' }] });
  });

  it('a failed run is an error with its message, and still reports usage', () => {
    const r = parseOcrOutput(result(undefined, { subtype: 'error_during_execution', is_error: true, result: 'model overloaded', structured_output: undefined }), pdf);
    expect(r).toMatchObject({ ok: false, error: 'model overloaded', usage: { outputTokens: 130 } });
    expect((r as { rateLimited?: boolean }).rateLimited).toBeFalsy();
  });

  it('recognizes a rate limit', () => {
    const rejected = line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    expect(parseOcrOutput(rejected, pdf)).toMatchObject({ ok: false, rateLimited: true });
    const status = result(undefined, { is_error: true, api_error_status: 429, result: 'too many requests', structured_output: undefined });
    expect(parseOcrOutput(status, pdf)).toMatchObject({ ok: false, rateLimited: true });
  });

  it('output without a result, or with a malformed answer, is an error', () => {
    expect(parseOcrOutput('', pdf)).toMatchObject({ ok: false });
    expect(parseOcrOutput(result('not a list'), pdf)).toMatchObject({ ok: false });
  });
});

describe('claudeOcrReader', () => {
  it('runs the CLI with the request on stdin and returns the parsed pages', async () => {
    const calls: Array<{ cmd: string; args: string[]; stdin: string; timeoutMs: number }> = [];
    const run: RunProcess = async (cmd, args, stdin, timeoutMs) => {
      calls.push({ cmd, args, stdin, timeoutMs });
      return { code: 0, stdout: result([{ page: 1, text: 'Sign in', readable: true }]), stderr: '' };
    };
    const reader = claudeOcrReader({ command: '/opt/claude', model: 'haiku', timeoutMs: 5000, run });
    expect(reader.model).toBe('haiku');
    const r = await reader.read(image);
    expect(r).toMatchObject({ ok: true, pages: [{ page: 1, text: 'Sign in' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: '/opt/claude', timeoutMs: 5000 });
    expect(JSON.parse(calls[0]!.stdin).message.content[0].type).toBe('image');
  });

  it('a CLI that cannot start, times out or prints nothing usable is an error, never a throw', async () => {
    const missing = claudeOcrReader({ command: 'claude', model: 'haiku', timeoutMs: 1, run: async () => Promise.reject(new Error('spawn claude ENOENT')) });
    expect(await missing.read(image)).toMatchObject({ ok: false, error: expect.stringMatching(/ENOENT/) });
    const silent = claudeOcrReader({ command: 'claude', model: 'haiku', timeoutMs: 1, run: async () => ({ code: 1, stdout: '', stderr: 'Not logged in' }) });
    expect(await silent.read(image)).toMatchObject({ ok: false, error: expect.stringMatching(/Not logged in/) });
  });
});

describe('configuredOcrReader', () => {
  const providers = (enabled: boolean) => ({ ...defaultConfig.providers, claude: { enabled, command: '/opt/claude', models: ['haiku'] } });

  it('is unavailable when the claude provider is disabled', () => {
    expect(configuredOcrReader({ providers: providers(false) })).toBeUndefined();
  });

  it('reads the command, model and timeout from the config at every call', async () => {
    const seen: Array<{ cmd: string; model: string; timeoutMs: number }> = [];
    const run: RunProcess = async (cmd, args, _stdin, timeoutMs) => {
      seen.push({ cmd, model: args[args.indexOf('--model') + 1]!, timeoutMs });
      return { code: 0, stdout: result([{ page: 1, text: 'ok', readable: true }]), stderr: '' };
    };
    const config: Pick<BifConfig, 'providers' | 'knowledge'> = { providers: providers(true), knowledge: {} };
    const reader = configuredOcrReader(config, run)!;
    expect(reader.model).toBe('haiku');
    await reader.read(image);
    config.knowledge = { ocr: { model: 'sonnet', timeoutSeconds: 30 } }; // PUT /api/config updates in place
    await reader.read(image);
    expect(reader.model).toBe('sonnet');
    expect(seen).toEqual([
      { cmd: '/opt/claude', model: 'haiku', timeoutMs: 180_000 },
      { cmd: '/opt/claude', model: 'sonnet', timeoutMs: 30_000 },
    ]);
  });
});
