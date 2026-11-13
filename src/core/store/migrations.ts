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
];
