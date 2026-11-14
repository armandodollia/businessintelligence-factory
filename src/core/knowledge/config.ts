/**
 * Knowledge store settings (design §16): `config.knowledge` with every default applied. The block
 * and its defaults live in `config/schema.ts` (`knowledgeConfigSchema`, `KNOWLEDGE_DEFAULTS`); read
 * them only through `knowledgeSettings`.
 */
import {
  KNOWLEDGE_DEFAULTS,
  type BifConfig,
  type EntityKind,
  type KnowledgeBudgetKind,
  type ProviderId,
  type Role,
} from '../config/schema.js';

export type BudgetSet = Record<KnowledgeBudgetKind, number>;

export type KnowledgeSettings = {
  budgets: {
    default: BudgetSet;
    /** Per-role overrides; a missing kind falls back to `default`. */
    roles: Partial<Record<Role, Partial<BudgetSet>>>;
    providers: Partial<Record<ProviderId, number>>;
  };
  hardMaxTokens: number;
  freshness: { defaultDays: number; byEntityKind: Partial<Record<EntityKind, number>> };
  extraction: {
    maxTextChars: number;
    chunkTokens: number;
    maxChunkTokens: number;
    xlsxMaxRows: number;
    inlineMaxBytes: number;
    concurrency: number;
  };
  captions: { required: boolean; minChars: number };
  dedupe: { candidateLimit: number; similarityFloor: number };
  retention: { pruneMinAgeDays: number };
  ocr: {
    enabled: boolean;
    model: string;
    images: 'uploads' | 'all' | 'none';
    minPageChars: number;
    maxPages: number;
    pagesPerCall: number;
    maxFileBytes: number;
    timeoutSeconds: number;
    concurrency: number;
    rateLimitPauseMinutes: number;
  };
};

/** Drops `undefined` entries so spreading never overwrites a default with `undefined`. */
function defined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** `config.knowledge` merged over `KNOWLEDGE_DEFAULTS` (a fresh object on every call). */
export function knowledgeSettings(config: Pick<BifConfig, 'knowledge'>): KnowledgeSettings {
  const k = config.knowledge ?? {};
  const d = KNOWLEDGE_DEFAULTS;
  const roles: KnowledgeSettings['budgets']['roles'] = {};
  for (const [role, set] of Object.entries(d.budgets.roles)) roles[role as Role] = { ...set };
  for (const [role, set] of Object.entries(k.budgets?.roles ?? {})) {
    roles[role as Role] = { ...roles[role as Role], ...defined(set) };
  }
  return {
    budgets: {
      default: { ...d.budgets.default, ...defined(k.budgets?.default) },
      roles,
      providers: { ...d.budgets.providers, ...defined(k.budgets?.providers) },
    },
    hardMaxTokens: k.hardMaxTokens ?? d.hardMaxTokens,
    freshness: {
      defaultDays: k.freshness?.defaultDays ?? d.freshness.defaultDays,
      byEntityKind: { ...d.freshness.byEntityKind, ...defined(k.freshness?.byEntityKind) },
    },
    extraction: { ...d.extraction, ...defined(k.extraction) },
    captions: { ...d.captions, ...defined(k.captions) },
    dedupe: { ...d.dedupe, ...defined(k.dedupe) },
    retention: { ...d.retention, ...defined(k.retention) },
    ocr: { ...d.ocr, ...defined(k.ocr) },
  };
}
