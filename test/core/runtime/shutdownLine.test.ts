/**
 * How the desktop shell asks the server to stop (design 2026-11-16 §4.1): one line on the server's
 * standard input, or the end of that input.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { onShutdownRequest, SHUTDOWN_LINE } from '../../../src/core/runtime/shutdownLine.js';

const settle = () => new Promise((r) => setImmediate(r));

describe('the shutdown request on standard input', () => {
  it('is the line, alone on its line, with either line ending', async () => {
    for (const text of [`${SHUTDOWN_LINE}\n`, `${SHUTDOWN_LINE}\r\n`]) {
      const input = new PassThrough();
      const seen: string[] = [];
      onShutdownRequest(input, (why) => seen.push(why));
      input.write(text);
      await settle();
      expect(seen, JSON.stringify(text)).toEqual(['asked']);
    }
  });

  it('is not any other line', async () => {
    const input = new PassThrough();
    const seen: string[] = [];
    onShutdownRequest(input, (why) => seen.push(why));
    input.write(`hello\n${SHUTDOWN_LINE} now\nx ${SHUTDOWN_LINE}\n\n`);
    await settle();
    expect(seen).toEqual([]);
  });

  it('is also the end of the input: the process that started the server is gone', async () => {
    const input = new PassThrough();
    const seen: string[] = [];
    onShutdownRequest(input, (why) => seen.push(why));
    input.end();
    await settle();
    expect(seen).toEqual(['input closed']);
  });

  it('is acted on once, however often it comes', async () => {
    const input = new PassThrough();
    const seen: string[] = [];
    onShutdownRequest(input, (why) => seen.push(why));
    input.write(`${SHUTDOWN_LINE}\n${SHUTDOWN_LINE}\n`);
    input.end();
    await settle();
    expect(seen).toEqual(['asked']);
  });
});
