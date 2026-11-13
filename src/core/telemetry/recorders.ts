import type { BifConfig } from '../config/schema.js';
import type { EventBus } from '../events.js';
import { recordPolicyEventsFromBus } from '../policy/policyEvents.js';
import type { Store } from '../store/db.js';
import { persistBusEvent, pruneBusEvents } from './busEvents.js';
import { createOtlpExporter, type OtlpExporter, type OtlpExporterOptions } from './otlp.js';

/** Effective `config.telemetry` (WP-D) with defaults applied. */
export function telemetrySettings(config: Pick<BifConfig, 'telemetry'>) {
  const t = config.telemetry ?? {};
  const otlp = t.otlp;
  return {
    busEventRetentionDays: t.busEventRetentionDays ?? 30,
    otlp: {
      enabled: otlp?.enabled ?? false,
      endpoint: otlp?.endpoint ?? 'http://127.0.0.1:4318',
      headers: otlp?.headers ?? {},
      serviceName: otlp?.serviceName ?? 'bif',
    },
  };
}

export type EventRecorders = {
  /** Unsubscribes and flushes the OTLP exporter (if any). */
  stop(): Promise<void>;
};

/** Prune old bus events after this many inserts (and on attach). */
const PRUNE_EVERY = 1000;

/**
 * Subscribes the WP-D recorders to the event bus: every bus event is persisted (`bus_events`,
 * see `persistBusEvent`), action-policy events are derived into `policy_events`, and — only when
 * `telemetry.otlp.enabled` — exported over OTLP/HTTP. Recorder failures are logged, never thrown
 * into the bus. Old bus events are pruned on attach and periodically.
 */
export function attachEventRecorders(deps: {
  store: Store;
  events: EventBus;
  config: BifConfig;
  /** Injected for tests (OTLP). */
  fetch?: OtlpExporterOptions['fetch'];
  otlpBatchMs?: number;
}): EventRecorders {
  const { store, events, config } = deps;
  const settings = telemetrySettings(config);
  const prune = () => {
    try {
      pruneBusEvents(store, telemetrySettings(config).busEventRetentionDays);
    } catch (err) {
      console.warn(`[bif] pruning bus events failed: ${(err as Error).message}`);
    }
  };
  prune();
  let exporter: OtlpExporter | undefined;
  if (settings.otlp.enabled) {
    const opts: OtlpExporterOptions = {
      endpoint: settings.otlp.endpoint,
      headers: settings.otlp.headers,
      serviceName: settings.otlp.serviceName,
    };
    if (deps.fetch) opts.fetch = deps.fetch;
    if (deps.otlpBatchMs !== undefined) opts.batchMs = deps.otlpBatchMs;
    exporter = createOtlpExporter(opts);
  }
  let inserted = 0;
  const off = events.on((e) => {
    try {
      if (persistBusEvent(store, e) !== undefined && ++inserted % PRUNE_EVERY === 0) prune();
    } catch (err) {
      console.warn(`[bif] persisting bus event failed: ${(err as Error).message}`);
    }
    try {
      recordPolicyEventsFromBus(store, e, config);
    } catch (err) {
      console.warn(`[bif] recording policy event failed: ${(err as Error).message}`);
    }
    exporter?.push(e);
  });
  return {
    async stop() {
      off();
      await exporter?.close();
    },
  };
}
