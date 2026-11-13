# Knowledge store — build plan

Design: `docs/superpowers/specs/2026-11-13-knowledge-store-design.md` (read it first;
section numbers below, "§", refer to it). Same working rules as
`2026-11-13-learning-loop-parity.md` ("Global rules"): TDD with vitest; `npm test`,
`npm run typecheck`, `npm run build:web` green per package; one branch and worktree
per package; append-only migrations; add code to hot shared files in new delimited
blocks; prefer new modules; update `README.md` and the main design spec where
behaviour changes.

Questions that would change a decision in design §3, a tool contract in §9 or a
privacy rule in §12 go to the design thread, not to a guess.

## Shape

```
KS-0 foundation ──┬─ KS-1 extraction ──┐
                  ├─ KS-2 living facts ─┼─ KS-4 retrieval tools ─┬─ KS-5 prompts + recurring
                  └─ KS-3 entities ─────┘                        ├─ KS-6 tracking integration
KS-1a extract lib (no deps, can start now)                       └─ KS-7 API + UI + gc
                                                                          └─ KS-8 integration, smoke, docs
```

- **KS-1a can start immediately**, in parallel with learning-loop wave 1: it adds
  only new files and dependencies.
- **KS-0 starts when learning-loop wave 1 (WP-A…D) is merged**, on top of the merged
  branch, because it edits the same hot files (`migrations.ts`, `repos.ts`,
  `types.ts`, `registry.ts`, `handlers.ts`, `config/schema.ts`).
- **Migration slot:** KS-0 owns exactly one migration, the next free slot after wave
  1 (18). Learning-loop wave 2 (WP-E/F/G) moves to 19–21. No other KS package adds a
  migration; if one finds a missing column it asks the orchestrator, who appends a
  single follow-up migration.
- KS-6 needs wave 1's `feedback_events`, `agent_usage`, `recordOutcome`,
  `policy_events`, `bus_events`. KS-0…5 do not.
- New code lives in `src/core/knowledge/` unless stated. `src/core` never imports
  api or web.

## KS-1a — Extraction library (pure, no store)

Files: `src/core/knowledge/extract/{index,html,pdf,office,text,normalize,chunk,urlKey}.ts`,
tests `test/core/knowledge/extract*.test.ts`, fixtures `test/fixtures/knowledge/`.

Contract:

```ts
export type ExtractStatus = 'ok' | 'empty' | 'unsupported' | 'too_large' | 'failed';
export type Block = { headingPath: string; locator?: string; text: string };
export type Extracted = { status: ExtractStatus; extractor: string; blocks: Block[]; error?: string };
export function extract(bytes: Uint8Array, mime: string, opts: ExtractOptions): Promise<Extracted>;
export type Chunk = { seq: number; headingPath: string; locator?: string; text: string;
                      charStart: number; charEnd: number; tokenEstimate: number };
export function chunk(blocks: Block[], opts: { chunkTokens: number; maxChunkTokens: number }): Chunk[];
export function normalizeText(s: string): string;          // §8.2 normalization
export function contentHash(blocks: Block[]): string;      // sha256 of normalized text
export function urlKey(url: string | undefined): string | undefined; // §8.1
export function estimateTokens(s: string): number;         // ceil(chars / 4)
```

Requirements: design §8.2–8.4. Pure JS dependencies pinned exactly; check current
version and licence on npm before pinning; no native binaries, no post-install
downloads, no network. Never execute or render input. A thrown parser error becomes
`status: 'failed'` with the message; it never propagates.

Tests: one fixture per type (html article, html app page with nav/footer, pdf with
text, pdf without text layer, docx with headings, pptx, xlsx with two sheets, csv,
md, json, png → unsupported/no text); hostile HTML (script/style content absent,
`display:none` text absent, zero-width and bidi characters stripped, entity-encoded
tags stay text); size caps; chunk sizes within bounds, offsets reconstruct the
text, deterministic output; `urlKey` cases.

## KS-0 — Foundation (serial; everything else builds on it)

1. **Migration** (one entry, comment `// <N>: knowledge store — ...`):

```sql
ALTER TABLE artifacts ADD COLUMN description TEXT;
ALTER TABLE artifacts ADD COLUMN url_key TEXT;
ALTER TABLE artifacts ADD COLUMN upload_derived INTEGER NOT NULL DEFAULT 0;
UPDATE artifacts SET upload_derived = 1 WHERE kind = 'upload';
CREATE INDEX artifacts_ws_urlkey ON artifacts (workspace_id, url_key);

CREATE TABLE artifact_captures (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_run_id TEXT, task_id TEXT, run_id TEXT,
  source_url TEXT, url_key TEXT, title TEXT, flow TEXT, step INTEGER, note TEXT,
  description TEXT, entity_id TEXT, captured_at TEXT NOT NULL
);
CREATE INDEX artifact_captures_art ON artifact_captures (artifact_id);
CREATE INDEX artifact_captures_url ON artifact_captures (workspace_id, url_key, captured_at);
CREATE INDEX artifact_captures_run ON artifact_captures (run_id);
INSERT INTO artifact_captures (id, artifact_id, workspace_id, source_url, title, flow, step, note, captured_at)
  SELECT 'cap_' || substr(id, 5), id, workspace_id, source_url, title, flow, step, note, captured_at FROM artifacts;

CREATE TABLE artifact_texts (
  artifact_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, status TEXT NOT NULL,
  extractor TEXT, error TEXT, char_count INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0, content_sha256 TEXT, duplicate_of TEXT,
  extracted_at TEXT
);
CREATE INDEX artifact_texts_hash ON artifact_texts (content_sha256);
INSERT INTO artifact_texts (artifact_id, workspace_id, status) SELECT id, workspace_id, 'pending' FROM artifacts;

CREATE TABLE chunks (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL, heading_path TEXT NOT NULL DEFAULT '', locator TEXT,
  text TEXT NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL, upload_derived INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX chunks_art_seq ON chunks (artifact_id, seq);

ALTER TABLE findings ADD COLUMN lineage_id TEXT;
ALTER TABLE findings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE findings ADD COLUMN replaces_id TEXT;
ALTER TABLE findings ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'current';
ALTER TABLE findings ADD COLUMN entity_id TEXT;
ALTER TABLE findings ADD COLUMN first_seen_at TEXT;
ALTER TABLE findings ADD COLUMN last_confirmed_at TEXT;
ALTER TABLE findings ADD COLUMN confirm_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN ttl_days INTEGER;
ALTER TABLE findings ADD COLUMN upload_derived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN lineage_conflict INTEGER NOT NULL DEFAULT 0;
UPDATE findings SET lineage_id = id, first_seen_at = created_at,
  last_confirmed_at = CASE WHEN status = 'verified' THEN created_at END;
CREATE INDEX findings_lineage ON findings (lineage_id);
CREATE INDEX findings_entity ON findings (entity_id, lifecycle);

CREATE TABLE finding_evidence (
  finding_id TEXT NOT NULL, seq INTEGER NOT NULL, artifact_id TEXT NOT NULL,
  chunk_id TEXT, quote TEXT, char_start INTEGER, char_end INTEGER,
  PRIMARY KEY (finding_id, seq)
);
CREATE INDEX finding_evidence_art ON finding_evidence (artifact_id);

CREATE TABLE fact_observations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, lineage_id TEXT NOT NULL,
  finding_id TEXT NOT NULL, prior_finding_id TEXT, kind TEXT NOT NULL,
  run_id TEXT, task_id TEXT, agent_run_id TEXT, task_round INTEGER,
  evidence TEXT NOT NULL DEFAULT '[]', reason TEXT, status TEXT NOT NULL,
  created_at TEXT NOT NULL, applied_at TEXT
);
CREATE INDEX fact_observations_task ON fact_observations (task_id);
CREATE INDEX fact_observations_lineage ON fact_observations (lineage_id);
CREATE INDEX fact_observations_run ON fact_observations (run_id);

CREATE TABLE item_scopes (
  item_kind TEXT NOT NULL, item_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'home',
  PRIMARY KEY (item_kind, item_id, workspace_id)
);
CREATE INDEX item_scopes_ws ON item_scopes (workspace_id, item_kind);
INSERT INTO item_scopes (item_kind, item_id, workspace_id) SELECT 'fact', id, workspace_id FROM findings;
INSERT INTO item_scopes (item_kind, item_id, workspace_id) SELECT 'artifact', id, workspace_id FROM artifacts;

CREATE TABLE entities (
  id TEXT PRIMARY KEY, root_workspace_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]', merged_into_id TEXT,
  created_by_run TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX entities_root_kind_key ON entities (root_workspace_id, kind, name_key);
ALTER TABLE competitors ADD COLUMN entity_id TEXT;
ALTER TABLE personas ADD COLUMN entity_id TEXT;
ALTER TABLE symptoms ADD COLUMN entity_id TEXT;
ALTER TABLE symptom_hypotheses ADD COLUMN entity_id TEXT;

CREATE TABLE relations (
  id TEXT PRIMARY KEY, root_workspace_id TEXT NOT NULL,
  from_entity_id TEXT NOT NULL, type TEXT NOT NULL, to_entity_id TEXT NOT NULL,
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX relations_uniq ON relations (from_entity_id, type, to_entity_id, source_kind, source_id);
CREATE INDEX relations_to ON relations (to_entity_id, type);

CREATE TABLE entity_merge_suggestions (
  id TEXT PRIMARY KEY, root_workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL, score REAL NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, decided_at TEXT, actor TEXT
);

CREATE TABLE retrieval_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root_workspace_id TEXT NOT NULL,
  agent_run_id TEXT, task_id TEXT, role TEXT NOT NULL, provider TEXT, model TEXT,
  prompt_version TEXT, tool TEXT NOT NULL, query TEXT NOT NULL, scope TEXT NOT NULL,
  result_ids TEXT NOT NULL, result_count INTEGER NOT NULL, tokens_returned INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0, relaxed INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL, upload_derived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX retrieval_events_run ON retrieval_events (agent_run_id);
CREATE INDEX retrieval_events_ws ON retrieval_events (workspace_id, created_at);

CREATE TABLE retrieval_uses (
  retrieval_event_id TEXT NOT NULL, item_id TEXT NOT NULL,
  used_by_kind TEXT NOT NULL, used_by_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (retrieval_event_id, item_id, used_by_id)
);

CREATE VIRTUAL TABLE findings_fts USING fts5(subject, claim, content='findings', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE chunks_fts USING fts5(heading_path, text, content='chunks', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE artifacts_fts USING fts5(title, description, note, source_url, flow, content='artifacts',
  content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE entities_fts USING fts5(name, aliases, content='entities', content_rowid='rowid', tokenize='trigram');
-- plus AFTER INSERT / DELETE / UPDATE triggers for each (standard external-content pattern),
-- and: INSERT INTO findings_fts(findings_fts) VALUES('rebuild'); same for artifacts_fts.
```

   Verify the DDL against the schema as it stands after wave 1 (column names may
   have moved); the list of tables and columns is the contract, the SQL is a draft.
   Migration test: applies on a database at the previous version with rows present;
   backfills are correct; FTS finds an existing finding.

2. **Types and repos** (`types.ts`, `repos.ts`, new delimited blocks): types for
   every new table; `Finding`, `Artifact`, `Competitor`, `Persona`, `Symptom`,
   `SymptomHypothesis` gain the new optional fields; repos with the existing
   `insert / get / list / update` conventions.

