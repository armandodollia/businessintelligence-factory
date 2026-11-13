/**
 * KS-8 measurements (recorded in docs/superpowers/verify-log.md). Usage:
 *
 *   npx tsx scripts/measure-knowledge.ts [prompts|search|all] [--chunks 10000] [--queries 40] [--repeat 5]
 *
 * - `prompts`: prompt tokens (estimate: characters / 4) of the orchestrator (deep dives and synthesis,
 *   round 1) and of the synthesizer's work prompt on a seeded four-node tree with 100 and 1 000 findings
 *   (one in five unverified), after `backfillKnowledge`. Same method as the KS-5 measurement.
 * - `search`: `search` latency through `knowledgeRead` (the tool path: scope, budget, envelope and the
 *   `retrieval_events` row) over a store of at least `--chunks` passages, ingested through the real
 *   extract → chunk → FTS path, for node scope and tree scope; p50 / p95 over `--queries` queries ×
 *   `--repeat` runs (after one warm-up pass). Also the store's size on disk.
 *
 * Everything runs on a temporary data dir that is removed afterwards (`BIF_MEASURE_KEEP=1` keeps it).
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config/schema.js';
import { ArtifactStore } from '../src/core/evidence/artifacts.js';
import { backfillKnowledge } from '../src/core/knowledge/backfill.js';
import { ingestArtifact } from '../src/core/knowledge/ingest.js';
import { knowledgeRead } from '../src/core/knowledge/tools.js';
import { orchestratorPrompt } from '../src/core/research/orchestrator.js';
import { workPrompt } from '../src/core/research/reviewLoop.js';
import { openStore, type Store } from '../src/core/store/db.js';
import { newId } from '../src/core/store/repos.js';
import type { Phase, ResearchRun } from '../src/core/types.js';

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'all';
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const est = (s: string) => Math.ceil(s.length / 4);
const keep = process.env.BIF_MEASURE_KEEP === '1';

function seededTree(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = openStore(join(dir, 'bif.db'));
  const config = structuredClone(defaultConfig);
  config.dataDir = dir;
  const ws = (id: string, name: string, parent?: string, level = 'company') =>
    store.workspaces.insert({
      id, name, sector: 'saas', createdAt: '2026-11-01T00:00:00Z', scope: { level, name, description: '' } as never,
      ...(parent ? { parentWorkspaceId: parent } : {}),
    });
  ws('ws_co', 'Acme');
  ws('ws_pay', 'Payments', 'ws_co', 'division');
  ws('ws_lend', 'Lending', 'ws_co', 'division');
  ws('ws_cards', 'Cards', 'ws_pay', 'slice');
  return { dir, store, config, nodes: ['ws_co', 'ws_pay', 'ws_lend', 'ws_cards'] };
}

const SUBJECTS = ['Rival', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Acme', 'Vandelay', 'Stark', 'Wayne', 'Wonka'];

function done(dir: string, store: Store) {
  store.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
  else console.error(`kept ${dir}`);
}

// ---------------------------------------------------------------------------
// prompt tokens (KS-5 method)

function measurePrompts(n: number) {
  const { dir, store, config, nodes } = seededTree('bif-measure-prompts-');
  for (let i = 0; i < n; i++) {
    const s = SUBJECTS[i % 10]!;
    store.findings.insert({
      id: newId('fnd'), workspaceId: nodes[i % 4]!, runId: 'rrun_seed', taskId: 'tsk_seed', subject: s,
      claim: `${s} observation number ${i}: pricing tier ${i % 7} costs $${10 + (i % 40)} per seat per month and onboarding takes ${i % 9} steps`,
      criteria: { relevance: 4 }, evidence: [], status: i % 5 === 0 ? 'unverified' : 'verified', createdAt: '2026-10-01T00:00:00Z',
    });
  }
  backfillKnowledge(store);
  const rr = (phase: Phase): ResearchRun => ({ id: 'rrun_m', workspaceId: 'ws_pay', phase, status: 'running', startedAt: '2026-11-13T00:00:00Z' });
  const orchestratorDeepDives = est(orchestratorPrompt(store, config, rr('deep_dives'), 1));
  const orchestratorSynthesis = est(orchestratorPrompt(store, config, rr('synthesis'), 1));
  const task = store.tasks.insert({
    id: newId('tsk'), workspaceId: 'ws_pay', runId: 'rrun_m', phase: 'synthesis', type: 'synthesize_recommendations', brief: 'Synthesize recommendations',
    model: { provider: 'claude', model: 'opus' }, needsBrowser: false, acceptanceCriteria: ['x'], status: 'queued', round: 1, createdAt: '2026-11-13T00:00:00Z',
  });
  const synthesizer = est(workPrompt({ store, config }, task));
  done(dir, store);
  return { findings: n, orchestratorDeepDives, orchestratorSynthesis, synthesizer };
}

// ---------------------------------------------------------------------------
// search latency at N chunks

const VOCAB = (
  'pricing plan seat monthly annual discount enterprise onboarding checkout signup trial renewal churn invoice payment card ' +
  'lending loan rate approval fraud dispute chargeback merchant settlement payout compliance audit report filing revenue margin ' +
  'growth customer segment persona review complaint support latency outage release roadmap feature integration api partner ' +
  'market share competitor launch acquisition funding headcount hiring office region europe america asia regulation licence'
).split(' ');

/** Deterministic pseudo-random text (xorshift) so runs are comparable. */
function textGen(seed: number) {
  let x = seed || 1;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
  const word = () => VOCAB[Math.floor(rnd() * VOCAB.length)]!;
  return (sentences: number, subject: string) =>
    Array.from({ length: sentences }, () => `${subject} ${Array.from({ length: 12 + Math.floor(rnd() * 10) }, word).join(' ')}.`).join(' ');
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function dirBytes(path: string): number {
  let n = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}

async function measureSearch(targetChunks: number, queries: number, repeat: number) {
  const { dir, store, config, nodes } = seededTree('bif-measure-search-');
  const artifacts = new ArtifactStore(store, join(dir, 'data'));
  const gen = textGen(42);
  // ~35 chunks per document at the default 400-token chunks (sections of ~4 paragraphs under headings).
  let docs = 0;
  const t0 = performance.now();
  while ((store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n < targetChunks) {
    const s = SUBJECTS[docs % 10]!;
    const sections = Array.from({ length: 35 }, (_, k) => `# ${s} section ${k}\n\n${gen(26, s)}\n\n${gen(26, s)}`).join('\n\n');
    const a = artifacts.save({ workspaceId: nodes[docs % 4]!, kind: 'text', mime: 'text/markdown', bytes: sections, title: `${s} report ${docs}` } as Parameters<ArtifactStore['save']>[0]);
    const summary = await ingestArtifact({ store, artifacts, config }, a.id);
    if (summary.status === 'failed') throw new Error(`ingest failed: ${JSON.stringify(summary)}`);
    docs++;
  }
  for (let i = 0; i < 1000; i++) {
    const s = SUBJECTS[i % 10]!;
    store.findings.insert({
      id: newId('fnd'), workspaceId: nodes[i % 4]!, runId: 'rrun_seed', taskId: 'tsk_seed', subject: s, claim: `${s} ${gen(1, s)}`,
      criteria: {}, evidence: [], status: 'verified', createdAt: '2026-10-01T00:00:00Z', lastConfirmedAt: '2026-10-01T00:00:00Z',
    });
  }
  backfillKnowledge(store);
  const seedMs = performance.now() - t0;
  const count = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n;
  const chunks = count('SELECT COUNT(*) AS n FROM chunks');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const dbBytes = statSync(join(dir, 'bif.db')).size;
  const totalBytes = dirBytes(dir);
  const textChars = count('SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM chunks');

  // Queries: one, two and three words, a phrase, and a no-hit query (the OR fallback), by subject.
  const qgen = textGen(7);
  const CLASSES = ['one word', 'subject + word', 'three words', 'phrase', 'no AND hit (OR fallback)'] as const;
  const qs = Array.from({ length: queries }, (_, i) => {
    const words = qgen(1, '').split(' ').filter(Boolean).map((w) => w.replace(/\W/g, ''));
    switch (i % 5) {
      case 0: return words[0]!;
      case 1: return `${SUBJECTS[i % 10]} ${words[0]}`;
      case 2: return words.slice(0, 3).join(' ');
      case 3: return `"${words[0]} ${words[1]}"`;
      default: return `${words[0]} zzyzx`;
    }
  });
  const call = (scope: 'node' | 'tree', query: string) => {
    const start = performance.now();
    const r = knowledgeRead({ store, config }, { workspaceId: 'ws_pay', role: 'worker', agentRunId: 'arun_measure', promptVersion: 'pv' }, 'search', { query, scope });
    const ms = performance.now() - start;
    if (!r.ok) throw new Error(r.error);
    return { ms, hits: ((r.data as { hits?: unknown[] }).hits ?? []).length };
  };
  const out: Record<string, { p50: number; p95: number; max: number; meanHits: number; n: number; byQuery: Record<string, number> }> = {};
  for (const scope of ['node', 'tree'] as const) {
    for (const q of qs) call(scope, q); // warm-up
    const ms: number[] = [];
    const byClass = new Map<string, number[]>();
    let hits = 0;
    for (let k = 0; k < repeat; k++) {
      qs.forEach((q, i) => {
        const r = call(scope, q);
        ms.push(r.ms);
        const cls = CLASSES[i % 5]!;
        byClass.set(cls, [...(byClass.get(cls) ?? []), r.ms]);
        hits += r.hits;
      });
    }
    const byQuery = Object.fromEntries([...byClass].map(([k, v]) => [`${k} p50`, r2(pct(v, 50))]));
    out[scope] = { p50: r2(pct(ms, 50)), p95: r2(pct(ms, 95)), max: r2(Math.max(...ms)), meanHits: r2(hits / ms.length), n: ms.length, byQuery };
  }
  done(dir, store);
  return {
    chunks, documents: docs, findings: 1000, textChars, seedSeconds: r2(seedMs / 1000),
    dbBytes, totalBytes, latencyMs: out, queries: qs.length, repeat,
  };
}

if (mode === 'prompts' || mode === 'all') {
  for (const n of [100, 1000]) console.log(JSON.stringify({ prompts: measurePrompts(n) }));
}
if (mode === 'search' || mode === 'all') {
  console.log(JSON.stringify({ search: await measureSearch(opt('chunks', 10_000), opt('queries', 40), opt('repeat', 5)) }));
}
