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