3. **`src/core/knowledge/scope.ts`** — design §7.1:

```ts
export type KnowledgeScope = { workspaceId: string; rootId: string; treeIds: string[]; nodeIds: string[] };
export function scopeFor(store: Store, workspaceId: string): KnowledgeScope;
export function activeIds(s: KnowledgeScope, mode: 'node' | 'tree'): string[];
export function narrowTo(store: Store, s: KnowledgeScope, workspaceId: string): KnowledgeScope | undefined; // undefined if not in tree
export function scopeRank(s: KnowledgeScope, itemWorkspaceId: string): 0 | 1 | 2 | 3; // own, descendant, ancestor, rest
export function setItemScopes(store, kind, id, workspaceIds: string[], source: 'home' | 'agent' | 'user'): void;
```

4. **`src/core/knowledge/budget.ts`** — `estimateTokens` (re-export),
   `budgetFor(config, role, provider, kind)`, `fitToBudget(items, render, budget)`
   returning `{ items, truncated, more }`, and a cursor encoder/decoder.

5. **`src/core/knowledge/trust.ts`** — `fenceEvidence(artifactId, text)` (removes
   fence sequences from the text), `redactServed(store, workspaceId, value)`.

6. **`src/core/knowledge/retrievalLog.ts`** — `recordRetrieval(deps, ctx, entry)`
   (writes the row, emits a `retrieval` bus event with the id) and
   `runIsUploadExposed(store, agentRunId)`.

7. **Config** — `knowledge` block in `config/schema.ts` with defaults (design §16);
   existing config files and tests keep passing unchanged.

8. **Backfill** — `src/core/knowledge/backfill.ts`, idempotent, run at startup:
   entities from competitors / personas / symptoms / distinct finding subjects
   (uses the existing `titleKey`), `upload_derived` on findings via the existing
   evidence expansion, `url_key` on artifacts and captures.

Tests: migration; scope sets and ranks on a three-level tree plus a second tree;
budget fitting and cursors; fence and redaction; config defaults; backfill twice =
same result.

## KS-1 — Extraction pipeline (after KS-0 and KS-1a)

Files: `src/core/knowledge/ingest.ts`, edits in `evidence/artifacts.ts`,
`harness/tools/{registry,handlers}.ts` (`save_artifact`, new `describe_artifact`),
`internal/uploads.ts`.

- `ArtifactStore.save*` always writes a capture row (new optional meta:
  `agentRunId`, `taskId`, `runId`, `description`, `entityId`) and sets
  `description` / `url_key` on first save; a later save fills an empty description
  but never overwrites one.
- `save_artifact`: `description` required for image artifacts from agents (config
  `captions`); new `entity`, `applies_to` (validated in tree); returns
  `{ artifactId, sha256, captureId, extraction }`.
- `describe_artifact` (worker, orchestrator, interviewer, synthesizer): only when the
  artifact has no description or the caller's run saved it; tree-checked; a
  description of an upload-derived artifact is upload-derived.
- Ingest: `ingestArtifact(id)` → extract → `artifact_texts` → duplicate check by
  `content_sha256` within the tree (`duplicate_of`, no chunks) → insert chunks
  (with `upload_derived`) in one transaction. Inline when
  `bytes ≤ extraction.inlineMaxBytes`, else queued (in-process, concurrency from
  config); `pending` rows re-queued at startup; failures recorded, never thrown to
  the tool caller.
- Uploads go through the same path.

Tests: capture per save including identical bytes with different flow/step; caption
rule (rejected without, accepted with; uploads exempt); duplicate text → no second
chunk set and `expand` resolves to canonical (assert at repo level); queue
restart; failure isolation; `artifacts_fts` finds a screenshot by its description.

## KS-2 — Living facts (after KS-0)

Files: `src/core/knowledge/facts.ts`, edits in `harness/tools/{registry,handlers}.ts`
(`save_finding`, new `confirm_finding`, `retract_finding`), `research/outputs.ts`
(`applyTaskStatus`), `research/reviewLoop.ts` (review context), `evidence/synthesis.ts`
(`isSynthesisEligible` must also require lifecycle `current`).

- `save_finding` new inputs (design §9) and the duplicate handshake (§7.2):
  `findCandidates(scope, entityId, claim)` uses `findings_fts` restricted to
  `treeIds`, lifecycle `current`; config `dedupe`. Existing same-(task, claim)
  idempotency stays first.
- Lineage: `replaces` → new row with prior's `lineage_id`, `version + 1`, lifecycle
  `candidate`, `replaces_id`; observation `replace` pending.
- `confirm_finding` / `retract_finding`: need a task; fact must be in the caller's
  tree and lifecycle `current`; evidence ≥ 1 artifact captured by this task;
  idempotent per (task, fact, kind); record a Decision (kind `score`-like judgment,
  refs = fact + evidence).
- `applyObservations(store, task, outcome)` called inside `applyTaskStatus`
  (design §7.2 rules, including not-resubmitted observations and lineage
  conflict). `applyReplacementByUser(store, findingId, actor)` for the include
  override path.
- `applies_to` → `setItemScopes(…, 'agent')`; logged as a Decision when it differs
  from home.
- `upload_derived`: computed at save from evidence and confirmations; sticky along
  the lineage.
- `evidence_refs`: stored; quote verification against chunk / artifact text
  (normalized substring). If the artifact's extraction is still `pending`, run it
  inline first; if there is no text (image, unsupported), a quote is rejected with
  "artifact has no extracted text; cite without a quote".
- Freshness helper `freshness(fact, config, now)` → `{ ageDays, ttlDays, stale }`.
- Review context: outputs section shows relation and the prior claim; evidence ids
  include confirmation evidence; quotes listed (budgeted).

Tests: design §18 "Lifecycle" list; handshake (auto-confirm on exact match,
candidates returned and nothing saved, explicit `new` saves, candidates never from
another tree, upload-derived candidates flagged); quote accepted / rejected;
synthesis excludes `candidate`, `replaced`, `retracted`; existing finding tests
still pass.

## KS-3 — Entities and relations (after KS-0)

Files: `src/core/knowledge/{entities,relations}.ts`, small edits in
`market/competitors.ts`, `market/personas.ts`, `interview/interview.ts` /
`interview/hypotheses.ts` (resolve entity on save), handlers for `save_finding` /
`save_artifact` call a single `resolveEntity`.

```ts
export type EntityKind = 'company' | 'competitor' | 'product' | 'feature' | 'flow' | 'persona'
  | 'segment' | 'pain_point' | 'symptom' | 'cause' | 'topic';
export type EntityRef = { id: string } | { kind: EntityKind; name: string };
export function resolveEntity(store, scope: KnowledgeScope, ref: EntityRef, ctx): Entity;   // exact key or alias, else create + suggestions
export function mergeEntities(store, survivorId, loserId, actor): void;                      // same tree only
export function addRelation(store, scope, edge): Relation;                                    // idempotent
export function neighbours(store, scope, entityId, opts: { types?, depth: 1 | 2, usableOnly: boolean }): Edge[];
export const RELATION_TYPES: readonly string[];
```

- `save_finding` without `entity` resolves `{ kind: 'topic' | inferred, name: subject }`:
  if a competitor / persona / company entity with that name key exists in the tree,
  use it; else create kind `topic`. Document the rule in the tool description.
- Each node gets a `company` entity for its own scope name on first use.
- Automatic edges (design §7.4). An edge is live only if its source record is
  usable; `neighbours(usableOnly)` enforces it with a join, no stored flag.
- Merge suggestions: trigram match on `entities_fts` within the tree and kind,
  score ≥ floor, not already suggested.

Tests: same name in two trees → two entities; alias match; near-match creates a
suggestion and never blocks; merge re-points facts, relations and typed records
and keeps the alias; edges disappear from `neighbours` when their source fact is
replaced; 2-hop traversal; cross-tree ids rejected.

## KS-4 — Retrieval tools (after KS-1, KS-2, KS-3)

Files: `src/core/knowledge/{search,cards,expand,changes,tools}.ts`, registry and
role table edits, dispatcher hook for logging and the reviewer slice.

- `search` (design §9): one function per kind over its FTS table joined to
  `item_scopes` (or `workspace_id` for records) with `activeIds`; query builder
  (tokens quoted, AND, OR fallback, phrases); collapse by sha256 / content hash;
  flags; `fitToBudget`. Empty query + `entity_id` = recency browse.
  `kinds: ['record']` covers competitors, personas, symptoms, hypotheses,
  recommendations (LIKE on their short text is acceptable in v1; say so in a
  comment).
- `get_card`, node and entity cards (design §10).
- `expand` by id prefix; `read_artifact` modes with cursor paging; old default
  behaviour is replaced (update its tests).
- `list_changes`.
- Role table (design §9). Reviewer slice: `reviewSlice(store, task)` = ids from
  `reviewContext` + chunks of those artifacts + prior facts; dispatcher rejects
  other ids with the same "not found" text and emits a `policy_blocked` bus event
  (KS-6 persists it once `policy_events` exists).
- Synthesizer and interviewer: `include_unverified` / `include_history` ignored
  with a note in the response.
- Every read tool: latency measured, `recordRetrieval` called, response carries
  `tokens`, `truncated`, `cursor`, `content_trust`.
- `read_workspace` returns the node card and counts.

Tests: design §18 "Isolation", "Scope", "Budgets", "Reviewer slice"; ranking is
deterministic; relaxed fallback; hostile evidence text stays fenced; a retrieval
row per call with the right ids and token count.

## KS-5 — Prompts and recurring runs (after KS-4)

Files: `research/orchestrator.ts` (context sections), `workspace/businessMap.ts`
(`treeContext`), `evidence/synthesis.ts` (`synthesisFindingsSection`),
`research/reviewLoop.ts` (prompts), `prompts/*.md`, `scheduler/{diff,whatChanged}.ts`,
new `src/core/knowledge/briefing.ts`.

- `briefing(store, config, role, provider, workspaceId, opts)` builds the sections
  in design §11 within the briefing budget and records a `prompt_context`
  retrieval event (so upload exposure and token accounting cover prompts).
- "Due for re-check": facts stale or reaching TTL before the schedule's next run
  (use the schedule's cron; manual runs: stale only), grouped by entity, capped.
- Orchestrator prompt: tasks in a recurring run should name the facts to re-check.
  `propose_tasks` accepts optional `recheck_fact_ids` per task (validated in tree);
  they are shown in the worker's prompt with their claims.
- Role prompts: add the "knowledge store" section (design §11). Prompt versions
  change; nothing else needed.
- `whatChanged` from applied observations; keep screenshot diff; text-match
  fallback only for `new` facts. Payload stays backward compatible for the UI, with
  added `replaced: [{ from, to }]`, `retracted`, `confirmed` (count).

Tests: prompt size stays under budget with 1 000 findings in the tree (it grows
without bound today — assert the bound); recurring scenario from design §18;
existing orchestrator / synthesis / scheduler tests updated, not deleted.

## KS-6 — Tracking integration (after KS-4 and learning-loop wave 1)

Files: `src/core/knowledge/{uses,outcomes,metrics}.ts`, `scoring/export.ts`, hooks.

- `retrieval_uses`: on every save that cites ids (findings, recommendations,
  personas, competitors, hypotheses, observations), mark the cited ids previously
  returned to the same run.
- `recordOutcome` (WP-C) calls for lineage events (design §13 table), including the
  lazy `stale` outcome the first time a fact is observed past TTL by
  `list_changes` or the briefing.
- `feedback_events` (WP-A) for the human actions listed in design §13; actor from
  `config.user.id`. Review queue re-queue on new fact version.
- `policy_events` (WP-D) for blocked reads; persist the `retrieval` and
  `policy_blocked` bus events through WP-D's `bus_events` (no second copy of the
  retrieval payload).
