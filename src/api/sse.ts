import type { BusEvent, EventBus } from '../core/events.js';

export type SseOptions = {
  /** Only events of this workspace; all events when absent. */
  workspaceId?: string;
  /** Keep-alive comment interval. Default 15 s. */
  heartbeatMs?: number;
  /** Closes the stream (client disconnected). */
  signal?: AbortSignal;
  /** The event as served; `undefined`: not sent (stakeholder design §7: withheld research). */
  serve?: (e: BusEvent) => BusEvent | undefined;
};

/**
 * Server-sent events stream of `BusEvent`s. Each event is an unnamed SSE message whose `data` is
 * the event JSON (with its `type`), which the web client receives as `message`. A comment line is
 * sent on connect and every `heartbeatMs`. The bus subscription ends when the client disconnects
 * (stream cancelled or `signal` aborted).
 */
export function sseResponse(events: EventBus, opts: SseOptions = {}): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const off = events.on((e: BusEvent) => {
        if (opts.workspaceId && e.workspaceId !== opts.workspaceId) return;
        const served = opts.serve ? opts.serve(e) : e;
        if (served) send(`data: ${JSON.stringify(served)}\n\n`);
      });
      const timer = setInterval(() => send(': ping\n\n'), opts.heartbeatMs ?? 15_000);
      timer.unref?.();
      const onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      cleanup = () => {
        if (closed) return;
        closed = true;
        off();
        clearInterval(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      send('retry: 3000\n: connected\n\n');
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
