/**
 * Server-sent `BusEvent` stream, multiplexed: one `EventSource` per workspace shared by every
 * subscriber, closed when the last one unsubscribes. Understands both unnamed `message` events
 * and named events (`event: run_event`), filling `type` from the event name when missing.
 */
import { eventsUrl } from './api.js';
import type { BusEvent } from './types.js';

export type BusListener = (e: BusEvent) => void;

const EVENT_NAMES = [
  'message',
  'run_event',
  'run_status',
  'tool_call',
  'decision',
  'user_request',
  'user_request_resolved',
  'task_status',
] as const;

interface Channel {
  source: EventSource;
  listeners: Set<BusListener>;
}

const channels = new Map<string, Channel>();

function parse(raw: unknown, name: string): BusEvent | null {
  if (typeof raw !== 'string') return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.type !== 'string') {
      if (name === 'message') return null;
      obj.type = name;
    }
    return obj as unknown as BusEvent;
  } catch {
    return null;
  }
}

function open(workspaceId: string): Channel {
  const source = new EventSource(eventsUrl(workspaceId));
  const channel: Channel = { source, listeners: new Set() };
  for (const name of EVENT_NAMES) {
    source.addEventListener(name, (ev: Event) => {
      const event = parse((ev as MessageEvent).data, name);
      if (!event) return;
      for (const fn of [...channel.listeners]) {
        try {
          fn(event);
        } catch (err) {
          console.error('[bif] SSE listener failed:', err);
        }
      }
    });
  }
  return channel;
}

/** Subscribes to a workspace's event stream; returns the unsubscribe function. */
export function subscribe(workspaceId: string, listener: BusListener): () => void {
  let channel = channels.get(workspaceId);
  if (!channel) {
    channel = open(workspaceId);
    channels.set(workspaceId, channel);
  }
  const ch = channel;
  ch.listeners.add(listener);
  return () => {
    ch.listeners.delete(listener);
    if (ch.listeners.size === 0) {
      ch.source.close();
      if (channels.get(workspaceId) === ch) channels.delete(workspaceId);
    }
  };
}