- Export: lines for retrieval events and fact observations; default exclusion of
  upload-derived lines and of judgments from upload-exposed runs
  (`runIsUploadExposed`), overridable by the existing `includeUploads`.
- Reports: `knowledgeMetrics(store, filter)` → store size, freshness, retrieval hit
  rate, zero-result rate, retrieved and used tokens per run grouped by role / task
  type / prompt version / model; joined with `agent_usage` (WP-B) for the share of
  input tokens that was retrieved knowledge. Expose to WP-G's metrics view and to
  WP-E as signals (zero-result, unused tokens, duplicate-saved, missing caption,
  rejected quote).

Tests: use linkage; each outcome label written once; export exclusion (a run that
only *read* an upload and cited nothing is excluded by default); metrics on a
seeded store; flag-versus-expansion agreement test (design §18 "Provenance").

## KS-7 — API, web view, gc (after KS-4; parallel with KS-5/6)

Files: `src/api/routes.ts` (new block), `web/src/logic/*`, `web/src/views/*`,
`src/core/knowledge/gc.ts`.

- Routes and view from design §17. Human actions call the same core functions as
  KS-2/3 and (once KS-6 lands) write feedback events; until then they record a
  system decision.
- `gcReport` and `prune` (design §14). Prune refuses anything referenced; test that
  an artifact cited only by a `replaced` fact version is still refused.
- Web rules: no fetch in views; stored HTML is never rendered; evidence text is
  shown as text.

Tests: route tests for scope toggle and isolation; view tests in the existing
style; gc refusal cases.

## KS-8 — Integration, smoke, docs (last)

- End-to-end with the fake adapter: interview → research → second scheduled run →
  confirm / replace / retract → what changed → synthesis uses only current usable
  facts → export respects upload exposure.
- `scripts/smoke.ts`: per provider (claude, codex; opencode if it runs) a worker
  that saves a page, searches for it, expands a chunk and saves a finding with a
  verified quote. Record results in `docs/smoke-results.md`.
- Measure and record in `docs/superpowers/verify-log.md`: prompt tokens before /
  after for orchestrator and synthesizer on a seeded tree; search latency at
  10 000 chunks.
- Update `README.md` and the main design spec (§6.2 tools, §7.3 evidence rule,
  §11 scheduler, data model).

## Review gates

After KS-0, after KS-4 and after KS-8, an independent review (different provider
than the builder where available) against the design's §12 privacy rules and §18
suites. Blocking findings are fixed before the next wave starts.

## KS-1a builder notes

Smaller decisions taken while building KS-1a (none changes §3, §9 or §12).

- **Dependencies** (exact pins, pure JS, no install scripts): `parse5` 8.1.1 (MIT,
  HTML), `saxes` 6.0.0 (ISC, strict XML, no DTD/entity resolution), `fflate` 0.8.3
  (MIT, zip), `unpdf` 2.1.0 (MIT; bundles pdf.js 6, Apache-2.0, which contains no
  `eval`/`new Function`). `parse5` and `saxes` were already in the tree via `jsdom`.
- **Extra files:** `extract/types.ts` (contract types, defaults, `ExtractTooLargeError`)
  and `extract/sections.ts` (heading-path builder shared by html/docx).
- **`ExtractOptions`** = `maxTextChars`, `xlsxMaxRows`, plus optional `csvMaxRows`
  (default `xlsxMaxRows`; §16 has no csv key), `maxInputBytes` (default 50 MB, the
  artifact store limit), `maxUnzippedBytes` (default 200 MB, declared size of the
  zip parts read; zip-bomb guard), `filename` (type fallback when the mime is
  generic, e.g. uploads with `application/octet-stream`; bytes are sniffed first).
- **`too_large`:** input over `maxInputBytes` or zip parts over `maxUnzippedBytes` →
  no blocks. Text over `maxTextChars` → `too_large` **with the blocks cut at the cap**
  and a message in `error`, so KS-1 can still index the start of a huge document.
- **Chunk offsets** index `blocksText(blocks)` (block texts joined by `\n\n`). Chunks
  never span blocks, have trimmed edges, and only whitespace lies between them.
- **`contentHash`** = sha256 over the normalized heading path and text of each
  non-empty block; locators are ignored.
- **`normalizeText`** also strips C0/C1 controls, soft hyphen and Unicode tag
  characters (U+E0000–E007F), applies NFC, and keeps single newlines and at most one
  blank line (paragraph structure is needed for chunking).
- **`estimateTokens`** counts UTF-16 units.
- **`urlKey`:** only http(s) URLs get a key (others and unparseable → `undefined`);
  credentials and default ports dropped; scheme, path case and the order of
  remaining query parameters kept; tracking names matched case-insensitively.
- **Locators:** `page N`, `slide N`, `sheet N` (the sheet name is the heading path),
  `#id` for an HTML heading with an id. Heading path separator: ` > `.
- **HTML:** `header` dropped at page level but kept inside `article`/`main`/`section`
  (article titles live there); `footer`, `nav`, `aside`, roles `navigation`/
  `banner`/`contentinfo`/`complementary`, closed `<dialog>`, form fields and
  `<title>` dropped; button text kept. Hiding through stylesheet classes is not
  detected (no CSS engine). Pathological nesting (≈10 000 levels) → `failed`.
- **docx:** headings from style ids or `styles.xml` names (`Title` above `heading 1`,
  `outlineLvl`); hidden (`w:vanish`) runs, tracked deletions and field codes skipped;
  headers, footers, footnotes and comments not extracted.
- **pptx:** slide title is the heading path and also the first line of the slide
  text, so title-only slides stay searchable; speaker notes not extracted.
- **xlsx:** cached cell values (formulas not evaluated; dates stay serial numbers),
  rows as `| a | b |`, empty rows skipped, columns past 1 024 ignored, hidden sheets
  included. csv and xlsx cuts end with `[truncated: first N of M rows]`.
- **PDF:** no CMap files are loaded, so some CJK PDFs extract poorly; pdf.js runs on
  the main thread with no timeout, so KS-1 should keep large PDFs on the queue.
- **For KS-1/KS-0:** extraction does not redact identity secrets or remove fence
  sequences (that is `trust.ts` / ingest); `error` is one line ≤ 300 chars but may
  quote a fragment of the input, so treat it like the artifact's text (same tree,
  upload-derived for uploads).

## KS-0 builder notes

Smaller decisions taken while building KS-0 (none changes §3, §9 or §12).

- **Migration 18** follows the plan's table and column list exactly. Additions beyond the draft:
  index `artifact_texts_status`, index `entity_merge_suggestions_root (root, status)`, FTS
  update triggers limited to the indexed columns (`AFTER UPDATE OF subject, claim`, …), legacy
  capture ids `cap_<artifact id without 'art_'>` (`cap_<id>` for other prefixes), and these
  triggers:
  - `retrieval_events` refuses UPDATE / DELETE (append-only, §13).
  - Every new finding gets `lineage_id = id` and `first_seen_at = created_at` when not given, and a
    `home` row in `item_scopes`; every new artifact gets a `home` scope row and an
    `artifact_texts` row with status `pending`. So rows from any code path satisfy the invariants;
    KS-1 updates (not inserts) the text row, KS-2 replaces the scope rows for `applies_to`.
  - `upload_derived` (§12) is maintained in SQL and is sticky (an update from 1 to 0 aborts);
    `upload_cause` (artifacts, findings) keeps the first reason — the seam for KS-2's "why" ruling:
    `kind:upload`, `profile:<ws>`, `duplicate_of:<artifact>` (artifacts); `evidence:<artifact>`,
    `finding_evidence:<artifact>`, `observation:<observation>`, `lineage:<earlier version>`
    (findings). When an artifact is flagged (at any time, including late: a profile later lists it
    as an upload), the cascade flags its text duplicates, then re-applies the general rules for
    every flagged artifact (chunks; findings citing one through `evidence`, `finding_evidence` or
    a `fact_observations` row of any kind, rejected ones included), and lineage versions after a
    flagged one follow. Insert / update triggers on `findings.evidence`, `finding_evidence`,
    `fact_observations.evidence` and `artifact_texts.duplicate_of` cover the other ordering. The
    startup backfill runs the same rules (`UPLOAD_PROPAGATION`), so a store written without one of
    them is repaired at the next start.
  - **Sweep of evidence-bearing places** (gate review): covered by triggers + backfill:
    `findings.evidence`, `finding_evidence`, `fact_observations.evidence` (confirm, replace,
    retract), the artifact's chunks, artifacts whose text is `duplicate_of` a flagged artifact (one
    level: KS-1 always points at the canonical). Ruled out of materialization (no flag column):
    `competitors.evidence`, `symptoms.evidence`, `symptom_hypotheses.evidence` (findings or
    artifacts), persona profile field evidence, `unit_proposals.evidence`,
    `recommendations.finding_ids` — they are resolved at check time from the current flags by
    `itemIsUploadDerived` (`knowledge/provenance.ts`), and at export time by the export's expansion.
    **KS-6:** the export's `evidenceOf` reads `findings.evidence` only, so a finding flagged
    through an observation (or a record citing such a finding) is not yet excluded by the export;
    KS-6 must make the export use the materialized finding flag (or `itemIsUploadDerived`).
    Entity names derived from an upload-derived record are KS-3's to flag.
  - `runIsUploadExposed` no longer trusts the stored row flag alone: `retrieval_events` is
    append-only, so it also re-resolves every returned id with `itemIsUploadDerived` at check
    time. KS-4 / KS-5 must therefore list in `results` every item whose text a response carried
    (card lines included).
  - Never VACUUM without an FTS `rebuild` afterwards (VACUUM may renumber rowids). BIF never VACUUMs today.
- **Repositories** for the new tables live in a delimited block at the end of `repos.ts` as
  `knowledgeRepos(store)` (memoized per connection, like `usageRepos` / `learningRepos`), not in
  `createRepos`, so `Store` and its hot block are untouched. Composite-key tables
  (`finding_evidence`, `item_scopes`, `retrieval_uses`) use `LinkRepo` (insert, insertIgnore, list,
  delete by filter; no get / update). The chunk row type is `TextChunk` (KS-1a owns `Chunk`).
- **Types:** `EntityKind` / `ENTITY_KINDS` live in `config/schema.ts` (the config validates
  `freshness.byEntityKind`) and are re-exported by `types.ts`, like `Role`. `RelationType` and
  `RelationSourceKind` are unions in `types.ts`; KS-3 owns the runtime `RELATION_TYPES` list and
  should type it `readonly RelationType[]`. `RetrievalRole = Role | 'user'` (API reads, §17).
  `RetrievalEvent.scope` is text: `node`, `tree` or `node:<workspaceId>` when narrowed.
