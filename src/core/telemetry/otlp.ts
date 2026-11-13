import type { BusEvent } from '../events.js';

/**
 * Optional OTLP export of the event bus (WP-D): OTLP/HTTP with the JSON encoding, posted with the
 * built-in `fetch` (no OpenTelemetry SDK dependency). Each bus event becomes one log record with
 * ids, type and status attributes only — never agent or user free text (messages, request details,
 * deliverables), which may derive from uploads (privacy rule: upload text stays out of exports).
 */

type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string };
export type OtlpAttribute = { key: string; value: AnyValue };
export type OtlpLogRecord = {
  timeUnixNano: string;
  severityNumber: number;
  severityText: 'INFO' | 'ERROR';
  body: { stringValue: string };
  attributes: OtlpAttribute[];
};

const str = (key: string, v: string | undefined): OtlpAttribute[] => (v === undefined ? [] : [{ key, value: { stringValue: v } }]);
const bool = (key: string, v: boolean): OtlpAttribute => ({ key, value: { boolValue: v } });
const int = (key: string, v: number | undefined): OtlpAttribute[] => (v === undefined ? [] : [{ key, value: { intValue: String(v) } }]);
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One OTLP log record for a bus event (metadata only). */
export function toOtlpLogRecord(e: BusEvent, at: Date = new Date()): OtlpLogRecord {
  const attrs: OtlpAttribute[] = [...str('bif.event.type', e.type), ...str('bif.workspace_id', e.workspaceId)];
  let error = false;
  switch (e.type) {
    case 'run_event':
      attrs.push(...str('bif.agent_run_id', e.agentRunId), ...str('bif.task_id', e.taskId), ...str('bif.run_event.t', e.event.t));
      if (e.event.t === 'tool_call' || e.event.t === 'tool_result') attrs.push(...str('bif.tool', e.event.name));
      if (e.event.t === 'tool_result') attrs.push(bool('bif.ok', e.event.ok));
      if (e.event.t === 'done') attrs.push(...int('bif.exit_code', e.event.exitCode));
      if (e.event.t === 'usage') {
        attrs.push(...int('bif.usage.input_tokens', e.event.inputTokens), ...int('bif.usage.output_tokens', e.event.outputTokens));
      }
      if (e.event.t === 'error') {
        error = true;
        attrs.push(bool('bif.rate_limited', e.event.rateLimited));
      }
      break;
    case 'run_status':
      attrs.push(...str('bif.agent_run_id', e.agentRunId), ...str('bif.task_id', e.taskId), ...str('bif.status', e.status), ...int('bif.exit_code', e.exitCode));
      // Supervisor reasons are harness text (idle timeout, aborted, spawn failed, rate limited).
      attrs.push(...str('bif.reason', e.reason === undefined ? undefined : clip(e.reason)));
      error = e.status === 'failed';
      break;
    case 'tool_call':
      attrs.push(...str('bif.agent_run_id', e.agentRunId), ...str('bif.tool', e.tool), bool('bif.ok', e.ok));
      // Harness-generated rejection (role scope, schema validation); never echoes input values.
      attrs.push(...str('bif.error', e.error === undefined ? undefined : clip(e.error)));
      error = !e.ok;
      break;
    case 'decision':
      attrs.push(...str('bif.agent_run_id', e.decision.agentRunId), ...str('bif.decision.kind', e.decision.kind), ...str('bif.role', e.decision.role));
      break;
    case 'user_request':
    case 'user_request_resolved':
      attrs.push(
        ...str('bif.agent_run_id', e.request.agentRunId), ...str('bif.task_id', e.request.taskId),
        ...str('bif.request.id', e.request.id), ...str('bif.request.kind', e.request.kind), ...str('bif.status', e.request.status),
      );
      break;
    case 'task_status':
      attrs.push(...str('bif.task_id', e.taskId), ...str('bif.status', e.status));
      error = e.status === 'failed';
      break;
  }
  return {
    timeUnixNano: String(at.getTime() * 1_000_000),
    severityNumber: error ? 17 : 9,
    severityText: error ? 'ERROR' : 'INFO',
    body: { stringValue: e.type },
    attributes: attrs,
  };
}

export type OtlpExporterOptions = {
  /** OTLP/HTTP base URL; records are posted to `<endpoint>/v1/logs`. */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  /** Injected for tests; default the global `fetch`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Flush delay after the first buffered event. Default 2000 ms. */
  batchMs?: number;
  /** Flush immediately at this many buffered events. Default 200. */
  maxBatch?: number;
};

export type OtlpExporter = {
  push(e: BusEvent): void;
  /** Sends everything buffered now. Never rejects. */
  flush(): Promise<void>;
  /** Flushes and stops the timer. */
  close(): Promise<void>;
};

/** Batching OTLP/HTTP JSON log exporter. Export failures are logged (once per outage), never thrown. */
export function createOtlpExporter(opts: OtlpExporterOptions): OtlpExporter {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/logs`;
  const doFetch = opts.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
  const batchMs = opts.batchMs ?? 2000;
  const maxBatch = opts.maxBatch ?? 200;
  let buffer: OtlpLogRecord[] = [];
  let timer: NodeJS.Timeout | undefined;
  let failing = false;
  let inflight: Promise<void> = Promise.resolve();

  const send = async (records: OtlpLogRecord[]) => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: opts.serviceName ?? 'bif' } }] },
          scopeLogs: [{ scope: { name: 'bif.events' }, logRecords: records }],
        },
      ],
    };
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      failing = false;
    } catch (err) {
      if (!failing) console.warn(`[bif] OTLP export to ${url} failed: ${(err as Error).message}`);
      failing = true;
    }
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (buffer.length) {
      const records = buffer;
      buffer = [];
      inflight = inflight.then(() => send(records));
    }
    return inflight;
  };

  return {
    push(e) {
      buffer.push(toOtlpLogRecord(e));
      if (buffer.length >= maxBatch) void flush();
      else if (!timer) {
        timer = setTimeout(() => void flush(), batchMs);
        timer.unref?.();
      }
    },
    flush,
    close: flush,
  };
}
