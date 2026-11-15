/**
 * Append-only schema migrations. `PRAGMA user_version` records how many have been applied.
 * NEVER edit or reorder an existing entry — add a new one at the end.
 *
 * Conventions: snake_case columns; JSON values stored as TEXT; booleans as INTEGER 0/1;
 * every domain row carries `workspace_id`. Columns declared without a type hold values
 * that may be either number or string (no type coercion).
 */
export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sector TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mime TEXT NOT NULL,
    source_url TEXT,
    title TEXT,
    flow TEXT,
    step INTEGER,
    note TEXT,
    captured_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX artifacts_ws_sha ON artifacts (workspace_id, sha256);

  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    claim TEXT NOT NULL,
    criteria TEXT NOT NULL,
    evidence TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX findings_ws ON findings (workspace_id);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    type TEXT NOT NULL,
    brief TEXT NOT NULL,
    subject TEXT,
    model TEXT NOT NULL,
    needs_browser INTEGER NOT NULL,
    acceptance_criteria TEXT NOT NULL,
    status TEXT NOT NULL,
    round INTEGER NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX tasks_ws ON tasks (workspace_id);
  CREATE INDEX tasks_run ON tasks (run_id);

  CREATE TABLE research_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX research_runs_ws ON research_runs (workspace_id);

  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    task_id TEXT,
    role TEXT NOT NULL,
    model TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    exit_code INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX agent_runs_ws ON agent_runs (workspace_id);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_run_id TEXT NOT NULL,
    role TEXT NOT NULL,
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT,
    refs TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX decisions_ws ON decisions (workspace_id);

  CREATE TABLE ratings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    criterion TEXT NOT NULL,
    agent_value,
    verdict TEXT NOT NULL,
    user_value,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ratings_ws ON ratings (workspace_id);
  CREATE INDEX ratings_target ON ratings (target_type, target_id);

  CREATE TABLE user_requests (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    site TEXT,
    details TEXT NOT NULL,
    status TEXT NOT NULL,
    response TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX user_requests_ws ON user_requests (workspace_id);
  CREATE INDEX user_requests_status ON user_requests (status);

  CREATE TABLE recommendations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    criteria TEXT NOT NULL,
    finding_ids TEXT NOT NULL,
    persona_feedback TEXT NOT NULL,
    priority REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX recommendations_ws ON recommendations (workspace_id);

  CREATE TABLE personas (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    segment TEXT NOT NULL,
    profile TEXT NOT NULL,
    agent_md_path TEXT NOT NULL,
    version INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX personas_ws_slug ON personas (workspace_id, slug);

  CREATE TABLE symptoms (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    criteria TEXT NOT NULL,
    evidence TEXT NOT NULL
  );
  CREATE INDEX symptoms_ws ON symptoms (workspace_id);

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    phases TEXT NOT NULL,
    last_run_at TEXT,
    enabled INTEGER NOT NULL
  );
  CREATE INDEX schedules_ws ON schedules (workspace_id);

  CREATE TABLE interview_turns (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX interview_turns_ws ON interview_turns (workspace_id);

  CREATE TABLE profiles (
    workspace_id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  `,
  // 2: Section B — prompt version on agent runs (so run tokens resolve to a full RunContext
  // after a restart) and a lookup index for per-run decisions.
  `
  ALTER TABLE agent_runs ADD COLUMN prompt_version TEXT;
  CREATE INDEX decisions_run ON decisions (agent_run_id);
  `,
  // 3: Section B — user_requests.task_id becomes nullable (runs without a task) and gains
  // task_prior_status (task status to restore once its last pending request resolves).
  // SQLite cannot drop NOT NULL in place, so the table is rebuilt; '' task ids become NULL.
  `
  CREATE TABLE user_requests_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_run_id TEXT NOT NULL,
    task_id TEXT,
    kind TEXT NOT NULL,
    site TEXT,
    details TEXT NOT NULL,
    status TEXT NOT NULL,
    response TEXT,
    created_at TEXT NOT NULL,
    task_prior_status TEXT
  );
  INSERT INTO user_requests_new (id, workspace_id, agent_run_id, task_id, kind, site, details, status, response, created_at)
    SELECT id, workspace_id, agent_run_id, NULLIF(task_id, ''), kind, site, details, status, response, created_at
    FROM user_requests ORDER BY rowid;
  DROP TABLE user_requests;
  ALTER TABLE user_requests_new RENAME TO user_requests;
  CREATE INDEX user_requests_ws ON user_requests (workspace_id);
  CREATE INDEX user_requests_status ON user_requests (status);
  CREATE INDEX user_requests_task ON user_requests (task_id);
  `,
  // 4: Section B — CLI process id (also its process-group id) for orphan cleanup after a crash.
  `
  ALTER TABLE agent_runs ADD COLUMN pid INTEGER;
  `,
  // 5: Section C — disposable identities per workspace + site (credentials stay local).
  `
  CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    site TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password TEXT NOT NULL,
    email_password TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX identities_ws_site ON identities (workspace_id, site);
  `,
  // 6: Section C — scope, audiences and tree link on workspaces; persona audience; unit proposals
  // from the business-mapping phase. Defaults keep older rows valid (company / external).
  `
  ALTER TABLE workspaces ADD COLUMN scope TEXT NOT NULL DEFAULT '{"level":"company","name":"","description":""}';
  ALTER TABLE workspaces ADD COLUMN audiences TEXT NOT NULL DEFAULT '["external"]';
  ALTER TABLE workspaces ADD COLUMN parent_workspace_id TEXT;
  UPDATE workspaces SET scope = json_object('level', 'company', 'name', name, 'description', '');
  CREATE INDEX workspaces_parent ON workspaces (parent_workspace_id);

  ALTER TABLE personas ADD COLUMN audience TEXT NOT NULL DEFAULT 'external';

  CREATE TABLE unit_proposals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    level TEXT NOT NULL,
    audiences TEXT NOT NULL,
    evidence TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    status TEXT NOT NULL,
    child_workspace_id TEXT,
    decision_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX unit_proposals_ws ON unit_proposals (workspace_id);
  `,
  // 7: Section C fix r1 — persisted review-loop step (exact resume) and CLI process start time
  // (verify an orphan's identity before killing it after a crash).
  `
  ALTER TABLE tasks ADD COLUMN step TEXT;
  ALTER TABLE tasks ADD COLUMN submitted_round INTEGER;
  ALTER TABLE tasks ADD COLUMN review_issues TEXT;
  ALTER TABLE agent_runs ADD COLUMN pid_started_at TEXT;
  `,
  // 8: user override for using a finding in recommendation synthesis (NULL = default: verified only).
  `
  ALTER TABLE findings ADD COLUMN include_in_synthesis INTEGER;
  `,
  // 9: Section E fix r1 — schedule activation baseline (creation / last re-enable time).
  `
  ALTER TABLE schedules ADD COLUMN activated_at TEXT;
  `,
  // 10: Section E post-cap — schedule that started a research run (diff baseline per schedule).
  `
  ALTER TABLE research_runs ADD COLUMN schedule_id TEXT;
  `,
  // 11: final review B — review status of every task output (findings already have one; they gain
  // `failed` / `superseded`), the review round each output was last saved in (superseded tracking),
  // user include overrides for recommendations / personas, and persisted pipelines (resume).
  // Existing recommendations / personas take the status of the task that saved them (via their
  // save Decision); rows without a known task become `unverified` (shown flagged, not used).
  `
  ALTER TABLE findings ADD COLUMN task_round INTEGER;

  ALTER TABLE recommendations ADD COLUMN task_id TEXT;
  ALTER TABLE recommendations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE recommendations ADD COLUMN task_round INTEGER;
  ALTER TABLE recommendations ADD COLUMN include_override INTEGER;
  UPDATE recommendations SET task_id = (
    SELECT ar.task_id FROM decisions d JOIN agent_runs ar ON ar.id = d.agent_run_id
    WHERE json_valid(d.payload) AND json_extract(d.payload, '$.tool') = 'save_recommendation'
      AND json_extract(d.payload, '$.recommendationId') = recommendations.id
    ORDER BY d.rowid DESC LIMIT 1
  );
  UPDATE recommendations SET status = COALESCE(
    (SELECT CASE t.status WHEN 'verified' THEN 'verified' WHEN 'unverified' THEN 'unverified' WHEN 'failed' THEN 'failed' ELSE 'pending' END
     FROM tasks t WHERE t.id = recommendations.task_id),
    'unverified'
  );

  ALTER TABLE personas ADD COLUMN task_id TEXT;
  ALTER TABLE personas ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE personas ADD COLUMN task_round INTEGER;
  ALTER TABLE personas ADD COLUMN include_override INTEGER;
  UPDATE personas SET task_id = (
    SELECT ar.task_id FROM decisions d JOIN agent_runs ar ON ar.id = d.agent_run_id
    WHERE json_valid(d.payload) AND json_extract(d.payload, '$.tool') = 'save_persona'
      AND json_extract(d.payload, '$.personaId') = personas.id
    ORDER BY d.rowid DESC LIMIT 1
  );
  UPDATE personas SET status = COALESCE(
    (SELECT CASE t.status WHEN 'verified' THEN 'verified' WHEN 'unverified' THEN 'unverified' WHEN 'failed' THEN 'failed' ELSE 'pending' END
     FROM tasks t WHERE t.id = personas.task_id),
    'unverified'
  );

  CREATE TABLE pipelines (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    phases TEXT NOT NULL,
    next_index INTEGER NOT NULL,
    schedule_id TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX pipelines_ws ON pipelines (workspace_id);
  ALTER TABLE research_runs ADD COLUMN pipeline_id TEXT;
  `,
  // 12: final review C — rated competitors (spec §9) and persisted symptom hypotheses (spec §8 drill-down).
  `
  CREATE TABLE competitors (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    site TEXT,
    threat INTEGER NOT NULL,
    directness INTEGER NOT NULL,
    comparison TEXT NOT NULL,
    evidence TEXT NOT NULL,
    task_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX competitors_ws ON competitors (workspace_id);

  CREATE TABLE symptom_hypotheses (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    symptom_id TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence TEXT NOT NULL,
    task_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX symptom_hypotheses_ws ON symptom_hypotheses (workspace_id);
  CREATE INDEX symptom_hypotheses_symptom ON symptom_hypotheses (symptom_id);
  `,
  // 13: final targeted pass — competitors and symptom hypotheses join the review-status system
  // (status, task_round, include_override; existing rows take their task's status, rows without a
  // known task become `unverified`), and legacy competitor ratings (target id = competitor name /
  // finding subject) are mapped to competitor ids by normalized name (titleKey: trim, lowercase,
  // collapsed whitespace).
  `
  ALTER TABLE competitors ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE competitors ADD COLUMN task_round INTEGER;
  ALTER TABLE competitors ADD COLUMN include_override INTEGER;
  UPDATE competitors SET status = COALESCE(
    (SELECT CASE t.status WHEN 'verified' THEN 'verified' WHEN 'unverified' THEN 'unverified' WHEN 'failed' THEN 'failed' ELSE 'pending' END
     FROM tasks t WHERE t.id = competitors.task_id),
    'unverified'
  );

  ALTER TABLE symptom_hypotheses ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE symptom_hypotheses ADD COLUMN task_round INTEGER;
  ALTER TABLE symptom_hypotheses ADD COLUMN include_override INTEGER;
  UPDATE symptom_hypotheses SET status = COALESCE(
    (SELECT CASE t.status WHEN 'verified' THEN 'verified' WHEN 'unverified' THEN 'unverified' WHEN 'failed' THEN 'failed' ELSE 'pending' END
     FROM tasks t WHERE t.id = symptom_hypotheses.task_id),
    'unverified'
  );

  UPDATE ratings SET target_id = (
    SELECT c.id FROM competitors c
    WHERE c.workspace_id = ratings.workspace_id AND lower(trim(replace(replace(replace(replace(c.name, char(9), ' '), char(10), ' '), '   ', ' '), '  ', ' '))) = lower(trim(replace(replace(replace(replace(ratings.target_id, char(9), ' '), char(10), ' '), '   ', ' '), '  ', ' ')))
    ORDER BY c.rowid LIMIT 1
  )
  WHERE target_type = 'competitor' AND target_id NOT LIKE 'cmp!_%' ESCAPE '!'
    AND EXISTS (
      SELECT 1 FROM competitors c
      WHERE c.workspace_id = ratings.workspace_id AND lower(trim(replace(replace(replace(replace(c.name, char(9), ' '), char(10), ' '), '   ', ' '), '  ', ' '))) = lower(trim(replace(replace(replace(replace(ratings.target_id, char(9), ' '), char(10), ' '), '   ', ' '), '  ', ' ')))
    );
  `,
  // 14: learning loop WP-A — feedback provenance: who/when/why on every human input (ratings,
  // user request answers, unit proposal decisions), the agent run + prompt version a rating judged,
  // the interviewer run of each interview turn, and the append-only `feedback_events` log
  // (src/core/feedback/events.ts). Existing rows keep NULL timestamps / runs (unknown) and the
  // default actor.
  `
  ALTER TABLE ratings ADD COLUMN actor TEXT NOT NULL DEFAULT 'local-user';
  ALTER TABLE ratings ADD COLUMN agent_run_id TEXT;
  ALTER TABLE ratings ADD COLUMN prompt_version TEXT;

  ALTER TABLE user_requests ADD COLUMN resolved_at TEXT;
  ALTER TABLE user_requests ADD COLUMN actor TEXT NOT NULL DEFAULT 'local-user';

  ALTER TABLE unit_proposals ADD COLUMN decided_at TEXT;
  ALTER TABLE unit_proposals ADD COLUMN actor TEXT NOT NULL DEFAULT 'local-user';
  ALTER TABLE unit_proposals ADD COLUMN decision_reason TEXT;
  ALTER TABLE unit_proposals ADD COLUMN original_payload TEXT;

  ALTER TABLE interview_turns ADD COLUMN agent_run_id TEXT;

  CREATE TABLE feedback_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'local-user',
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    agent_run_id TEXT,
    prompt_version TEXT
  );
  CREATE INDEX feedback_events_ws ON feedback_events (workspace_id);
  CREATE INDEX feedback_events_target ON feedback_events (target_type, target_id);
  CREATE TRIGGER feedback_events_no_update BEFORE UPDATE ON feedback_events
    BEGIN SELECT RAISE(ABORT, 'feedback_events is append-only'); END;
  CREATE TRIGGER feedback_events_no_delete BEFORE DELETE ON feedback_events
    BEGIN SELECT RAISE(ABORT, 'feedback_events is append-only'); END;
  `,
  // 15: learning loop WP-B — token/cost usage per run (agent_usage, priced from the dated
  // src/core/harness/pricing.json), run timing and failures (agent_runs attempts / failure_reason /
  // round / task_type, agent_run_attempts; failure_reason on research_runs and tasks), the prompt
  // store (every recorded prompt_version hash resolves to its text) and versioned calibration
  // (calibration_versions: every approved / reverted appendix per business tree root and role).
  `
  CREATE TABLE agent_usage (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT,
    research_run_id TEXT,
    pipeline_id TEXT,
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT,
    attempt INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    cli_reported_cost_usd REAL,
    price_version TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX agent_usage_ws ON agent_usage (workspace_id);
  CREATE INDEX agent_usage_run ON agent_usage (run_id);
  CREATE INDEX agent_usage_pipeline ON agent_usage (pipeline_id);

  ALTER TABLE agent_runs ADD COLUMN attempts INTEGER;
  ALTER TABLE agent_runs ADD COLUMN failure_reason TEXT;
  ALTER TABLE agent_runs ADD COLUMN round INTEGER;
  ALTER TABLE agent_runs ADD COLUMN task_type TEXT;
  ALTER TABLE research_runs ADD COLUMN failure_reason TEXT;
  ALTER TABLE tasks ADD COLUMN failure_reason TEXT;

  CREATE TABLE agent_run_attempts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    rate_limited INTEGER NOT NULL,
    failure_reason TEXT,
    backoff_ms INTEGER
  );
  CREATE INDEX agent_run_attempts_run ON agent_run_attempts (run_id);

  CREATE TABLE prompt_versions (
    hash TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE calibration_versions (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    reverted_from TEXT,
    decision_id TEXT,
    actor TEXT NOT NULL DEFAULT 'local-user',
    created_at TEXT NOT NULL
  );
  CREATE INDEX calibration_versions_root_role ON calibration_versions (root_workspace_id, role);
  `,
  // 16: learning loop WP-C — decision outcomes (labelled after-the-fact judgments of agent decisions:
  // task end, superseded outputs, scheduled what_changed diffs, user overrides / rejects, review
  // disputes — or of a non-decision subject such as a fact version, idempotent per subject + outcome +
  // source event key) and append-only review-issue history (one row per task + round + issue, stable issue
  // ids across rounds, dispute status). Self-contained: depends on no other learning-loop migration.
  `
  CREATE TABLE decision_outcomes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    decision_id TEXT,
    subject_type TEXT,
    subject_id TEXT,
    run_id TEXT,
    outcome TEXT NOT NULL,
    label TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    source TEXT NOT NULL,
    source_key TEXT,
    actor TEXT NOT NULL DEFAULT 'local-user',
    task_id TEXT,
    target_type TEXT,
    target_id TEXT,
    role TEXT,
    task_type TEXT,
    prompt_version TEXT,
    created_at TEXT NOT NULL,
    CHECK (decision_id IS NOT NULL OR subject_id IS NOT NULL)
  );
  CREATE INDEX decision_outcomes_ws ON decision_outcomes (workspace_id);
  CREATE INDEX decision_outcomes_decision ON decision_outcomes (decision_id);
  CREATE INDEX decision_outcomes_subject ON decision_outcomes (subject_type, subject_id);
  CREATE INDEX decision_outcomes_task ON decision_outcomes (task_id);
  -- Idempotency: one row per (subject, outcome, source event key); the subject is
  -- (subject_type, subject_id), else the judged decision.
  CREATE UNIQUE INDEX decision_outcomes_source_key ON decision_outcomes (
    COALESCE(subject_type, 'decision'), COALESCE(subject_id, decision_id), outcome, source_key
  ) WHERE source_key IS NOT NULL;

  CREATE TABLE review_issues (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    issue_id TEXT NOT NULL,
    raw_issue_id TEXT,
    class TEXT NOT NULL,
    text TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    synthetic INTEGER NOT NULL DEFAULT 0,
    reviewer_run_id TEXT NOT NULL,
    review_decision_id TEXT,
    worker_run_id TEXT,
    worker_prompt_version TEXT,
    response_reason TEXT,
    response_decision_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX review_issues_ws ON review_issues (workspace_id);
  CREATE INDEX review_issues_task ON review_issues (task_id, round);
  `,
  // 17: learning loop WP-D — structured escalation options on user_requests (kind 'escalation'),
  // append-only action-policy history (policy_events, scoped by business-tree root) and persisted
  // bus events (bus_events; pruned by config.telemetry.busEventRetentionDays).
  `
  ALTER TABLE user_requests ADD COLUMN options_json TEXT;

  CREATE TABLE policy_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    root_workspace_id TEXT NOT NULL,
    agent_run_id TEXT,
    task_id TEXT,
    role TEXT,
    kind TEXT NOT NULL,
    action TEXT,
    site TEXT,
    detail TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX policy_events_root_role ON policy_events (root_workspace_id, role, created_at);
  CREATE INDEX policy_events_ws ON policy_events (workspace_id, created_at);

  CREATE TABLE bus_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    type TEXT NOT NULL,
    agent_run_id TEXT,
    task_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX bus_events_ws ON bus_events (workspace_id, seq);
  CREATE INDEX bus_events_created ON bus_events (created_at);
  `,
  // 18: knowledge store — KS-0 foundation (docs/superpowers/specs/2026-11-13-knowledge-store-design.md
  // §15, DDL in the build plan): captures, extracted texts and chunks of artifacts; living-fact
  // columns on findings (lineage, version, lifecycle, freshness), quoted evidence and per-run
  // observations; item scope labels; per-tree entities, relations and merge suggestions; retrieval
  // log and use linkage; FTS5 indexes kept in sync by triggers. Invariant triggers: every finding
  // has a lineage and a `home` scope row from its insert, every artifact a `home` scope row and an
  // `artifact_texts` row (status `pending`); `upload_derived` (§12) is materialized and sticky —
  // set from kind `upload`, profile-linked uploads, cited evidence and earlier lineage versions,
  // never reset to 0. SQL backfills here; the rest (entities, url keys, profile-linked uploads of
  // existing rows) is `src/core/knowledge/backfill.ts`, run at startup.
  `
  ALTER TABLE artifacts ADD COLUMN description TEXT;
  ALTER TABLE artifacts ADD COLUMN url_key TEXT;
  ALTER TABLE artifacts ADD COLUMN upload_derived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE artifacts ADD COLUMN upload_cause TEXT;
  UPDATE artifacts SET upload_derived = 1, upload_cause = 'kind:upload' WHERE kind = 'upload';
  CREATE INDEX artifacts_ws_urlkey ON artifacts (workspace_id, url_key);

  CREATE TABLE artifact_captures (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    agent_run_id TEXT,
    task_id TEXT,
    run_id TEXT,
    source_url TEXT,
    url_key TEXT,
    title TEXT,
    flow TEXT,
    step INTEGER,
    note TEXT,
    description TEXT,
    entity_id TEXT,
    captured_at TEXT NOT NULL
  );
  CREATE INDEX artifact_captures_art ON artifact_captures (artifact_id);
  CREATE INDEX artifact_captures_url ON artifact_captures (workspace_id, url_key, captured_at);
  CREATE INDEX artifact_captures_run ON artifact_captures (run_id);
  INSERT INTO artifact_captures (id, artifact_id, workspace_id, source_url, title, flow, step, note, captured_at)
    SELECT CASE WHEN id LIKE 'art!_%' ESCAPE '!' THEN 'cap_' || substr(id, 5) ELSE 'cap_' || id END,
      id, workspace_id, source_url, title, flow, step, note, captured_at
    FROM artifacts ORDER BY rowid;

  CREATE TABLE artifact_texts (
    artifact_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL,
    extractor TEXT,
    error TEXT,
    char_count INTEGER NOT NULL DEFAULT 0,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    content_sha256 TEXT,
    duplicate_of TEXT,
    extracted_at TEXT
  );
  CREATE INDEX artifact_texts_hash ON artifact_texts (content_sha256);
  CREATE INDEX artifact_texts_status ON artifact_texts (status);
  INSERT INTO artifact_texts (artifact_id, workspace_id, status) SELECT id, workspace_id, 'pending' FROM artifacts ORDER BY rowid;

  CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    heading_path TEXT NOT NULL DEFAULT '',
    locator TEXT,
    text TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    token_estimate INTEGER NOT NULL,
    upload_derived INTEGER NOT NULL DEFAULT 0
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
  ALTER TABLE findings ADD COLUMN upload_cause TEXT;
  ALTER TABLE findings ADD COLUMN lineage_conflict INTEGER NOT NULL DEFAULT 0;
  UPDATE findings SET lineage_id = id, first_seen_at = created_at,
    last_confirmed_at = CASE WHEN status = 'verified' THEN created_at END;
  CREATE INDEX findings_lineage ON findings (lineage_id);
  CREATE INDEX findings_entity ON findings (entity_id, lifecycle);

  CREATE TABLE finding_evidence (
    finding_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    artifact_id TEXT NOT NULL,
    chunk_id TEXT,
    quote TEXT,
    char_start INTEGER,
    char_end INTEGER,
    PRIMARY KEY (finding_id, seq)
  );
  CREATE INDEX finding_evidence_art ON finding_evidence (artifact_id);

  CREATE TABLE fact_observations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    prior_finding_id TEXT,
    kind TEXT NOT NULL,
    run_id TEXT,
    task_id TEXT,
    agent_run_id TEXT,
    task_round INTEGER,
    evidence TEXT NOT NULL DEFAULT '[]',
    reason TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    applied_at TEXT
  );
  CREATE INDEX fact_observations_task ON fact_observations (task_id);
  CREATE INDEX fact_observations_lineage ON fact_observations (lineage_id);
  CREATE INDEX fact_observations_run ON fact_observations (run_id);

  CREATE TABLE item_scopes (
    item_kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'home',
    PRIMARY KEY (item_kind, item_id, workspace_id)
  );
  CREATE INDEX item_scopes_ws ON item_scopes (workspace_id, item_kind);
  INSERT INTO item_scopes (item_kind, item_id, workspace_id) SELECT 'fact', id, workspace_id FROM findings ORDER BY rowid;
  INSERT INTO item_scopes (item_kind, item_id, workspace_id) SELECT 'artifact', id, workspace_id FROM artifacts ORDER BY rowid;

  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    merged_into_id TEXT,
    created_by_run TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX entities_root_kind_key ON entities (root_workspace_id, kind, name_key);
  ALTER TABLE competitors ADD COLUMN entity_id TEXT;
  ALTER TABLE personas ADD COLUMN entity_id TEXT;
  ALTER TABLE symptoms ADD COLUMN entity_id TEXT;
  ALTER TABLE symptom_hypotheses ADD COLUMN entity_id TEXT;

  CREATE TABLE relations (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    from_entity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    to_entity_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX relations_uniq ON relations (from_entity_id, type, to_entity_id, source_kind, source_id);
  CREATE INDEX relations_to ON relations (to_entity_id, type);

  CREATE TABLE entity_merge_suggestions (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    score REAL NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    actor TEXT
  );
  CREATE INDEX entity_merge_suggestions_root ON entity_merge_suggestions (root_workspace_id, status);

  CREATE TABLE retrieval_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    root_workspace_id TEXT NOT NULL,
    agent_run_id TEXT,
    task_id TEXT,
    role TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    prompt_version TEXT,
    tool TEXT NOT NULL,
    query TEXT NOT NULL,
    scope TEXT NOT NULL,
    result_ids TEXT NOT NULL,
    result_count INTEGER NOT NULL,
    tokens_returned INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    relaxed INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL,
    upload_derived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX retrieval_events_run ON retrieval_events (agent_run_id);
  CREATE INDEX retrieval_events_ws ON retrieval_events (workspace_id, created_at);
  CREATE TRIGGER retrieval_events_no_update BEFORE UPDATE ON retrieval_events
    BEGIN SELECT RAISE(ABORT, 'retrieval_events is append-only'); END;
  CREATE TRIGGER retrieval_events_no_delete BEFORE DELETE ON retrieval_events
    BEGIN SELECT RAISE(ABORT, 'retrieval_events is append-only'); END;

  CREATE TABLE retrieval_uses (
    retrieval_event_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    used_by_kind TEXT NOT NULL,
    used_by_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (retrieval_event_id, item_id, used_by_id)
  );

  -- Full-text indexes (external content; rowids of the content tables). Never VACUUM the database
  -- without a 'rebuild' of these afterwards: VACUUM may renumber rowids of tables without an
  -- INTEGER PRIMARY KEY.
  CREATE VIRTUAL TABLE findings_fts USING fts5(subject, claim, content='findings', content_rowid='rowid',
    tokenize='porter unicode61 remove_diacritics 2');
  CREATE VIRTUAL TABLE chunks_fts USING fts5(heading_path, text, content='chunks', content_rowid='rowid',
    tokenize='porter unicode61 remove_diacritics 2');
  CREATE VIRTUAL TABLE artifacts_fts USING fts5(title, description, note, source_url, flow, content='artifacts',
    content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
  CREATE VIRTUAL TABLE entities_fts USING fts5(name, aliases, content='entities', content_rowid='rowid', tokenize='trigram');

  CREATE TRIGGER findings_fts_ai AFTER INSERT ON findings BEGIN
    INSERT INTO findings_fts (rowid, subject, claim) VALUES (new.rowid, new.subject, new.claim);
  END;
  CREATE TRIGGER findings_fts_ad AFTER DELETE ON findings BEGIN
    INSERT INTO findings_fts (findings_fts, rowid, subject, claim) VALUES ('delete', old.rowid, old.subject, old.claim);
  END;
  CREATE TRIGGER findings_fts_au AFTER UPDATE OF subject, claim ON findings BEGIN
    INSERT INTO findings_fts (findings_fts, rowid, subject, claim) VALUES ('delete', old.rowid, old.subject, old.claim);
    INSERT INTO findings_fts (rowid, subject, claim) VALUES (new.rowid, new.subject, new.claim);
  END;

  CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts (rowid, heading_path, text) VALUES (new.rowid, new.heading_path, new.text);
  END;
  CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts (chunks_fts, rowid, heading_path, text) VALUES ('delete', old.rowid, old.heading_path, old.text);
  END;
  CREATE TRIGGER chunks_fts_au AFTER UPDATE OF heading_path, text ON chunks BEGIN
    INSERT INTO chunks_fts (chunks_fts, rowid, heading_path, text) VALUES ('delete', old.rowid, old.heading_path, old.text);
    INSERT INTO chunks_fts (rowid, heading_path, text) VALUES (new.rowid, new.heading_path, new.text);
  END;

  CREATE TRIGGER artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
    INSERT INTO artifacts_fts (rowid, title, description, note, source_url, flow)
      VALUES (new.rowid, new.title, new.description, new.note, new.source_url, new.flow);
  END;
  CREATE TRIGGER artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
    INSERT INTO artifacts_fts (artifacts_fts, rowid, title, description, note, source_url, flow)
      VALUES ('delete', old.rowid, old.title, old.description, old.note, old.source_url, old.flow);
  END;
  CREATE TRIGGER artifacts_fts_au AFTER UPDATE OF title, description, note, source_url, flow ON artifacts BEGIN
    INSERT INTO artifacts_fts (artifacts_fts, rowid, title, description, note, source_url, flow)
      VALUES ('delete', old.rowid, old.title, old.description, old.note, old.source_url, old.flow);
    INSERT INTO artifacts_fts (rowid, title, description, note, source_url, flow)
      VALUES (new.rowid, new.title, new.description, new.note, new.source_url, new.flow);
  END;

  CREATE TRIGGER entities_fts_ai AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts (rowid, name, aliases) VALUES (new.rowid, new.name, new.aliases);
  END;
  CREATE TRIGGER entities_fts_ad AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts (entities_fts, rowid, name, aliases) VALUES ('delete', old.rowid, old.name, old.aliases);
  END;
  CREATE TRIGGER entities_fts_au AFTER UPDATE OF name, aliases ON entities BEGIN
    INSERT INTO entities_fts (entities_fts, rowid, name, aliases) VALUES ('delete', old.rowid, old.name, old.aliases);
    INSERT INTO entities_fts (rowid, name, aliases) VALUES (new.rowid, new.name, new.aliases);
  END;

  INSERT INTO findings_fts (findings_fts) VALUES ('rebuild');
  INSERT INTO artifacts_fts (artifacts_fts) VALUES ('rebuild');

  -- Invariants for rows written by any code path.
  CREATE TRIGGER findings_ks_insert AFTER INSERT ON findings BEGIN
    UPDATE findings SET lineage_id = COALESCE(lineage_id, id), first_seen_at = COALESCE(first_seen_at, created_at)
      WHERE rowid = new.rowid AND (lineage_id IS NULL OR first_seen_at IS NULL);
    INSERT OR IGNORE INTO item_scopes (item_kind, item_id, workspace_id, source) VALUES ('fact', new.id, new.workspace_id, 'home');
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
        SELECT 'evidence:' || a.id FROM json_each(CASE WHEN json_valid(new.evidence) THEN new.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1 LIMIT 1))
      WHERE rowid = new.rowid AND upload_derived = 0 AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(new.evidence) THEN new.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1);
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
        SELECT 'lineage:' || p.id FROM findings p
        WHERE p.lineage_id = new.lineage_id AND p.version < new.version AND p.upload_derived = 1 ORDER BY p.version LIMIT 1))
      WHERE rowid = new.rowid AND upload_derived = 0 AND EXISTS (
        SELECT 1 FROM findings p WHERE p.lineage_id = new.lineage_id AND p.version < new.version AND p.upload_derived = 1);
  END;
  CREATE TRIGGER artifacts_ks_insert AFTER INSERT ON artifacts BEGIN
    INSERT OR IGNORE INTO item_scopes (item_kind, item_id, workspace_id, source) VALUES ('artifact', new.id, new.workspace_id, 'home');
    INSERT OR IGNORE INTO artifact_texts (artifact_id, workspace_id, status) VALUES (new.id, new.workspace_id, 'pending');
    UPDATE artifacts SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'kind:upload')
      WHERE rowid = new.rowid AND new.kind = 'upload' AND upload_derived = 0;
  END;

  -- upload_derived (design §12): sticky (never reset) and propagated. Sources of the flag:
  --   artifacts: kind 'upload'; listed in a profile's uploads; text duplicate_of a flagged artifact.
  --   chunks: their artifact.
  --   findings: findings.evidence, finding_evidence, any fact_observations row (confirm / replace /
  --   retract) citing a flagged artifact; an earlier flagged version of the lineage.
  -- Records without a flag column (competitors, symptoms, hypotheses, personas, recommendations,
  -- unit proposals) are resolved at read time from these flags (src/core/knowledge/provenance.ts).
  -- upload_cause keeps the first cause: kind:upload | profile:<ws> | duplicate_of:<art> |
  -- evidence:<art> | finding_evidence:<art> | observation:<obs> | lineage:<finding>.
  CREATE TRIGGER artifacts_upload_sticky BEFORE UPDATE OF upload_derived ON artifacts
    WHEN old.upload_derived = 1 AND new.upload_derived IS NOT 1
    BEGIN SELECT RAISE(ABORT, 'upload_derived is sticky'); END;
  CREATE TRIGGER findings_upload_sticky BEFORE UPDATE OF upload_derived ON findings
    WHEN old.upload_derived = 1 AND new.upload_derived IS NOT 1
    BEGIN SELECT RAISE(ABORT, 'upload_derived is sticky'); END;
  CREATE TRIGGER chunks_upload_sticky BEFORE UPDATE OF upload_derived ON chunks
    WHEN old.upload_derived = 1 AND new.upload_derived IS NOT 1
    BEGIN SELECT RAISE(ABORT, 'upload_derived is sticky'); END;

  -- An artifact became upload-derived: flag its text duplicates first, then re-apply the general
  -- rules (every dependent of every flagged artifact), so dependents of those duplicates are covered
  -- although SQLite does not re-fire this trigger for the duplicates (recursive_triggers is off).
  CREATE TRIGGER artifacts_upload_cascade AFTER UPDATE OF upload_derived ON artifacts
    WHEN new.upload_derived = 1 AND old.upload_derived = 0
  BEGIN
    UPDATE artifacts SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'duplicate_of:' || new.id)
      WHERE upload_derived = 0 AND id IN (SELECT artifact_id FROM artifact_texts WHERE duplicate_of = new.id);
    UPDATE chunks SET upload_derived = 1
      WHERE upload_derived = 0 AND artifact_id IN (SELECT id FROM artifacts WHERE upload_derived = 1);
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
        SELECT 'evidence:' || a.id FROM json_each(CASE WHEN json_valid(findings.evidence) THEN findings.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1 LIMIT 1))
      WHERE upload_derived = 0 AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(findings.evidence) THEN findings.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1);
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
        SELECT 'finding_evidence:' || a.id FROM finding_evidence fe JOIN artifacts a ON a.id = fe.artifact_id
        WHERE fe.finding_id = findings.id AND a.upload_derived = 1 ORDER BY fe.seq LIMIT 1))
      WHERE upload_derived = 0 AND EXISTS (
        SELECT 1 FROM finding_evidence fe JOIN artifacts a ON a.id = fe.artifact_id
        WHERE fe.finding_id = findings.id AND a.upload_derived = 1);
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
        SELECT 'observation:' || o.id FROM fact_observations o
        JOIN json_each(CASE WHEN json_valid(o.evidence) THEN o.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value
        WHERE o.finding_id = findings.id AND a.upload_derived = 1 ORDER BY o.rowid LIMIT 1))
      WHERE upload_derived = 0 AND EXISTS (
        SELECT 1 FROM fact_observations o
        JOIN json_each(CASE WHEN json_valid(o.evidence) THEN o.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value
        WHERE o.finding_id = findings.id AND a.upload_derived = 1);
  END;
  CREATE TRIGGER findings_upload_lineage AFTER UPDATE OF upload_derived ON findings
    WHEN new.upload_derived = 1 AND old.upload_derived = 0
  BEGIN
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'lineage:' || new.id)
      WHERE lineage_id = new.lineage_id AND version > new.version AND upload_derived = 0;
  END;
  CREATE TRIGGER findings_upload_evidence AFTER UPDATE OF evidence ON findings
    WHEN new.upload_derived = 0
  BEGIN
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
        SELECT 'evidence:' || a.id FROM json_each(CASE WHEN json_valid(new.evidence) THEN new.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1 LIMIT 1))
      WHERE rowid = new.rowid AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(new.evidence) THEN new.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1);
  END;
  CREATE TRIGGER finding_evidence_upload_insert AFTER INSERT ON finding_evidence BEGIN
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'finding_evidence:' || new.artifact_id)
      WHERE id = new.finding_id AND upload_derived = 0
        AND EXISTS (SELECT 1 FROM artifacts a WHERE a.id = new.artifact_id AND a.upload_derived = 1);
  END;
  CREATE TRIGGER finding_evidence_upload_update AFTER UPDATE OF artifact_id, finding_id ON finding_evidence BEGIN
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'finding_evidence:' || new.artifact_id)
      WHERE id = new.finding_id AND upload_derived = 0
        AND EXISTS (SELECT 1 FROM artifacts a WHERE a.id = new.artifact_id AND a.upload_derived = 1);
  END;
  CREATE TRIGGER fact_observations_upload_insert AFTER INSERT ON fact_observations BEGIN
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'observation:' || new.id)
      WHERE id = new.finding_id AND upload_derived = 0 AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(new.evidence) THEN new.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1);
  END;
  CREATE TRIGGER fact_observations_upload_update AFTER UPDATE OF evidence, finding_id ON fact_observations BEGIN
    UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'observation:' || new.id)
      WHERE id = new.finding_id AND upload_derived = 0 AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(new.evidence) THEN new.evidence ELSE '[]' END) j
        JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1);
  END;
  CREATE TRIGGER chunks_upload_insert AFTER INSERT ON chunks
    WHEN new.upload_derived = 0
  BEGIN
    UPDATE chunks SET upload_derived = 1
      WHERE rowid = new.rowid AND EXISTS (SELECT 1 FROM artifacts a WHERE a.id = new.artifact_id AND a.upload_derived = 1);
  END;
  CREATE TRIGGER artifact_texts_upload_duplicate AFTER UPDATE OF duplicate_of ON artifact_texts
    WHEN new.duplicate_of IS NOT NULL
  BEGIN
    UPDATE artifacts SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'duplicate_of:' || new.duplicate_of)
      WHERE id = new.artifact_id AND upload_derived = 0
        AND EXISTS (SELECT 1 FROM artifacts c WHERE c.id = new.duplicate_of AND c.upload_derived = 1);
  END;
  CREATE TRIGGER artifact_texts_upload_duplicate_insert AFTER INSERT ON artifact_texts
    WHEN new.duplicate_of IS NOT NULL
  BEGIN
    UPDATE artifacts SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'duplicate_of:' || new.duplicate_of)
      WHERE id = new.artifact_id AND upload_derived = 0
        AND EXISTS (SELECT 1 FROM artifacts c WHERE c.id = new.duplicate_of AND c.upload_derived = 1);
  END;
  CREATE TRIGGER profiles_uploads_insert AFTER INSERT ON profiles BEGIN
    UPDATE artifacts SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'profile:' || new.workspace_id)
      WHERE upload_derived = 0 AND id IN (SELECT value FROM json_each(
        CASE WHEN json_valid(new.data)
          THEN (CASE WHEN json_type(new.data, '$.uploads') = 'array' THEN json_extract(new.data, '$.uploads') ELSE '[]' END)
          ELSE '[]' END));
  END;
  CREATE TRIGGER profiles_uploads_update AFTER UPDATE OF data ON profiles BEGIN
    UPDATE artifacts SET upload_derived = 1, upload_cause = COALESCE(upload_cause, 'profile:' || new.workspace_id)
      WHERE upload_derived = 0 AND id IN (SELECT value FROM json_each(
        CASE WHEN json_valid(new.data)
          THEN (CASE WHEN json_type(new.data, '$.uploads') = 'array' THEN json_extract(new.data, '$.uploads') ELSE '[]' END)
          ELSE '[]' END));
  END;
  `,
  // 19: learning loop WP-E — lessons engine and retro: per business-tree root and role lesson rules
  // (tracking marker, strength, rule version, status, the role prompt versions around the accepted
  // change), the proposals the user accepts or rejects (engine: add / strengthen / retire / revert;
  // weekly retro agent: prompt and calibration edits; evidence by id), lesson signals recorded by
  // other packages (e.g. WP-F reviewer-audit misses; idempotent per source + key) and retro runs.
  `
  CREATE TABLE lesson_rules (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    role TEXT NOT NULL,
    category TEXT NOT NULL,
    marker TEXT NOT NULL,
    text TEXT NOT NULL,
    strength INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    proposal_id TEXT,
    actor TEXT NOT NULL DEFAULT 'local-user',
    created_at TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    ended_at TEXT,
    prompt_version_before TEXT,
    prompt_version_after TEXT
  );
  CREATE UNIQUE INDEX lesson_rules_marker ON lesson_rules (marker);
  CREATE INDEX lesson_rules_root_role ON lesson_rules (root_workspace_id, role, status);

  CREATE TABLE lesson_proposals (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    role TEXT NOT NULL,
    action TEXT NOT NULL,
    category TEXT,
    rule_id TEXT,
    text TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    stats TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL,
    retro_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    actor TEXT,
    reason TEXT,
    decision_id TEXT,
    feedback_event_id TEXT
  );
  CREATE INDEX lesson_proposals_root ON lesson_proposals (root_workspace_id, status);
  CREATE INDEX lesson_proposals_rule ON lesson_proposals (rule_id);

  CREATE TABLE lesson_signals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    root_workspace_id TEXT NOT NULL,
    role TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT NOT NULL,
    source_key TEXT,
    task_id TEXT,
    agent_run_id TEXT,
    prompt_version TEXT,
    ref_id TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX lesson_signals_key ON lesson_signals (source, source_key) WHERE source_key IS NOT NULL;
  CREATE INDEX lesson_signals_root ON lesson_signals (root_workspace_id, role);

  CREATE TABLE retros (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    status TEXT NOT NULL,
    triggered_by TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    agent_run_id TEXT,
    digest TEXT NOT NULL DEFAULT '{}',
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    proposal_ids TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX retros_root ON retros (root_workspace_id, created_at);
  `,
  // 20: learning loop WP-F — reviewer audits and A/B experiments. Tags on agent runs, decisions and
  // tasks (`experiment_id`, `arm`, `audit_id`; `lessons_off` on runs) so metrics can leave experiment
  // and audit runs out; runs of an experiment task and decisions of a tagged run inherit the tags by
  // trigger from their insert. `reviewer_audits`: one re-review of a verified task by another model
  // (verdict agree | miss | invalid | skipped), per business-tree root. `experiments`: one source task
  // re-run as arms A / B (model and / or worker prompt version). `audit_schedules`: cron schedules of
  // audits, run by the existing scheduler. Self-contained: depends on no other learning-loop migration.
  `
  ALTER TABLE agent_runs ADD COLUMN experiment_id TEXT;
  ALTER TABLE agent_runs ADD COLUMN arm TEXT;
  ALTER TABLE agent_runs ADD COLUMN audit_id TEXT;
  ALTER TABLE agent_runs ADD COLUMN lessons_off INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE decisions ADD COLUMN experiment_id TEXT;
  ALTER TABLE decisions ADD COLUMN arm TEXT;
  ALTER TABLE decisions ADD COLUMN audit_id TEXT;
  ALTER TABLE tasks ADD COLUMN experiment_id TEXT;
  ALTER TABLE tasks ADD COLUMN arm TEXT;
  CREATE INDEX agent_runs_experiment ON agent_runs (experiment_id) WHERE experiment_id IS NOT NULL;
  CREATE INDEX agent_runs_audit ON agent_runs (audit_id) WHERE audit_id IS NOT NULL;
  CREATE INDEX decisions_experiment ON decisions (experiment_id) WHERE experiment_id IS NOT NULL;
  CREATE INDEX decisions_audit ON decisions (audit_id) WHERE audit_id IS NOT NULL;
  CREATE INDEX tasks_experiment ON tasks (experiment_id) WHERE experiment_id IS NOT NULL;

  -- Every run of an experiment task (worker, reviewer, ...) carries its experiment and arm, lessons off.
  CREATE TRIGGER agent_runs_experiment_tag AFTER INSERT ON agent_runs
    WHEN new.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = new.task_id AND t.experiment_id IS NOT NULL)
  BEGIN
    UPDATE agent_runs SET
      experiment_id = (SELECT t.experiment_id FROM tasks t WHERE t.id = new.task_id),
      arm = (SELECT t.arm FROM tasks t WHERE t.id = new.task_id),
      lessons_off = 1
    WHERE id = new.id;
  END;
  -- Every decision of a tagged run carries the run's tags.
  CREATE TRIGGER decisions_run_tag AFTER INSERT ON decisions
    WHEN EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = new.agent_run_id AND (r.experiment_id IS NOT NULL OR r.audit_id IS NOT NULL))
  BEGIN
    UPDATE decisions SET
      experiment_id = (SELECT r.experiment_id FROM agent_runs r WHERE r.id = new.agent_run_id),
      arm = (SELECT r.arm FROM agent_runs r WHERE r.id = new.agent_run_id),
      audit_id = (SELECT r.audit_id FROM agent_runs r WHERE r.id = new.agent_run_id)
    WHERE id = new.id;
  END;

  CREATE TABLE reviewer_audits (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    root_workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    started_by TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'local-user',
    schedule_id TEXT,
    status TEXT NOT NULL,
    verdict TEXT,
    reason TEXT,
    pass_threshold REAL NOT NULL,
    original_decision_id TEXT NOT NULL,
    original_run_id TEXT,
    original_model TEXT NOT NULL,
    original_prompt_version TEXT,
    original_score REAL NOT NULL,
    audit_model TEXT,
    audit_run_id TEXT,
    audit_decision_id TEXT,
    audit_prompt_version TEXT,
    audit_score REAL,
    audit_issues TEXT NOT NULL DEFAULT '[]',
    outcome_id TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX reviewer_audits_root ON reviewer_audits (root_workspace_id, created_at);
  CREATE INDEX reviewer_audits_task ON reviewer_audits (task_id);

  CREATE TABLE experiments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    root_workspace_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    research_run_id TEXT NOT NULL,
    name TEXT,
    arms TEXT NOT NULL,
    repeats INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    failure_reason TEXT,
    actor TEXT NOT NULL DEFAULT 'local-user',
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX experiments_ws ON experiments (workspace_id, created_at);

  CREATE TABLE audit_schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    root_workspace_id TEXT NOT NULL,
    cron TEXT NOT NULL,
    n INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    activated_at TEXT,
    actor TEXT NOT NULL DEFAULT 'local-user',
    created_at TEXT NOT NULL
  );
  CREATE INDEX audit_schedules_root ON audit_schedules (root_workspace_id);
  `,
  // 21: two-pass OCR (knowledge store). Pass 1 (rules, `knowledge/ocr/rules.ts`) plans what a model
  // has to read; pass 2 (`knowledge/ocr/haiku.ts`) reads it. `ocr_status`: NULL = never planned,
  // none | pending | done | failed | skipped. `ocr_runs`: one row per model call (tokens and cost).
  `
  ALTER TABLE artifact_texts ADD COLUMN ocr_status TEXT;
  ALTER TABLE artifact_texts ADD COLUMN ocr_plan TEXT;
  ALTER TABLE artifact_texts ADD COLUMN ocr_error TEXT;
  ALTER TABLE artifact_texts ADD COLUMN ocr_at TEXT;
  CREATE INDEX artifact_texts_ocr ON artifact_texts (ocr_status);

  CREATE TABLE ocr_runs (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    target TEXT NOT NULL,
    pages TEXT NOT NULL DEFAULT '[]',
    pages_read INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    cli_reported_cost_usd REAL,
    price_version TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ocr_runs_art ON ocr_runs (artifact_id);
  CREATE INDEX ocr_runs_ws ON ocr_runs (workspace_id, created_at);
  `,
  // 22: flow records and flow ranking (design 2026-11-14-flow-records-and-ranking-design.md). One
  // catalog of flow types and checklists per business tree (`root_workspace_id`; a checklist with no
  // `flow_type_id` is the general one). A flow is one subject's variant of a flow type, versioned like
  // findings (`lineage_id`, `lifecycle`), with its steps and check answers. Review mentions are stored
  // once per tree, subject and quote. Verdicts (persona head-to-heads, pair stored with
  // flow_a_id < flow_b_id), the user's pair overrides and rank snapshots belong to a node
  // (`workspace_id`). JSON columns: checklists.items, flow_steps.asked, flow_checks.value / step_refs /
  // mention_refs, flow_rank_snapshots.ranking. Repositories: `flows/repos.ts`.
  `
  CREATE TABLE flow_types (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    status TEXT NOT NULL,
    merged_into_id TEXT,
    proposed_by_run TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX flow_types_key ON flow_types (root_workspace_id, key);

  CREATE TABLE checklists (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    flow_type_id TEXT,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    coverage REAL NOT NULL,
    items TEXT NOT NULL DEFAULT '[]',
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT
  );
  CREATE UNIQUE INDEX checklists_version ON checklists (root_workspace_id, COALESCE(flow_type_id, ''), version);

  CREATE TABLE flows (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    root_workspace_id TEXT NOT NULL,
    subject_entity_id TEXT NOT NULL,
    flow_type_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    variant_key TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    entry_url TEXT,
    reached_goal INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    notable TEXT,
    steps_hash TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    replaces_id TEXT,
    lifecycle TEXT NOT NULL,
    status TEXT NOT NULL,
    task_id TEXT,
    task_round INTEGER,
    include_override INTEGER,
    run_id TEXT,
    entity_id TEXT,
    first_seen_at TEXT NOT NULL,
    last_confirmed_at TEXT,
    confirm_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX flows_subject ON flows (subject_entity_id, flow_type_id, variant_key, lifecycle);
  CREATE INDEX flows_task ON flows (task_id);

  CREATE TABLE flow_steps (
    flow_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    action TEXT NOT NULL,
    observation TEXT NOT NULL,
    asked TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    artifact_id TEXT,
    page_url TEXT,
    PRIMARY KEY (flow_id, seq)
  );

  CREATE TABLE flow_checks (
    flow_id TEXT NOT NULL,
    checklist_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    answer TEXT NOT NULL,
    value TEXT,
    step_refs TEXT NOT NULL DEFAULT '[]',
    mention_refs TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    origin TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (flow_id, checklist_id, item_key)
  );

  CREATE TABLE review_mentions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    root_workspace_id TEXT NOT NULL,
    subject_entity_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    artifact_id TEXT NOT NULL,
    chunk_id TEXT,
    quote TEXT NOT NULL,
    quote_hash TEXT NOT NULL,
    published_at TEXT,
    rating REAL,
    polarity TEXT NOT NULL,
    flow_type_id TEXT,
    check_key TEXT,
    attribution_confidence REAL NOT NULL,
    task_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX review_mentions_quote ON review_mentions (root_workspace_id, subject_entity_id, quote_hash);

  CREATE TABLE flow_verdicts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    flow_type_id TEXT NOT NULL,
    flow_a_id TEXT NOT NULL,
    flow_b_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    persona_version INTEGER NOT NULL,
    stage TEXT NOT NULL,
    winner TEXT NOT NULL,
    strength INTEGER NOT NULL,
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    agent_run_id TEXT,
    superseded_by_id TEXT,
    created_at TEXT NOT NULL,
    CHECK (flow_a_id < flow_b_id)
  );
  CREATE INDEX flow_verdicts_type ON flow_verdicts (workspace_id, flow_type_id);
  CREATE INDEX flow_verdicts_a ON flow_verdicts (flow_a_id);
  CREATE INDEX flow_verdicts_b ON flow_verdicts (flow_b_id);

  CREATE TABLE flow_overrides (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    flow_type_id TEXT NOT NULL,
    winner_flow_id TEXT NOT NULL,
    loser_flow_id TEXT NOT NULL,
    reason TEXT,
    actor TEXT NOT NULL DEFAULT 'local-user',
    needs_confirm INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE flow_rank_snapshots (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    flow_type_id TEXT NOT NULL,
    research_run_id TEXT,
    ranking TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  `,
  // 23: flow ranking for existing schedules (design 2026-11-14-flow-records-and-ranking-design.md §10:
  // a snapshot at the end of each ranking round). Schedules store explicit phase lists; those written
  // before migration 22 never contain `flow_ranking`, so their recurring runs re-walked flows without
  // refreshing verdicts or taking snapshots. Once: `flow_ranking` goes directly after the first
  // `deep_dives` of every schedule whose list is a JSON array of names with `deep_dives` and without
  // `flow_ranking`. Any other shape is left as it is (the CASE keeps json_each off text that is not a
  // JSON array). Pipelines are not touched: a pipeline row is only
  // ever running or finished (there is no not-yet-run pipeline to update).
  `
  UPDATE schedules SET phases = (
    SELECT json_group_array(p.value ORDER BY p.ord) FROM (
      SELECT value, key * 2 AS ord FROM json_each(schedules.phases)
      UNION ALL
      SELECT 'flow_ranking', MIN(key) * 2 + 1 FROM json_each(schedules.phases) WHERE value = 'deep_dives'
    ) p
  )
  WHERE CASE WHEN json_valid(phases) AND json_type(phases) = 'array' THEN
    NOT EXISTS (SELECT 1 FROM json_each(schedules.phases) WHERE type <> 'text')
    AND EXISTS (SELECT 1 FROM json_each(schedules.phases) WHERE value = 'deep_dives')
    AND NOT EXISTS (SELECT 1 FROM json_each(schedules.phases) WHERE value = 'flow_ranking')
  ELSE 0 END;
  `,
  // 24: persona learning (design 2026-11-15-persona-learning-design.md §11): accepted persona
  // adjustments (tracking marker, version, status), the proposals the user accepts or rejects (evidence
  // = signal ids) and one learning run per persona and retro (the signals shown to the agent). Per
  // business tree (`root_workspace_id`) and persona. JSON columns (named by the Repo field, as in
  // migration 19): stats, evidence, shown_signal_ids. `persona_version`: the persona version an accepted
  // add or replace made (reactions to output of older versions do not count toward its effect).
  // Repositories: `personas/store.ts`.
  `
  CREATE TABLE persona_adjustments (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    field TEXT,
    marker TEXT NOT NULL,
    text TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    proposal_id TEXT,
    actor TEXT NOT NULL DEFAULT 'local-user',
    stats TEXT NOT NULL DEFAULT '{}',
    internal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    ended_at TEXT,
    persona_version INTEGER
  );
  CREATE UNIQUE INDEX persona_adjustments_marker ON persona_adjustments (marker);
  CREATE INDEX persona_adjustments_persona ON persona_adjustments (root_workspace_id, persona_id);

  CREATE TABLE persona_proposals (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    run_id TEXT,
    action TEXT NOT NULL,
    adjustment_id TEXT,
    field TEXT,
    text TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    stats TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    final_text TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    actor TEXT,
    reason TEXT,
    decision_id TEXT,
    feedback_event_id TEXT
  );
  CREATE INDEX persona_proposals_persona ON persona_proposals (root_workspace_id, persona_id);

  CREATE TABLE persona_learning_runs (
    id TEXT PRIMARY KEY,
    root_workspace_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    retro_id TEXT,
    status TEXT NOT NULL,
    signals_through TEXT NOT NULL,
    shown_signal_ids TEXT NOT NULL DEFAULT '[]',
    stats TEXT NOT NULL DEFAULT '{}',
    assumption TEXT,
    agent_run_id TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX persona_learning_runs_persona ON persona_learning_runs (root_workspace_id, persona_id);
  `,
];