- **Scope:** `KnowledgeScope` gains `ancestorIds` (nearest first) so `scopeRank` can tell
  descendants from ancestors. `nodeIds` order: self, descendants (breadth-first), ancestors.
  `narrowTo` to a sibling is allowed (same tree) and returns that node's own view. Unknown and
  out-of-tree ids both raise `KnowledgeNotFoundError` (`notFound(kind, id)`: "<kind> '<id>' not
  found"). `setItemScopes` checks every node against the item's own tree and replaces all rows in
  one transaction.
- **Budgets:** budget kinds are `search`, `card`, `expand`, `briefing`; KS-4 uses `expand` for
  `read_artifact` and `search` for `list_changes`. `budgetFor(config, role, provider, kind,
  requested?)`: role value else default, times the provider scale (floor), capped by
  `hardMaxTokens`, lowered (never raised) by `requested`, at least 1. `fitToBudget` counts each
  item as `estimateTokens(render(item) + '\n')`, adds an optional envelope `overhead`, returns
  `{ items, tokens, truncated, more }` and only ever a prefix; an item bigger than the budget is
  not returned — cut it with `truncateToTokens` first. Cursors: `cursorKey(params)` (sha256 of the
  canonical JSON, 16 hex), `encodeCursor` / `decodeCursor` (base64url `{v,k,o}`; wrong request or
  malformed → `InvalidCursorError`), `fitPage` for paging.
- **Trust:** `stripFences` removes invisible format characters and every run of ≥ 3 angle
  brackets, including fullwidth / small-form lookalikes, repeating until none remains (so removal
  cannot create a new run). The fence label keeps only `[A-Za-z0-9_-]`. `redactServed` redacts the
  identity secrets of every node of the caller's tree (text served to a node may come from any
  node of its tree).
- **Retrieval log:** queries are redacted with `redactServed` and capped at 2 000 chars; the bus
  event is `{ type: 'retrieval', workspaceId, retrievalEventId, agentRunId?, taskId? }`. It is
  not yet persisted to `bus_events` (KS-6). `runIsUploadExposed` reads only `retrieval_events`
  (stored flag, then current flags of the returned ids), so today's unlogged `read_artifact` calls
  are not covered until KS-4 logs them.
- **Config defaults not fixed by the design:** `dedupe.similarityFloor` 0.5 on a 0–1 scale (KS-2
  defines the measure), `retention.pruneMinAgeDays` 90, `budgets.providers` empty (scale 1),
  `freshness.byEntityKind` empty. `chunkTokens > maxChunkTokens` is a config error.
- **Backfill** (`knowledge/backfill.ts`, called in `createRuntime` right after `openStore`):
  incremental instead of flag-guarded — each step touches only rows still missing what it adds, so
  rows saved by pre-KS-1/2/3 code paths are completed at the next start and user edits are never
  undone. Entities: competitor → `competitor` (name), persona → `persona` (named by `segment`),
  symptom → `symptom`, strength → `topic` (no strength kind), finding subject → existing
  `competitor` / `persona` / `company` entity with that key or alias in the tree (survivor of a
  merge), else a `company` entity when the subject is a node's scope name (created on this first
  use, home = that node), else `topic`; all versions of a lineage share the entity. Hypotheses are
  left to KS-3 (their text is a sentence, not a name). Also sets `last_confirmed_at = created_at`
  for verified findings never confirmed (same rule as the migration).
- **Upload authority:** `scoring/export.ts` exports `internalUploadIds` and
  `evidenceIncludesUpload` (delimited block); the backfill and the tests use them, so the flag
  and the export's expansion agree by construction.

## Design-thread rulings after KS-0 (2026-11-13)

Binding for the packages named; recorded by the orchestrator from the design thread.

- **§12 upload flag (KS-2):** a confirm citing an upload sets `upload_derived` at
  record time even if the task later fails; the flag never resets (no reset path in
  v1). KS-2 also records *why* the flag was set (the causing observation or evidence
  id) so the UI and the export report can explain an exclusion.
- **`similarityFloor` (KS-2):** bm25 is unbounded and corpus-dependent, so it only
  selects the top candidates. The 0.5 floor applies to a bounded measure on
  normalized claims (token-set overlap / Jaccard is enough); document the measure
  next to the config key.
- **KS-1 (from KS-1a notes):**
  - Class-hidden HTML is an accepted known limit; the fence plus the
    "evidence is untrusted" prompt rule must hold on every path that serves text,
    search snippets included.
  - Identity-secret redaction and fence-marker stripping happen at index/serve time.
  - `artifact_texts.error` is derived text: carries the artifact's `upload_derived`
    flag, is returned only through the artifact's own scope checks, and is
    length-capped when served.
  - A `too_large` artifact with partial blocks is indexed; `expand` and
    `read_artifact` say the document was cut at the cap.
- **Wave-1 hooks:**
  1. `FEEDBACK_KINDS` / `FeedbackTargetType` (`src/core/feedback/events.ts`) gain kinds
     `entity_merge`, `entity_rename`, `fact_scope_change`, `fact_retract`,
     `fact_replacement_accept`, `artifact_prune` and target types `entity`,
     `artifact` (facts use `finding`). Code only, no migration (no CHECK on kind).
     Added by whichever of KS-2/KS-3/KS-7 first needs them.
  2. KS-7 human actions go through `src/core/feedback/actions.ts` from the start
     (supersedes the "record a system decision until KS-6" wording above).
  3. `promptStoreGaps` (`src/core/prompts/store.ts`) lists columns by hand: KS-4 adds
     `retrieval_events.prompt_version`; KS-5 ensures `prompt_context` retrieval rows
     carry the same prompt hash the run records.

## Design-thread rulings after the KS-0 gate (2026-11-13)

KS-0 passed its gate (Sol 9/10) at 68c744f.

1. Retractions citing an upload also flag the retracted fact: accepted.
2. **KS-1:** `duplicate_of` is followed one level; test the invariant that
   `duplicate_of` always points at an artifact whose own `duplicate_of` is NULL.
3. **KS-2 (moved from KS-6):** the package that starts writing observations closes the
   export read path in the same merge. `export.ts` excludes any finding with the
   stored `upload_derived` flag and any record `itemIsUploadDerived` resolves as
   derived, with a test. KS-6 keeps only `runIsUploadExposed` and the new export lines.
4. **Hard requirement, KS-2/KS-4/KS-5:** every response or prompt section that carries
   store text writes a `retrieval_events` row listing every item whose text it
   carried: search hits (snippets included) and card lines (KS-4); the duplicate
   handshake candidates in `save_finding` and the reviewer context quotes / prior
   claim (KS-2); KS-5 briefings; `read_workspace`. Existing prompt sections that list
   findings stay unlogged until KS-5 replaces them.
