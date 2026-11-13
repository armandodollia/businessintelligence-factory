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
];