5. **KS-3 entity names:** no sticky column. Add `entityIsUploadOnly` beside
   `itemIsUploadDerived`: an entity is upload-only while every record referencing it
   (facts, typed records, captures) is upload-derived; one non-derived usable
   reference makes it publicly attested. Route entity ids through it in exposure
   checks. On merge, an alias taken from an upload-only entity keeps that status
   (representation is the builder's call). Merge suggestions follow the same rule.

## KS-1 builder notes

Smaller decisions taken while building KS-1 (none changes §3, §9 or §12). No migration added.

- **Files:** `knowledge/ingest.ts` (pipeline, `Ingestor`, `ingestorFor`), `knowledge/texts.ts`
  (serve-side helpers for KS-2 / KS-4), `knowledge/artifactTools.ts` (knowledge parts of
  `save_artifact` / `describe_artifact`; `handlers.ts` keeps file handling and calls them).
- **Captures:** `ArtifactStore.capture` / `captureFromPath` return `{ artifact, captureId, created }`;
  `save` / `saveFromPath` keep returning the artifact. The sha lookup, artifact row and capture row
  are one `BEGIN IMMEDIATE` transaction. Only `description` is filled on a later save (as the plan
  says); `url_key`, title, flow etc. stay first-save on the artifact and per-save on the capture.
- **Index-time sanitizing of labels:** title, note, flow and description are redacted
  (`redactServed`, the whole tree's secrets) and fence-stripped before they are stored, so
  `artifacts_fts` never indexes a secret; `source_url` is only redacted.
- **Ingest:** blocks are redacted, fence-stripped and re-normalized *before* hashing and chunking, so
  `content_sha256`, chunk text and chunk offsets all refer to the same sanitized text. `ok` with no
  text left after sanitizing becomes `empty`. Only `pending` rows are ingested (no re-extraction path
  in v1; an extractor version bump needs one, and must re-point duplicates of a canonical whose hash
  changes). The duplicate check runs inside the write transaction (concurrent ingests of equal text
  cannot both become canonical), considers only canonical rows (`duplicate_of IS NULL`, status
  `ok`/`too_large`) of the same tree, picks the oldest (`artifacts.rowid`), and an artifact that is
  already someone's target never becomes a duplicate. Chunk ids `chk_…`.
- **Upload flag on duplicates:** the migration-18 triggers flag a duplicate whose canonical is (or
  later becomes) upload-derived; a duplicate that is itself an upload is flagged by its kind while a
  public canonical stays public. Served text for artifact X therefore carries X's flag OR the
  chunk's (`servedTextState.uploadDerived`). **KS-4:** list the artifact asked for in `result_ids`,
  not only the canonical's chunk ids; capture rows have no flag — serve a capture's description
  under its artifact's flag (an agent saving bytes identical to an upload captures onto the upload).
- **Errors:** stored one line, redacted, fence-stripped, capped at `SERVED_ERROR_MAX_CHARS` (300);
  served only by `servedTextState(store, scope, id, mode)` after the artifact's scope check, through
  `serveEvidenceText` (redact again with current identities → cap → fence) with `contentTrust`.
  Known limit: KS-1a cuts its message at 300 chars and `extract` cuts text at `maxTextChars` before
  redaction runs, so a secret straddling either cut could leave a prefix (extremely unlikely).
  Snippet builders must redact before cutting (`serveEvidenceText` does).
- **Truncation flag:** no column needed: `textTruncated(row)` = `status = 'too_large' AND char_count > 0`
  (`truncated` in `ExtractionSummary` and `ServedTextState`).
- **Queue:** inline when the file is ≤ `inlineMaxBytes` (awaited by `save_artifact`), else queued
  (`concurrency` applies to the queue; inline runs are not counted). Settings are read on every use
  (the runtime config is mutated in place by `PUT /api/config`). One ingestor per `ArtifactStore`
  (`ingestorFor`, bound to the runtime config in `createRuntime`); `boot` re-queues `pending` rows and
  `close` stops the queue before the store closes. `uploadInternal` stays synchronous and submits the
  upload (fire and forget; the promise never rejects); `ingestorFor(deps).idle()` awaits it.
- **save_artifact:** caption rule counts the trimmed description; images = `kind: screenshot` or an
  `image/*` mime; `captions.required: false` turns it off. `entity` = entity id or `{ kind, name }`;
  `applies_to` replaces the home label of a *new* artifact (source `agent`); on identical bytes saved
  earlier it only adds labels (never narrows what other nodes saw). An `applies_to` is logged as a
  `decision` Decision (refs = artifact). Response `extraction` = `{ status, chunks, truncated?,
  duplicateOf?, queued?, uploadDerived? }` (no error text: that is served by KS-4 through the scope
  check). The browser note now asks for a `description` with screenshots.
- **describe_artifact:** "the caller's run saved it" = a capture with the caller's `agent_run_id`. Not
  a judgment, so no Decision row. Out-of-tree and unknown ids: same "artifact '<id>' not found".
  Role access added in a delimited block after `ROLE_TOOLS` (push), not in the literal.
- **KS-3 seam:** `resolveArtifactEntity` (`artifactTools.ts`, delimited) uses KS-0's `ensureEntity`;
  at merge its body becomes `resolveEntity(store, scopeFor(store, ctx.workspaceId), typeof ref ===
  'string' ? { id: ref } : ref, ctx)`. The automatic `has_flow` edge (artifact with flow + entity) is
  KS-3's: captures carry `entity_id` and `flow`.
- **For KS-2:** quote checks use `artifactText(store, id)` (rebuilt from chunks; chunk offsets index
  it; duplicates resolve to the canonical). For "run extraction inline first" call
  `ingestArtifact({ store, artifacts, config }, id)` directly (`Ingestor.submit` would queue a large
  file).
- **For KS-4:** `canonicalArtifactId`, `artifactChunks`, `chunkCount`, `artifactVisible`,
  `servedTextState` (status, `truncated`, canonical, flag, fenced error), `serveEvidenceText`.
- **Pre-existing, not changed:** `boot({ port: 0 })` falls back to the configured port (0 is falsy),
  so two boot tests in parallel files collide on 4317; the KS-1 boot test picks a free port.
  `read_artifact` still serves raw text unfenced until KS-4 replaces it.

## KS-2 builder notes

Smaller decisions taken while building KS-2 (none changes §3, §9 or §12).

- **Modules:** `knowledge/facts.ts` (claims, candidates, freshness, lineage, applying observations,
  human fact actions), `knowledge/factTools.ts` (`save_finding` beyond the replay rule,
  `confirm_finding` / `retract_finding`, quote checks), `knowledge/factReview.ts` (reviewer context),
  `knowledge/uploadCause.ts` (`explainUploadDerived`). Hot files only call into these.
- **Similarity floor:** `claimSimilarity` = Jaccard of the word-token sets (`[\p{L}\p{N}]+`) of
  `normalizeClaim` (§8.2 `normalizeText`, NFKC, lower case, trailing punctuation dropped). FTS5
  selects up to 50 rows (`claim` column, quoted tokens OR-ed, ≤ 32 tokens, bm25 order); the floor and
  `candidateLimit` then apply. Documented next to the config key, in the README and in design §16.
- **Sameness:** "same entity" = equal `entity_id` when both sides have one, else equal subject name
  key (`titleKey`). KS-3 passes the resolved entity as `saveFindingFact(…, { entityId })` (the
  handler passes `{}` today). Candidates: lifecycle `current`, status not `superseded` / `failed`
  (unverified ones are shown, flagged), `workspace_id` in `treeIds`, never the saving task's own
  outputs.
- **Exact match:** auto-confirms only when the evidence includes an artifact captured by this task;
  otherwise it comes back as the first candidate, flagged `exact`, and nothing is saved.
- **Logging:** the handshake writes a `retrieval_events` row (new tool value `save_finding`, scope
  `tree`, results = every fact shown; the auto-confirm logs its matched fact too) and a Decision
  (`decision`, `event: duplicate_handshake`, refs = task + candidates). The reviewer context is
  logged as `prompt_context` on the reviewer run right after the run returns (its id is created
  inside the supervisor); a process crash during the run loses that row — KS-5 may want a pre-run
  hook for all prompt reads.
- **Observations:** every new fact gets a `create` observation (applied with the task: sets
  `last_confirmed_at = created_at`), so KS-5's "what changed" can read new facts from observations.
  Confirm / retract Decisions are kind `score`, payload `tool: confirm_finding | retract_finding`
  and `findingId`, also when they came through `save_finding` (so `outputSaveDecision` still finds
  the original save). The save Decision carries `relation` only when the agent gave one, plus
  `appliesTo` / `evidenceRefs` when used (the plain-save payload is unchanged).
- **Guards:** a fact can be confirmed, retracted or replaced only when current, in the caller's
  tree, and not an output of the caller's own task. Unknown and out-of-tree ids get the same
  "finding '<id>' not found".
- **"Captured by this task"** = an `artifact_captures` row with the task id or one of the task's
  agent runs. KS-1 writes those rows; until KS-1 is merged no capture carries a task, so
  `confirm_finding` / `retract_finding` / auto-confirm fail in production (tests insert captures).
- **Quotes:** whitespace-insensitive, case-sensitive substring of the extracted text (chunks of the
  artifact or of its `duplicate_of` canonical). A `pending` artifact goes through the
  `ensureExtracted` hook (KS-1 wires `ingestArtifact`); without the hook it is extracted in memory
  with the KS-1a library and nothing is stored. Quote ≤ 2 000 chars; offsets stored only on an exact
  raw match. `evidence_refs` artifacts join `findings.evidence`. On a confirmation via
  `save_finding`, quotes are verified but not stored (`finding_evidence` belongs to a fact version).
- **Replacement:** `version` = lineage max + 1 at save (two pending replacements never share one);
  entity and `ttl_days` are inherited, and so are the prior's scope labels when `applies_to` is
  absent and they differ from the caller's node.
- **Applying (§7.2):** replace and retract apply onto the lineage head and set `lineage_conflict`
  on the new head / retracted head when the named version is no longer the head; a conflicting
  replacement is renumbered above every other version and the lineage upload rule is re-applied. A
  **confirmation of a non-head version confirms nothing** and flags the head (confirming the new claim
  with evidence for the old one would be wrong). A rejected candidate still counts for the lineage
  upload rule of later versions (over-flagging only).
- **Outcomes (ruling 5, wired now):** `applyObservations` writes `confirmed` / `changed` (on the
  version actually replaced) / `retracted` with subject `fact_version`, the save Decision, source
  `fact_lineage`, `sourceKey` = observation id. `recordStaleOutcome(store, config, fact, now)`
  exists (`sourceKey` = `last_confirmed_at`, else first seen / created) but has no caller: its call
  sites are KS-4 `list_changes` and the KS-5 briefing. Human actions go through the WP-A feedback
  listener (WP-C's "one place"): `fact_retract` → `retracted` / `user-rejected` (`user_reject`),
  `fact_replacement_accept` → `changed` on the replaced version (`user_override`), keyed by the
  observation id.
- **Human actions** (`facts.ts`): `retractFactByUser` (an applied retract observation without a
  task), `setFactScopes` (source `user`), `applyReplacementByUser` — the last is called from
  `setIncludeOverride` when a finding's include override is set to true on a `candidate` whose
  replace observation was rejected. KS-7 routes call these; they throw `KnowledgeNotFoundError` /
  `FactActionError` (status 409 for a non-current fact).
- **Re-review:** the review queue lists a lineage's live version (replaced and retracted versions
  are skipped), so a new version is unrated and the lineage is queued again. Conflicts are not
  queued there (KS-7's conflict list).
- **Revise prompt:** "Your current outputs" also lists the task's pending confirmations /
  retractions by fact id only (no claim text: that section is not a logged read).
- **Export (ruling 1):** `exportTrainingData` excludes by `uploadExclusionSet`, a `Set` whose `has`
  also answers `itemIsUploadDerived` (memoized) for every id the reference expansion reaches;
  iteration still yields only the upload ids. `explainUploadDerived(store, id)` returns the recorded
  cause chain (item → … → upload) and a one-line text for the UI and the export report.

## KS-3 builder notes

Smaller decisions taken while building KS-3 (none changes §3, §9 or §12).

- **Modules:** `knowledge/entities.ts` (resolve, suggestions, merge, rename, names), `relations.ts`
  (`RELATION_TYPES`, `addRelation`, `neighbours`), `entityLinks.ts` (one `link*` per save path, plus
  `backfillEntityLinks`), `usable.ts` (SQL "usable" / "visible" predicates shared by graph reads and
  the upload rule). `resolveEntity` returns `Entity` as planned; `resolveEntityDetailed` adds
  `{ created, suggestions }`. `mergeEntities(store, survivorId, loserId, actor, { scope? })`: the
  optional scope makes both ids answer `notFound` outside the caller's tree.
- **Suggestions:** candidates = `entities_fts` trigram OR-query (live rows, same root and kind, 50 by
  bm25); score = Dice coefficient of the padded character trigrams of the name keys (also against
  each alias), floor `ENTITY_SUGGESTION_FLOOR` 0.5 (a constant, not a config key), at most 3; a pair
  is never suggested twice in either direction, whatever its status. Names under 3 characters get
  none. Agents never see suggestions (no tool returns them).
- **Upload-only names (ruling 5):** `entityIsUploadOnly` in `provenance.ts` and routed through
  `itemIsUploadDerived` (so `runIsUploadExposed` covers entity ids and merge suggestion ids).
  References = facts (any lifecycle), competitors, personas, symptoms, hypotheses, captures and the
  source record of every edge touching the entity (an entity named only by an edge counts). Usable =
  `usable.ts` (symptoms, artifacts and captures are always usable). No references → not upload-only;
  a `company` entity named after a node of its tree is never upload-only (scope names are user text).
  Representation: `aliases` holds only publicly attested names; an upload-only name that becomes an
  alias stays on its own merged row (merge: the loser row; rename: a new merged "shadow" row), still
  resolvable through `findEntityByKey`. A merged row is upload-only unless its name key is in its
  direct target's `aliases` (or equals the target's key, then it follows the target). Merging a public
  entity into an upload-only one swaps the two rows' names (survivor id kept), so the survivor shows the
  public name. Known limit: attestation is per entity, not per name — a public record that matches an
  upload-only survivor through an upload-only alias attests the survivor's display name too.
- **Merge:** cross-kind merges allowed; re-points `entity_id` in findings, competitors, personas,
  symptoms, symptom_hypotheses, artifact_captures, and both ends of relations (edges that become
  duplicates or self-loops are dropped); the pair's open suggestion → `accepted`, the loser's other
  open ones are re-pointed (closed `rejected` if they collapse). Rename to a name another entity of
  the kind holds → `EntityConflictError` (409, merge instead); to a merged row's name → the rows swap.
- **Saves:** `save_finding` gains `entity` (`{id}` or `{kind,name}`) and `relations` (≤ 10) — KS-3
  owns these two inputs (KS-2: do not add them again); the response carries `entityId`; a re-save of
  the same (task, claim) re-resolves only for an explicit `entity` or a changed subject. Competitor →
  `competitor` + `competes_with` the node's company entity; persona → `persona` (segment, no edge);
  symptom → `symptom` (strength → `topic`); hypothesis → `cause` entity named by its text (≤ 200
  chars) + `causes` → the symptom's entity. A record that already has an entity keeps it (user merges
  and renames are never undone). Records of a workspace with no row get no entity (old tests only).
  `backfillEntityLinks` (startup, after `backfillKnowledge`) adds cause entities and competitor edges
  for rows saved before KS-3.
- **Graph reads:** `neighbours` returns `Relation & { depth, usable }`, both directions, ordered by
  depth, type, insertion; `mode: 'node'` (default) keeps only edges whose source record is visible
  from the scope's `nodeIds` (facts / artifacts by `item_scopes`, typed records by workspace), `tree`
  any node.
- **Human actions:** `mergeEntitiesAsUser` / `renameEntityAsUser` in `feedback/actions.ts`
  (`entity_merge` / `entity_rename`, target type `entity`, survivor's home workspace). When an
  upload-only name is involved, `beforeJson.uploadRefs` lists the upload-derived records, so the
  export's id expansion leaves the event out by default (tested). `FeedbackActionError` 404 for unknown
  / other-tree ids, 409 for conflicts. `api/feedbackRoutes.ts` `TARGET_TYPES` is left to KS-7.
- **Seams:** KS-1 calls `linkArtifactEntity(store, artifact, entityRef, ctx)` in `save_artifact` and
  stores the id on the capture row. KS-2's `replaces` should pass `entity: { id: prior.entityId }`.
  KS-4: entity search hits and card names must be flagged with `entityIsUploadOnly` of the row that
  matched (a merged row for an upload-only alias) and list that id in `results`; `entityNames` gives
  names with their status; `neighbours` for relations on cards. KS-7: `listEntities`,
  `listMergeSuggestions` (with `uploadOnly`), `rejectMergeSuggestion`, the two actions above.

## KS-1/2/3 integration notes

Merged into `feat/learning-loop` in the order KS-1, KS-2, KS-3, then wired (no migration added).

- **Quotes (KS-1 × KS-2):** `FactToolEnv.ensureExtracted` = `ingestorFor(…).ensure(id)`: ingests a
  `pending` artifact now whatever its size, joining a queued run in flight. Captures written by
  `save_artifact` carry the task and agent run, so confirm / retract / auto-confirm work in production
  (`test/core/knowledge/storeWiring.test.ts`, no hand-inserted captures).
- **Artifacts (KS-1 × KS-3):** `resolveArtifactEntity` calls `resolveEntity`; `save_artifact` calls
  `linkArtifactEntity` in the capture transaction (`has_flow`, flow taken from this save). The
  `entity` schema reuses KS-3's `entityRefInput` and still accepts a plain id string.
- **Facts (KS-2 × KS-3):** `saveFindingFact(…, { entity: { peek, resolve, link } })` instead of a
  pre-resolved `entityId` (still accepted). `peek` = `peekFindingEntity` (`lookupEntity` /
  `lookupSubjectEntity`: what resolution would return, writing nothing; `null` = would be created,
  so only entity-less facts can match by subject key, `CandidateQuery.entityId: null`). `resolve`
  and `link` run inside the insert transaction of `saveNew` / `saveReplacement`; the handshake and
  `confirms` never create an entity (an unreferenced entity is not upload-only, so an upload-only
  name would otherwise read as public). `replaces` resolves `{ id: prior.entityId }` (survivor)
  unless `entity` is given. The same-(task, claim) replay keeps KS-3's `relinkFinding`.
- **Tests:** `boot({ port: 0 })` now listens on an ephemeral port (`runtime.setListeningPort` points
  the supervisor's MCP base URL at it); two runs of the suite at once used to collide on 4317, which
  is the likely source of KS-3's two unreproduced failures (both `test/api/main.test.ts` boot tests
  fail exactly that way). The two supervisor idle-kill tests that read files the fake CLI writes
  use a 1.5 s idle window (the watchdog starts at spawn; node start-up under load exceeded 200 ms).

## KS-4 builder notes

Smaller decisions taken while building KS-4 (no migration added). §7.1 / §9 were amended after the
gate (reads by id, interviewer tools, `get_card` / `read_workspace` inputs).

- **Modules:** `knowledge/tools.ts` (`knowledgeRead`: the one entry point — scope, budget, slice check,
  envelope, one `retrieval_events` row, `policy_blocked` events), `readCommon.ts` (visibility SQL,
  slice check, paging that counts the whole envelope), `search.ts`, `cards.ts`, `expand.ts` (`expand` +
  `read_artifact`), `changes.ts`, `promptReads.ts` (prompt-context rows before a run starts). The
  dispatcher's builtins call `knowledgeRead`; `read_workspace` moved from `research/tools.ts` to a
  builtin (the old `workspaceSummary` is gone). KS-7's API calls `knowledgeRead` with `role: 'user'`.
- **Visibility:** queries (`search`, `list_changes`, cards) use `activeIds` (node default; tree only on
  `scope: "tree"`), always inside the SQL of the FTS query.
- **Reads by id (design ruling after the KS-4 gate; overrules the gate's by-id finding):** `expand`,
  `read_artifact`, `get_card` and `read_workspace` with a `workspace_id` return the NAMED item from any
  node of the tree, labelled with its source node (`source`). Everything listed AROUND it follows the
  request's `scope` (node by default): an entity card's facts, typed records, relations and flows; an
  entity's neighbours in `expand`; a node card's entity index and counts (a sibling's node card shows
  that sibling's own view, labelled). Rationale: same-tree nodes may read and cite each other, and an
  agent only holds a sibling id because it asked tree-wide or because in-scope evidence cites it. The
  sibling rule is ONE function, `allowByIdSiblingRead(scope, mode)` in `readCommon.ts` (used through
  `readableById`). Settled by the user after the gate (design §3 decision 13: no confidentiality inside
  a tree, no restricted label): by-id sibling reads stay allowed in node scope. All four by-id tools
  accept `scope` (it decides what is listed around the item). A fact's own evidence and versions are part of the
  named item (tree check only). Unknown and other-tree ids get
  the same "<kind> '<id>' not found" (`item` for `expand`, `artifact`, `entity`, `workspace`, `run`).
  A workspace with no row (legacy tests) is a one-node tree (`factScope`).
- **Envelope and budgets:** every success carries `tokens` (= `estimateTokens` of the whole JSON as
  served), `truncated`, `more` (when truncated), `cursor`, `content_trust: "untrusted"`, `relaxed`,
  `notes`. Paging fits the items into the budget minus the header and a 48-token envelope reserve, so
  no response exceeds its budget (tested per tool). `max_tokens` is accepted on every read tool with a
  floor of 100. `get_card` and `read_workspace` accept `cursor` / `max_tokens` too (design §9 amended). The cursor key is
  `{tool, caller node, role, every input except cursor / max_tokens}`. An item larger than the whole
  budget is replaced by an `{ omitted: true }` placeholder and paging moves on (never stalls; its ids
  are still logged — over-listing only). If the fixed part alone exceeds a small `max_tokens`, the
  response is a short "raise max_tokens" note with no store text and no listed ids. A missing stored
  file (`image` / `raw`) answers with a note.
- **Search:** quoted phrases kept, other text split into `[\p{L}\p{N}]+` tokens, all quoted (≤ 32), AND;
  zero hits over the requested kinds with > 1 term → OR, `relaxed`. bm25 weights: facts (subject 2,
  claim 1), chunks (heading 2, text 1), artifacts (title 3, description 2, note / url / flow 1),
  entities (name 2, aliases 1); then scope rank, then (facts) fresh before stale and usable before not,
  then pool order — scores rounded to 1e-6 so float noise never reorders. Per-kind `limit` default 10,
  max 50; pool 5× the limit. Hits are a flat list ordered by kind (fact, passage, artifact, entity,
  record). Passages are reported under the canonical artifact when visible, else the oldest visible
  duplicate; artifact hits collapse on sha256 or content hash. Entity search needs terms of ≥ 3 chars
  (trigram) and ignores `since`; records ignore `since` (no comparable date). Records use LIKE (v1).
- **Served text:** chunk text and snippets go through `servedChunkText` / `chunkSnippet` (secrets of the
  tree redacted across chunk boundaries with `redactRange`, then cut, then fenced); claims, titles and
  names through `servedLine` (redact whole, then cut). Artifact titles are fence-stripped, not fenced;
  descriptions, capture notes / descriptions, quotes, chunk text and raw pages are fenced. A capture's
  description is served under its artifact's flag. Raw mode redacts the stored file whole (up to
  `maxTextChars` + the longest secret, then `stripSecretTail`) before paging by characters.
- **Redact before every cut (ruling):** ingest asks `extract` for `maxTextChars` + the longest secret of
  the tree, redacts, drops a secret the extractor cut in half (`stripSecretTail`), then caps with KS-1a's
  `capBlocks` (exported) and chunks; a KS-1a error message cut at 300 (`…`) has a half secret dropped
  before redaction. Serve-time redaction stays (identities created after ingest).
- **Retrieval rows:** one per successful call (failed calls write none). `results` lists every item
  whose text was served: fact hits plus the entity named on them; passage hits as chunk + reported
  artifact (+ canonical); entity hits as survivor + the matched merged row; card lines' records,
  entities and flow artifacts, plus the card's entity and its upload-only alias rows; `expand` /
  `read_artifact` the id asked for plus the canonical, chunk ids and nested evidence / versions /
  relation entities shown; `list_changes` facts (old and new) and both page versions. Card "recent
  changes" lines show ids only (no history text), so they are not listed. `upload_derived` = any
  served flag OR `itemIsUploadDerived` of any listed id.
- **Cards:** typed records, top 15 usable current facts (40 on `expand` of an entity), last 5
  replacements / retractions (ids only), live relations by type (≤ 10 names each), flows from captures,
  and a "left out" line. Node cards count facts / artifacts inside the node's own view.
- **Roles:** worker, orchestrator, synthesizer get all five read tools; interviewer gets `search`,
  `get_card`, `expand` and keeps `read_artifact` / `read_workspace` (design §9 amended; usable facts
  only); reviewer and escalation get `expand` +
  `read_artifact` on the review slice. Synthesizer / interviewer: `include_unverified` /
  `include_history` ignored with a note, non-usable facts and records answer "not found", version
  history left out, `list_changes` shows old / retracted claims as ids.
- **Reviewer slice:** `reviewSlice` (research/reviewLoop.ts, next to `reviewContext`): current outputs,
  findings their recommendations / hypotheses cite, `ReviewFactContext.factIds`, and
  `reviewContext().evidence` with their (canonical) chunks. Nested items outside it are left out of an
  expansion. Escalation runs use their task's slice; a reviewer without a task reads nothing. The
  dispatcher imports `reviewLoop` lazily (it imports the dispatcher).
- **Blocked attempts:** `policy_blocked` bus event `{ tool, itemId, reason: out_of_slice | out_of_tree,
  agentRunId?, taskId? }`; out-of-tree only when the id exists in another tree (an unknown id, or an
  in-tree id the role may not read, is not an attempt). **KS-6:** persist it as a `policy_events` row (`blocked`).
- **Prompt reads (ruling):** `RunOptions.beforeStart(ctx)` (supervisor) runs after the AgentRun row and
  the prompt version exist and before the agent starts; a throw fails the run unstarted.
  `AgentRequest.promptReads: PromptRead[]` → `recordPromptReads` there. The reviewer context uses it;
  **KS-5:** pass each briefing as a `PromptRead` with the run request (never log after the run).
- **list_changes:** default window 30 days; `run_id` = a research run of the tree (its start time is the
  window for newly stale facts); changes come from **applied** observations only; "newly stale" = stale
  now and its TTL lapsed inside the window; every stale fact observed gets `recordStaleOutcome` (keyed by
  `last_confirmed_at`, so once per lapse). Changed pages: a later capture of a cited URL with another
  content hash (canonical hashes compared).
- **Orphan entities (ruling):** `entityIsUploadOnly` treats an entity with no referencing record as
  upload-only (fail safe); a node's own `company` entity stays public. Four KS-3 tests that merged /
  renamed unreferenced entities now give them a public fact first.
- **Seams:** KS-5 — `PromptRead` / `promptReads`, `entityCard`, `nodeCard`, `cardFacts`, `factLine`,
  `runListChanges` (briefing "changes since last run"), `servedLine` / `chunkSnippet`. KS-6 —
  `policy_blocked` events, `retrieval_events` rows complete for `retrieval_uses`. KS-7 —
  `knowledgeRead(deps, { workspaceId, role: 'user' }, tool, input)` for the API search / card / fact
  / changes routes (logged as user reads, no agent run).
- **Gate fixes (redact before every cut, sweep):** the reviewer context (`factReview.ts`) redacts
  claims and retraction reasons whole, then cuts (300 chars); stored entity names are redacted before
  the 200-char cut (`cleanAgentEntityName`); the quote-rejection error (80 chars) and duplicate-
  handshake candidates (claims ≤ 500 chars) redact, then cut. Every KS-4 served path already used
  `servedLine` / `chunkSnippet` / `serveEvidenceText` (redact → cut → fence). **Not swept (pre-KS
  prompt sections KS-5 replaces):** `orchestrator.ts`, `businessMap.relatedSection`,
  `synthesisFindingsSection`, `reviewLoop` outputs / `currentOutputsSection`, escalation context cut
  findings, briefs and profiles without redacting at all — **KS-5:** build their replacements with
  `servedLine` (redact whole, then cut).
- **Reviewer context budget (gate):** the whole section — header, lifecycle lines (replacements first,
  then confirmations / retractions), quotes and a footer naming up to 20 left-out fact ids to `expand`
  — fits the reviewer `briefing` budget; `results` lists only facts and artifacts whose text is shown;
  `factIds` (the slice) keeps every fact.
- **Re-gate: around-item lists follow the request scope.** One helper, `aroundVisible(env, item)`
  (`readCommon.ts`), decides every list a by-id response shows around the named item: page versions of
  the same URL, captures, fact versions and unverified updates, evidence metadata (an out-of-scope
  citation is shown as `{ artifact_id, outside_scope: true }` — the id is the fact's own field), relation
  names. Node scope by default; `scope: "tree"` includes the rest, each entry labelled `source`
  (`sourceLabel`); a note counts what node scope left out. Cards use the same mode directly.
- **Re-gate: budgets are never exceeded, and dropping is always said.** Tool calls: the effective
  budget is `max(MIN_RESPONSE_TOKENS = 100, budgetFor(…))` (this floor wins over a smaller configured
  budget or `hardMaxTokens`; `max_tokens` has the same schema floor), so the truncation notice always
  fits: when nothing of a page fits, the response is `{ tokens, truncated: true, more, cursor, notes }`,
  the cursor repeating that page (cursors ignore `max_tokens`). An item larger than the page is a
  placeholder `{ omitted, note, retry_cursor }`; the page counts it as left out (`truncated`, `more`).
  The reviewer context degrades: footer naming left-out ids → footer with counts → one line
  `(knowledge: N item(s) left out)` → `''` (budget too small to say anything); `factIds` (the slice)
  and evidence ids are never cut, and only shown text is logged. **KS-5:** briefings follow the same
  ladder.

## KS-5 builder notes

Smaller decisions taken while building KS-5 (no migration added; none changes §3, §9 or §12).

- **Modules:** `knowledge/briefing.ts` (`fitBriefing` — the ladder; `orchestratorBriefing`, `synthesisBriefing`,
  `workerBriefing`; `taskRecheckFactIds`; the local `crossNodeCausalEdges`), `businessMap.treeLines`. Hot files
  (`orchestrator.ts`, `reviewLoop.ts`, `escalation.ts`, `interview.ts`, `synthesis.ts`, `diff.ts`) call in, in
  delimited blocks. The string functions tests use (`orchestratorPrompt`, `workPrompt`, `revisePrompt`,
  `currentOutputsSection`, `escalationPrompt`, `buildInterviewPrompt`, `synthesisFindingsSection`) stay; runs use
  their `*WithReads` variants, which return the `PromptRead`s passed as `AgentRequest.promptReads` (interviewer:
  `RunOptions.beforeStart`), so every row is written before the run starts and carries the run's prompt hash.
- **One budget per section:** each briefing fits its role's `briefing` budget (orchestrator 1 500, synthesizer
  4 000, worker 1 500; reviewer / escalation: the outputs section and KS-2's knowledge context are two sections,
  each within the budget). Parts are capped by item count first (orchestrator: re-check 12, changes 8, causal
  edges 10, symptoms 10, 10 entities × 3 facts, personas 6, recommendations 5), then the ladder fits the whole.
- **Ladder** (as `factReview`): `(left out for length: N item(s); expand or search them: <≤ 20 ids>)` → `(left
  out for length: N item(s); use search, get_card or list_changes)` → `(knowledge: N item(s) left out)` → `''`.
  Group headings are not items and are dropped when none of their lines is shown. Intro / outro lines carry
  only guidance and counts. A store with nothing in scope says so ("Nothing is stored … yet"), which is true.
- **Served text:** every line goes through `servedLine` (redact whole, then cut; claims 200 chars in briefings,
  160 in the orchestrator index, 1 500 for a reviewer's outputs), then the block is fenced (`<<<EVIDENCE
  knowledge`; review / revise outputs: `outputs`) under `UNTRUSTED_RULE`.
- **Reads:** `Briefing.read` exists whenever the section is non-empty (a count-only section logs `results: []`).
  Also logged: the orchestrator's task-results summary (finding claims, ≤ 5 per task, the rest counted), the
  revise prompt's current outputs, the reviewer's and the escalation agent's outputs section, the interviewer's
  drill-down (now usable facts only: replaced versions with status `verified` were shown before). Reviewer row
  order: KS-2 context first, then outputs.
- **Scope:** node scope everywhere. Tree context = one line per parent / child / sibling (name, scope,
  audiences; parents and children also their profile keys), no findings and no profile values. The synthesis
  briefing counts usable facts elsewhere in the tree ("search with scope \"tree\""; they may still be cited).
  The orchestrator lists usable facts in every phase (before KS-5 it listed unverified ones outside synthesis)
  and counts the rest (`include_unverified`).
- **User ruling (wide view):** "company level" = `scopeOf(ws).level === 'company'`. A cross-node edge is a live
  `causes` / `addresses` edge whose two entities' home nodes and asserting record's node are not all one node,
  tree-wide, labelled `source <ws>`. `crossNodeCausalEdges` is a local helper (KS-7's `aroundVisible` exception
  can replace it at integration). `TREE_WIDE_CAUSES` is in the synthesis briefing (synthesizer and
  symptom-hypothesis workers) and the synthesis-phase orchestrator briefing; `synthesizer.md` and
  `hypotheses.md` say the same.
- **Re-check / changes:** scheduled runs: facts whose TTL ends before the schedule's next cron occurrence
  (cron-parser used directly in the orchestrator: importing `scheduler.ts` would be a cycle); manual runs: stale
  only. "Changes since" = start of `previousRun` (same schedule and phase), else the node's last finished run,
  through `runListChanges` (its `stale` items are skipped: they are under re-check).
- **Stale outcome:** `recordStaleOutcome` for every stale fact a briefing shows (idempotent per
  `last_confirmed_at`); the changes part calls `runListChanges`, which records it for every stale fact in scope,
  as `list_changes` does.
- **`recheck_fact_ids`** (≤ 50 per task): each must be a current fact of the tree, else that task is rejected
  ("recheck_fact_ids: finding '<id>' not found" for unknown and other-tree ids alike; "… is <lifecycle>" for an
  old version). Stored on the accepted entry of the `task_proposal` Decision (`taskRecheckFactIds`); a
  `tasks.recheck_fact_ids` column would be cleaner (not added: no migrations).
- **What changed:** `diffRuns` adds `replaced [{from, to}]`, `retracted`, `confirmed` from the run's applied
  observations (`fact_observations.run_id`). `newFindings` excludes replacement versions and candidates; the
  text match (fallback for facts saved `new`) also compares with facts the previous run confirmed;
  `removedSubjects` counts facts the next run confirmed / replaced / retracted as covered; the screenshot diff
  includes the evidence of confirmations. `contradictedFindings` skips lineages the next run observed and
  non-current versions (a confirmed fact was reported `contradicted`). **KS-6:** the WP-C call
  `recordWhatChangedOutcomes` is isolated in a marked block in `whatChanged.ts`; replace it there.
- **Web:** `ChangeEntry` gains `replaced` / `retracted` / `confirmed`, `empty` accounts for them, and the
  Research view shows one line each (delimited).
- **Prompts:** "Knowledge store" sections in worker, orchestrator, synthesizer, hypotheses, reviewer, escalation
  and interviewer prompts. Versions change through the run prompt store (`recordRunPrompt`); `promptStoreGaps`
  is asserted empty after briefed runs.
- **Uploads in prompts (design-thread ruling on §12):** prompts list uploads as `art_… (<type>, <size>,
  uploaded <date>)` — type from the mime, size from the stored file, never the title — followed by one line
  pointing at `expand` / `read_artifact` (`uploadPromptLines`, `internal/uploads.ts`; orchestrator and
  interviewer, the only prompts that list uploads). This metadata is not derived text: not a logged read, not
  exposure. Tested: an orchestrator run that opens nothing is not upload-exposed; one that `read_artifact`s the
  upload is. `listUploads` (id + title) stays for non-prompt callers.

## KS-6 builder notes

Smaller decisions taken while building KS-6 (no migration added; no change to §3, §9 or §12 — the
`duplicate-saved` reading below is flagged to the design thread).

- **Modules:** `knowledge/uses.ts` (use linkage), `knowledge/outcomes.ts` (label table, `duplicate-saved`,
  lineage outcomes of a run), `knowledge/metrics.ts` (`knowledgeMetrics`, `knowledgeSignals`),
  `api/knowledgeMetricsRoutes.ts`. Hot files only got delimited calls: `handlers.ts` (dispatcher hook),
  `export.ts` (block at the end + three call lines), `busEvents.ts`, `policyEvents.ts`, `feedbackOutcomes.ts`,
  `facts.ts` (`retractFactByUser` option), `feedback/actions.ts` (merge pairs), `feedback/events.ts` (kind),
  `learning/types.ts` (label), `routes.ts` (mount).
- **Use linkage:** generic — after every successful call of `save_finding`, `confirm_finding`,
  `retract_finding`, `save_recommendation`, `save_persona`, `save_competitor`, `save_hypothesis`, `save_symptom`,
  every string of the input that an earlier `retrieval_events` row of the SAME agent run returned is marked
  used (one row per returning retrieval; `used_by_kind` = `observation` for confirmations / retractions, else
  the output kind). A handshake (`saved: false`) uses nothing; replays add nothing (`INSERT OR IGNORE`).
- **Outcomes, each written once** (keyed by `recordOutcome`'s unique index): `confirmed` / `changed` /
  `retracted` by `applyObservations` (observation id); `stale` by `recordStaleOutcome` (freshness base) from
  `list_changes`, the KS-5 briefing and — only when given a `config` — the scheduled "what changed";
  `user-rejected` from `fact_retract` (observation id); `changed` from `fact_replacement_accept`;
  `duplicate-saved` (new label) from the feedback listener (feedback event id).
- **`duplicate-saved` (design §13 "a duplicate handshake answered `new` that the user later merges"):** v1 has
  no fact merge, so two triggers: (1) `entity_merge` that joins a fact saved with explicit `relation: "new"`
  after a handshake of the same run (same or ≥ 0.5-similar claim) with a shown candidate's lineage on the
  other entity — pairs computed before the merge (`mergeDuplicateSaves`) and stored as
  `afterJson.duplicateSaved`; (2) `retractFactByUser(…, { duplicateOf })` (new optional field; same tree,
  other lineage) on such a fact — `afterJson.duplicateOf`. Without an answered handshake nothing is
  written (the agent was never shown the duplicate). Source `user_reject`, actor = the event's actor.
  **KS-7:** expose `duplicateOf` on the fact-retract route if the user wants it.
- **"What changed" (`learning/whatChangedOutcomes.ts`, interface for KS-5):**
  `recordWhatChangedOutcomes(store, { whatChangedDecisionId, prev, next, changedArtifacts, config?, now? }):
  DecisionOutcome[]` — signature unchanged plus optional `config` / `now`. Returns the next run's lineage
  outcomes (`lineageOutcomesOfRun`, read only); for facts of `prev` (saved, or observed with an applied
  observation) whose lineage `next` did NOT observe (`observedLineages`): text fallback `contradicted` only
  when `next` saved a NEW fact (no `replacesId`, version 1) on the same subject and no equal claim; a changed
  cited screenshot → `changed`; with `config`, past TTL → `stale`. KS-5: pass `config` to get `stale`.
- **Policy events:** `policy_blocked` → `policy_events` row `blocked`, `action` = tool, `site` =
  `knowledge:out_of_slice` | `knowledge:out_of_tree`, `detail` names the id. `policyDenialsSection` leaves out
  `knowledge:out_of_tree` (new `excludeSites` filter): the agent was told "not found", and a reminder would
  confirm that the id exists in another tree.
- **Bus events:** `retrieval` and `policy_blocked` are persisted; the retrieval row is `{type, workspaceId,
  retrievalEventId}` + run / task columns only.
- **Export:** `exportExclusion(store)` = KS-2's set + upload exposure (`uploadExposure`: runs with
  `runIsUploadExposed`, their TASKS, and those tasks' outputs; records resolved through what they cite).
  Excluded by default: decisions of an exposed run; decisions whose expansion reaches an exposed task or
  its outputs (so the task's review / deliverable, and later judgments resting on its findings); feedback
  events, requests and agent interview turns tied to an exposed run. Task granularity is deliberate (a
  later round's worker continues from the exposed round's context); over-exclusion only. New lines
  `{type: 'retrieval_event', retrievalEvent, uses}` and `{type: 'fact_observation', observation}`, left out
  when upload-derived (row flag, any result now, the fact / prior / evidence) or of an exposed run / task.
  Consequence: once KS-5 briefings carry upload-derived lines, every run shown one is excluded.
- **Metrics:** human reads (`role: 'user'`, KS-7) are never agent figures (design-thread ruling): reported
  in `retrieval.user` only, outside hit rate, zero-result rate, tokens, usage share and signals; they have
  no run, so no exposure. Used tokens are an estimate (`tokens × min(1, used items / result count)`; no
  per-item token count is stored). Input tokens = input + cache read + cache write. Freshness counts current,
  not superseded facts (pending ones included). `missing_caption` / `rejected_quote` come from persisted
  `tool_call` bus events (retention `telemetry.busEventRetentionDays`).
- **WP-E / WP-G API:** `knowledgeMetrics(store, { workspaceId, scope?: 'tree'|'node', since?, until?,
  config?, dataDir?, now? })` → `{ rootWorkspaceId, workspaceIds, window, store, freshness, retrieval
  { …, user, byTool, byGroup[role, taskType, promptVersion, model] }, usage { total, byRole, byModel,
  byPromptVersion ('role:pv'), byTask } (with retrievedTokens / retrievedShare), signals }`;
  `knowledgeSignals(store, filter)` → `KnowledgeSignal[]` `{ kind, rootWorkspaceId, role, promptVersion,
  count, total, rate, tokens?, taskIds, examples }`. Routes: `GET /api/workspaces/:id/knowledge/metrics` and
  `/knowledge/signals` (`?scope=node`, `?since=`, `?until=`).
- **Feedback kinds:** `artifact_prune` + target type `artifact` added (KS-7's prune writes it). The §13 check
  (`trackingFeedback.test.ts`) covers fact scope change, retract, replacement accept, entity merge / rename,
  artifact prune; **after the KS-7 merge add `entity_merge_reject`** (KS-7's kind) to that list.
- **Known limit:** a run whose only retrieval rows were lost (crash before a prompt read was logged) cannot
  be exposed; unchanged from KS-4.

## KS-7 builder notes

Smaller decisions taken while building KS-7 (no migration added; none changes §3, §9 or §12 beyond
the user decisions 13–16 recorded in design §3, §4 and §12).

- **Modules:** `api/knowledgeRoutes.ts` (mounted in a delimited block of `routes.ts`),
  `knowledge/userViews.ts` (entity list, merge suggestions, stale / conflict lists, stats),
  `knowledge/gc.ts` (`gcReport`, `pruneCheck`, `pruneArtifacts`), `web/src/logic/knowledge.ts`
  (types, display helpers, `useKnowledgeView`), `web/src/views/Knowledge.tsx`; `knowledgeApi` is a
  delimited block in `web/src/logic/api.ts`. `web/src/logic/types.ts` is untouched.
- **Human actions** (`feedback/actions.ts`, KS-7 block): `retractFactAsUser`, `setFactScopesAsUser`,
  `acceptReplacementAsUser` (include override true → `applyReplacementByUser`; 409 when the fact is
  not a pending unverified update), `acceptMergeSuggestionAsUser` (survivor defaults to the earlier
  entity, `candidateId`), `rejectMergeSuggestionAsUser`, `pruneArtifactsAsUser`. All take the caller's
  node and answer an other-tree id with the same 404 as an unknown id. `artifact_prune` / target type
  `artifact` added to `FEEDBACK_KINDS`; `api/feedbackRoutes.ts` `TARGET_TYPES` gains `entity` and
  `artifact`. A rejected merge suggestion writes `entity_merge_reject` (design-thread answer; added to
  §13), target the suggested entity, `uploadRefs` = the suggestion when a name is upload-only.
- **Reads:** search, entity card, node card, item (`expand`), artifact text (`read_artifact`, modes
  outline / text / raw) and changes call `knowledgeRead` with `role: 'user'`. The lists in
  `userViews.ts` use the same scope predicates but write no retrieval row (a user read exposes no
  agent run; **KS-6** may want them counted in metrics). Upload-derived hits and items carry
  `uploadWhy` (`explainUploadDerived`).
- **gc:** references are listed in the design §14 "as built" paragraph; logs (decisions, feedback,
  retrieval events, outcomes) are not references. Age = the latest capture. Prune is all or nothing
  (409 `refused: [{ artifactId, reason, references? }]`); files are moved aside inside the
  transaction and deleted after the commit (moved back if it rolls back). No column marks a pruned
  artifact: missing file + `artifact_prune` event = pruned, missing file alone = `missing`.
  `ArtifactStore.read` throws `ArtifactFileGoneError` (API 410) for a missing file; `persist`
  rewrites a missing file when the same bytes are captured again. The report counts texts from older
  extractor versions; re-extraction is not built (KS-1 notes).
- **Gate nit (`expand.ts`):** relation endpoints of a fact carry `source` (their home node) when it
  is not the caller's.
- **User decisions (coordinator, 2026-11-13):**
  - *Elsewhere count:* `search` in node scope runs the same query tree-wide (same AND / OR as the
    response) and adds `more matches elsewhere in the business (outside node scope): fact 2,
    entity 1; repeat with scope "tree" to see them` — first page only, counts up to the search pool
    (`+` when full), left out when it would cost a hit of the page; the retrieval row is unchanged.
  - *Causal edges:* `aroundVisible` gains the named case `{ kind: 'relation', relation, anchor }`;
    `causes` / `addresses` around an entity of kind `symptom` or `cause` are visible tree-wide in node
    scope (`isCrossNodeCausal`). This applies to the entity card (`get_card`) and so to `expand` of
    such an entity, which renders the card — a cause entity's `get_card` gets it too. Card relation
    names carry `(source <node>)` (the node of the record asserting the edge) whenever that is not the
    caller's node, for every type; causal edges also log the edge id (`relation`) and its source
    record in `results`, and the source record's upload flag marks the line.
- **Web:** evidence is parsed out of its fence (`parseEvidence`) and shown in a `<pre>` as untrusted
  text; nothing uses `innerHTML` (tested). Card lines' `[id]` references open the item.

## KS-5/6/7 integration notes

Merged into `feat/learning-loop` in the order KS-5, KS-6, KS-7 (`--no-ff`), then wired (no migration added).

- **Causal edges (KS-5 × KS-7):** one rule, `causalEdgeShown` (`readCommon.ts`). `aroundVisible`'s relation case
  and `crossNodeCausalEdges` (moved from `briefing.ts`) both use it, so the company briefing lists exactly the
  edges a symptom / cause card lists in node scope. An edge between two non-causal kinds is no longer briefed.
  The briefing keeps its labels and now also logs the edge id; `relationSourceNode` is shared.
- **What changed (KS-5 × KS-6):** `recordWhatChanged` takes `config` / `now` (the orchestrator passes its deps)
  and calls `recordWhatChangedOutcomes` with them, so `stale` is recorded there. The text fallback is one
  function, `contradictedFindings` (`scheduler/diff.ts`, with KS-6's narrower rule: only a NEW fact on the
  subject contradicts), and `factsOfRun` lives next to it. On a replay the existing Decision is reused and the
  keyed outcomes add nothing; a stop between the Decision and its outcomes is repaired.
- **Feedback kinds:** `trackingFeedback.test.ts` runs KS-7's real reject and prune actions and asserts that the
  knowledge kinds in `FEEDBACK_KINDS` are exactly the covered list.
- **`duplicateOf`:** `POST …/knowledge/facts/:id/retract { duplicateOf? }` → `retractFactAsUser` (same-tree
  check through `callerFact`; other tree = unknown = the same 404). Web: `retractAsDuplicate` + a draft field.
- **Export ruling (§12 amended):** exposure split into runs / tasks / outputs; `exposedCause` resolves one level
  through `provenance.evidenceOf` (the bound). A retrieval line is excluded for a USED exposed result, never for
  a merely returned one. `exportTrainingDataWithSummary` counts exclusions by cause (`EXCLUSION_CAUSES`), and
  `exportTrainingData` returns its JSONL. API: the `x-bif-export-summary` header and `/export/summary`. Web:
  `logic/exportSummary.ts`, `useExportSummary`, Decision log.
- **Bus events test:** KS-5 reviewer prompt reads now emit `retrieval` bus events (persisted by KS-6, ids only).
