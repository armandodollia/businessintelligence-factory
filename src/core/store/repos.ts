import { randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type {
  AgentRun,
  Artifact,
  Competitor,
  Decision,
  Finding,
  Identity,
  InterviewTurn,
  PanelRead,
  Persona,
  Pipeline,
  Profile,
  Rating,
  Recommendation,
  ResearchRun,
  Schedule,
  Symptom,
  SymptomHypothesis,
  Task,
  UnitProposal,
  UserRequest,
  Workspace,
} from '../types.js';
// Knowledge store KS-0 (migration 18): see the delimited block at the end of this file.
import type {
  ArtifactCapture,
  ArtifactText,
  OcrRun,
  Entity,
  EntityMergeSuggestion,
  FactObservation,
  FindingEvidence,
  ItemScope,
  Relation,
  RetrievalEvent,
  RetrievalUse,
  TextChunk,
} from '../types.js';

// ---------------------------------------------------------------------------
// ids

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID-like id: `<prefix>_` + 10 chars of ms timestamp + 16 random chars (Crockford base32). */
export function newId(prefix: string): string {
  let time = Date.now();
  let ts = '';
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[time % 32] + ts;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return `${prefix}_${ts}${rand}`;
}

// ---------------------------------------------------------------------------
// generic repository

/**
 * Column encodings. `json` → TEXT via JSON.stringify (`null` → `'null'`, `undefined` → SQL NULL);
 * `bool` → INTEGER 0/1;
 * `any` → untyped column preserving number vs string.
 */
export type ColType = 'text' | 'int' | 'real' | 'bool' | 'json' | 'any';

/** `nullable`: SQL NULL reads back as `null` instead of omitting the property. */
export type FieldSpec = ColType | { type: ColType; nullable: true };

export interface TableSpec<T> {
  table: string;
  key: keyof T & string;
  fields: { [P in keyof T]-?: FieldSpec };
}

type ScalarKeys<T> = {
  [P in keyof T]-?: [NonNullable<T[P]>] extends [string | number | boolean] ? P : never;
}[keyof T];

/** Equality filter over top-level scalar fields; `undefined` entries are ignored. */
export type Filter<T> = { [P in ScalarKeys<T>]?: T[P] | null };

export class StoreNotFoundError extends Error {
  constructor(table: string, id: string) {
    super(`${table}: row '${id}' not found`);
    this.name = 'StoreNotFoundError';
  }
}

const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const colType = (f: FieldSpec): ColType => (typeof f === 'string' ? f : f.type);
const SCALAR: ReadonlySet<ColType> = new Set(['text', 'int', 'real', 'bool', 'any']);

export class Repo<T, K extends keyof T & string> {
  private readonly cols: Record<string, string>;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly spec: TableSpec<T> & { key: K },
  ) {
    this.cols = Object.fromEntries(Object.keys(spec.fields).map((f) => [f, toSnake(f)]));
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /**
   * `undefined` → SQL NULL (property omitted on read). For `json` columns, `null` is a real
   * value: it is stored as the text `'null'` and reads back as `null`.
   */
  private encode(field: string, value: unknown): SQLInputValue {
    if (value === undefined) return null;
    const spec = this.spec.fields[field as keyof T];
    if (value === null) return colType(spec) === 'json' ? 'null' : null;
    switch (colType(spec)) {
      case 'json':
        return JSON.stringify(value);
      case 'bool':
        return value ? 1 : 0;
      default:
        return value as SQLInputValue;
    }
  }

  private decode(row: Record<string, unknown>): T {
    const out: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(this.spec.fields) as [string, FieldSpec][]) {
      const raw = row[this.cols[field]!];
      if (raw === null || raw === undefined) {
        if (typeof spec !== 'string' && spec.nullable) out[field] = null;
        continue;
      }
      switch (colType(spec)) {
        case 'json':
          out[field] = JSON.parse(raw as string);
          break;
        case 'bool':
          out[field] = raw === 1 || raw === 1n;
          break;
        default:
          out[field] = typeof raw === 'bigint' ? Number(raw) : raw;
      }
    }
    return out as T;
  }

  /**
   * Inserts a row. Fields that are `undefined` are left out of the INSERT, so SQL column defaults
   * apply (NULL for columns without one).
   */
  insert(entity: T): T {
    const e = entity as Record<string, unknown>;
    const fields = Object.keys(this.spec.fields).filter((f) => e[f] !== undefined);
    const sql = `INSERT INTO ${this.spec.table} (${fields.map((f) => this.cols[f]).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
    this.stmt(sql).run(...fields.map((f) => this.encode(f, e[f])));
    return entity;
  }

  get(id: string): T | undefined {
    const row = this.stmt(`SELECT * FROM ${this.spec.table} WHERE ${this.cols[this.spec.key]} = ?`).get(id);
    return row ? this.decode(row as Record<string, unknown>) : undefined;
  }

  /** Sets the given fields; a key present with value `undefined` clears that column. */
  update(id: string, patch: Partial<Omit<T, K>>): T {
    const fields = Object.keys(patch).filter((f) => f !== this.spec.key);
    for (const f of fields) {
      if (!Object.hasOwn(this.cols, f)) throw new Error(`${this.spec.table}: unknown field '${f}'`);
    }
    if (fields.length > 0) {
      const p = patch as Record<string, unknown>;
      const sql = `UPDATE ${this.spec.table} SET ${fields.map((f) => `${this.cols[f]} = ?`).join(', ')} WHERE ${this.cols[this.spec.key]} = ?`;
      const res = this.stmt(sql).run(...fields.map((f) => this.encode(f, p[f])), id);
      if (Number(res.changes) === 0) throw new StoreNotFoundError(this.spec.table, id);
    }
    const row = this.get(id);
    if (!row) throw new StoreNotFoundError(this.spec.table, id);
    return row;
  }

  /** Lists rows in insertion order, filtered by equality on scalar fields. */
  list(filter: Filter<T> = {}): T[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [field, value] of Object.entries(filter)) {
      if (value === undefined) continue;
      const spec = Object.hasOwn(this.spec.fields, field)
        ? (this.spec.fields[field as keyof T] as FieldSpec)
        : undefined;
      if (!spec || !SCALAR.has(colType(spec))) {
        throw new Error(`${this.spec.table}: cannot filter on field '${field}'`);
      }
      if (value === null) {
        where.push(`${this.cols[field]} IS NULL`);
      } else {
        where.push(`${this.cols[field]} = ?`);
        params.push(this.encode(field, value));
      }
    }
    const sql = `SELECT * FROM ${this.spec.table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`;
    return this.stmt(sql)
      .all(...params)
      .map((r) => this.decode(r as Record<string, unknown>));
  }
}

// ---------------------------------------------------------------------------
// table specs (must match migrations.ts)

export const specs = {
  workspaces: {
    table: 'workspaces',
    key: 'id',
    fields: {
      id: 'text', name: 'text', sector: 'text', createdAt: 'text', scope: 'json', audiences: 'json',
      parentWorkspaceId: 'text',
    },
  } satisfies TableSpec<Workspace>,
  artifacts: {
    table: 'artifacts',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', kind: 'text', path: 'text', sha256: 'text', mime: 'text',
      sourceUrl: 'text', title: 'text', flow: 'text', step: 'int', note: 'text', capturedAt: 'text',
      description: 'text', urlKey: 'text', uploadDerived: 'bool', uploadCause: 'text', // KS-0 (migration 18)
    },
  } satisfies TableSpec<Artifact>,
  findings: {
    table: 'findings',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', runId: 'text', taskId: 'text', subject: 'text', claim: 'text',
      criteria: 'json', evidence: 'json', status: 'text', createdAt: 'text', includeInSynthesis: 'bool',
      taskRound: 'int',
      // KS-0 (migration 18)
      lineageId: 'text', version: 'int', replacesId: 'text', lifecycle: 'text', entityId: 'text', firstSeenAt: 'text',
      lastConfirmedAt: 'text', confirmCount: 'int', ttlDays: 'int', uploadDerived: 'bool', lineageConflict: 'bool',
      uploadCause: 'text',
    },
  } satisfies TableSpec<Finding>,
  tasks: {
    table: 'tasks',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', runId: 'text', phase: 'text', type: 'text', brief: 'text',
      subject: 'text', model: 'json', needsBrowser: 'bool', acceptanceCriteria: 'json', status: 'text',
      round: 'int', result: 'json', createdAt: 'text', step: 'text', submittedRound: 'int', reviewIssues: 'json',
      failureReason: 'text',
    },
  } satisfies TableSpec<Task>,
  researchRuns: {
    table: 'research_runs',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', phase: 'text', status: 'text', startedAt: 'text', endedAt: 'text', scheduleId: 'text',
      pipelineId: 'text', failureReason: 'text',
    },
  } satisfies TableSpec<ResearchRun>,
  agentRuns: {
    table: 'agent_runs',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', taskId: 'text', role: 'text', model: 'json', token: 'text',
      status: 'text', exitCode: 'int', startedAt: 'text', endedAt: 'text', promptVersion: 'text', pid: 'int',
      pidStartedAt: 'text', attempts: 'int', failureReason: 'text', round: 'int', taskType: 'text',
    },
  } satisfies TableSpec<AgentRun>,
  decisions: {
    table: 'decisions',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', agentRunId: 'text', role: 'text', model: 'json', kind: 'text',
      payload: 'json', refs: 'json', promptVersion: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<Decision>,
  ratings: {
    table: 'ratings',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', targetType: 'text', targetId: 'text', criterion: 'text',
      agentValue: { type: 'any', nullable: true }, verdict: 'text', userValue: 'any', reason: 'text',
      createdAt: 'text',
      actor: 'text', agentRunId: 'text', promptVersion: 'text', // WP-A (migration 14)
    },
  } satisfies TableSpec<Rating>,
  userRequests: {
    table: 'user_requests',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', agentRunId: 'text', taskId: 'text', kind: 'text', site: 'text',
      details: 'text', status: 'text', response: 'text', createdAt: 'text', taskPriorStatus: 'text',
      resolvedAt: 'text', actor: 'text', // WP-A (migration 14)
      // WP-D (migration 17)
      optionsJson: 'json',
    },
  } satisfies TableSpec<UserRequest>,
  recommendations: {
    table: 'recommendations',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', title: 'text', summary: 'text', criteria: 'json',
      findingIds: 'json', personaFeedback: 'json', priority: 'real', createdAt: 'text', taskId: 'text', status: 'text',
      taskRound: 'int', includeOverride: 'bool',
    },
  } satisfies TableSpec<Recommendation>,
  // Persona panel rounds and baseline (migration 30)
  personaPanelReads: {
    table: 'persona_panel_reads',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', recommendationId: 'text', kind: 'text', personaId: 'text', round: 'int', textHash: 'text',
      agentRunId: 'text', reaction: 'json', createdAt: 'text',
    },
  } satisfies TableSpec<PanelRead>,
  personas: {
    table: 'personas',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', slug: 'text', segment: 'text', profile: 'json',
      agentMdPath: 'text', version: 'int', audience: 'text', taskId: 'text', status: 'text', taskRound: 'int',
      includeOverride: 'bool',
      entityId: 'text', // KS-0 (migration 18)
      // stakeholder personas (migration 25)
      kind: 'text', stakeholderType: 'text', subjectKind: 'text', subjectId: 'text', relation: 'text', disclosure: 'text',
      // stakeholder positions (migration 28)
      leftAt: 'text', leftFrom: 'json', positionTitle: 'text', internalProfile: 'json', publicProfile: 'json', publicTaskId: 'text',
      publicSavedAt: 'text', combinedAt: 'text', publicPosition: 'json',
    },
  } satisfies TableSpec<Persona>,
  symptoms: {
    table: 'symptoms',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', kind: 'text', title: 'text', detail: 'text', criteria: 'json',
      evidence: 'json',
      entityId: 'text', // KS-0 (migration 18)
    },
  } satisfies TableSpec<Symptom>,
  schedules: {
    table: 'schedules',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', name: 'text', cron: 'text', phases: 'json', lastRunAt: 'text',
      activatedAt: 'text', enabled: 'bool',
    },
  } satisfies TableSpec<Schedule>,
  interview: {
    table: 'interview_turns',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', role: 'text', text: 'text', createdAt: 'text',
      agentRunId: 'text', // WP-A (migration 14)
    },
  } satisfies TableSpec<InterviewTurn>,
  profiles: {
    table: 'profiles',
    key: 'workspaceId',
    fields: { workspaceId: 'text', data: 'json' },
  } satisfies TableSpec<Profile>,
  identities: {
    table: 'identities',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', site: 'text', name: 'text', email: 'text', password: 'text',
      emailPassword: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<Identity>,
  unitProposals: {
    table: 'unit_proposals',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', name: 'text', description: 'text', level: 'text', audiences: 'json',
      evidence: 'json', reasoning: 'text', status: 'text', childWorkspaceId: 'text', decisionId: 'text',
      createdAt: 'text',
      decidedAt: 'text', actor: 'text', decisionReason: 'text', originalPayload: 'json', // WP-A (migration 14)
    },
  } satisfies TableSpec<UnitProposal>,
  pipelines: {
    table: 'pipelines',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', phases: 'json', nextIndex: 'int', scheduleId: 'text', status: 'text',
      startedAt: 'text', endedAt: 'text',
    },
  } satisfies TableSpec<Pipeline>,
  competitors: {
    table: 'competitors',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', name: 'text', site: 'text', threat: 'int', directness: 'int', comparison: 'json',
      evidence: 'json', taskId: 'text', createdAt: 'text', updatedAt: 'text', status: 'text', taskRound: 'int',
      includeOverride: 'bool',
      entityId: 'text', // KS-0 (migration 18)
    },
  } satisfies TableSpec<Competitor>,
  symptomHypotheses: {
    table: 'symptom_hypotheses',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', symptomId: 'text', hypothesis: 'text', confidence: 'real', evidence: 'json',
      taskId: 'text', createdAt: 'text', status: 'text', taskRound: 'int', includeOverride: 'bool',
      entityId: 'text', // KS-0 (migration 18)
    },
  } satisfies TableSpec<SymptomHypothesis>,
} as const;

export function createRepos(db: DatabaseSync) {
  return {
    workspaces: new Repo<Workspace, 'id'>(db, specs.workspaces),
    artifacts: new Repo<Artifact, 'id'>(db, specs.artifacts),
    findings: new Repo<Finding, 'id'>(db, specs.findings),
    tasks: new Repo<Task, 'id'>(db, specs.tasks),
    researchRuns: new Repo<ResearchRun, 'id'>(db, specs.researchRuns),
    agentRuns: new Repo<AgentRun, 'id'>(db, specs.agentRuns),
    decisions: new Repo<Decision, 'id'>(db, specs.decisions),
    ratings: new Repo<Rating, 'id'>(db, specs.ratings),
    userRequests: new Repo<UserRequest, 'id'>(db, specs.userRequests),
    recommendations: new Repo<Recommendation, 'id'>(db, specs.recommendations),
    personaPanelReads: new Repo<PanelRead, 'id'>(db, specs.personaPanelReads),
    personas: new Repo<Persona, 'id'>(db, specs.personas),
    symptoms: new Repo<Symptom, 'id'>(db, specs.symptoms),
    schedules: new Repo<Schedule, 'id'>(db, specs.schedules),
    interview: new Repo<InterviewTurn, 'id'>(db, specs.interview),
    profiles: new Repo<Profile, 'workspaceId'>(db, specs.profiles),
    identities: new Repo<Identity, 'id'>(db, specs.identities),
    unitProposals: new Repo<UnitProposal, 'id'>(db, specs.unitProposals),
    pipelines: new Repo<Pipeline, 'id'>(db, specs.pipelines),
    competitors: new Repo<Competitor, 'id'>(db, specs.competitors),
    symptomHypotheses: new Repo<SymptomHypothesis, 'id'>(db, specs.symptomHypotheses),
  };
}

export type Repos = ReturnType<typeof createRepos>;

// ---------------------------------------------------------------------------
// Knowledge store KS-0 (migration 18): repositories of the knowledge-store tables. Kept out of
// `createRepos` (so `Store` and parallel branches are untouched); `knowledgeRepos(store)` returns
// one set per database connection. Tables with a composite primary key get a `LinkRepo`
// (insert / list / delete by filter; no get / update by id).

/**
 * Spec of a table with a composite primary key. Key and filter fields must be scalar; `json` columns
 * may hold values (encoded as in `Repo`) but cannot be filtered on.
 */
export interface LinkSpec<T> {
  table: string;
  keys: ReadonlyArray<keyof T & string>;
  fields: { [P in keyof T]-?: FieldSpec };
}

export class LinkRepo<T> {
  private readonly cols: Record<string, string>;
  private readonly inner: Repo<T, keyof T & string>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly spec: LinkSpec<T>,
  ) {
    for (const k of spec.keys) {
      if (!SCALAR.has(colType(spec.fields[k] as FieldSpec))) throw new Error(`${spec.table}: key column '${k}' must be scalar`);
    }
    this.cols = Object.fromEntries(Object.keys(spec.fields).map((f) => [f, toSnake(f)]));
    this.inner = new Repo<T, keyof T & string>(db, { table: spec.table, key: spec.keys[0]!, fields: spec.fields });
  }

  private encode(field: string, v: unknown): SQLInputValue {
    if (v === undefined) return null;
    const t = colType(this.spec.fields[field as keyof T] as FieldSpec);
    if (t === 'json') return JSON.stringify(v);
    if (v === null) return null;
    return t === 'bool' ? (v ? 1 : 0) : (v as SQLInputValue);
  }

  private where(filter: Record<string, unknown>): { sql: string; params: SQLInputValue[] } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [f, v] of Object.entries(filter)) {
      if (v === undefined) continue;
      if (!Object.hasOwn(this.cols, f) || !SCALAR.has(colType(this.spec.fields[f as keyof T] as FieldSpec))) {
        throw new Error(`${this.spec.table}: cannot filter on field '${f}'`);
      }
      if (v === null) where.push(`${this.cols[f]} IS NULL`);
      else {
        where.push(`${this.cols[f]} = ?`);
        params.push(this.encode(f, v));
      }
    }
    return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
  }

  /** Inserts a row; throws on a duplicate key. */
  insert(row: T): T {
    return this.inner.insert(row);
  }

  /** Inserts a row unless its key exists; true when inserted. */
  insertIgnore(row: T): boolean {
    const r = row as Record<string, unknown>;
    const fields = Object.keys(this.spec.fields).filter((f) => r[f] !== undefined);
    const sql = `INSERT OR IGNORE INTO ${this.spec.table} (${fields.map((f) => this.cols[f]).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
    return Number(this.db.prepare(sql).run(...fields.map((f) => this.encode(f, r[f]))).changes) > 0;
  }

  /** Rows in insertion order, filtered by equality. */
  list(filter: Filter<T> = {}): T[] {
    return this.inner.list(filter);
  }

  /** Deletes the rows matching `filter` (at least one field required); returns the count. */
  delete(filter: Filter<T>): number {
    const w = this.where(filter as Record<string, unknown>);
    if (!w.params.length && !w.sql) throw new Error(`${this.spec.table}: delete needs a filter`);
    return Number(this.db.prepare(`DELETE FROM ${this.spec.table}${w.sql}`).run(...w.params).changes);
  }
}

export const knowledgeSpecs = {
  artifactCaptures: {
    table: 'artifact_captures',
    key: 'id',
    fields: {
      id: 'text', artifactId: 'text', workspaceId: 'text', agentRunId: 'text', taskId: 'text', runId: 'text', sourceUrl: 'text',
      urlKey: 'text', title: 'text', flow: 'text', step: 'int', note: 'text', description: 'text', entityId: 'text',
      capturedAt: 'text',
    },
  } satisfies TableSpec<ArtifactCapture>,
  artifactTexts: {
    table: 'artifact_texts',
    key: 'artifactId',
    fields: {
      artifactId: 'text', workspaceId: 'text', status: 'text', extractor: 'text', error: 'text', charCount: 'int',
      tokenEstimate: 'int', contentSha256: 'text', duplicateOf: 'text', extractedAt: 'text',
      ocrStatus: 'text', ocrPlan: 'json', ocrError: 'text', ocrAt: 'text',
    },
  } satisfies TableSpec<ArtifactText>,
  ocrRuns: {
    table: 'ocr_runs',
    key: 'id',
    fields: {
      id: 'text', artifactId: 'text', workspaceId: 'text', target: 'text', pages: 'json', pagesRead: 'int', provider: 'text',
      model: 'text', status: 'text', error: 'text', inputTokens: 'int', outputTokens: 'int', cacheReadTokens: 'int',
      cacheWriteTokens: 'int', costUsd: 'real', cliReportedCostUsd: 'real', priceVersion: 'text', durationMs: 'int', createdAt: 'text',
    },
  } satisfies TableSpec<OcrRun>,
  chunks: {
    table: 'chunks',
    key: 'id',
    fields: {
      id: 'text', artifactId: 'text', workspaceId: 'text', seq: 'int', headingPath: 'text', locator: 'text', text: 'text',
      charStart: 'int', charEnd: 'int', tokenEstimate: 'int', uploadDerived: 'bool',
    },
  } satisfies TableSpec<TextChunk>,
  findingEvidence: {
    table: 'finding_evidence',
    keys: ['findingId', 'seq'],
    fields: {
      findingId: 'text', seq: 'int', artifactId: 'text', chunkId: 'text', quote: 'text', charStart: 'int', charEnd: 'int',
    },
  } satisfies LinkSpec<FindingEvidence>,
  factObservations: {
    table: 'fact_observations',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', lineageId: 'text', findingId: 'text', priorFindingId: 'text', kind: 'text', runId: 'text',
      taskId: 'text', agentRunId: 'text', taskRound: 'int', evidence: 'json', reason: 'text', status: 'text', createdAt: 'text',
      appliedAt: 'text',
    },
  } satisfies TableSpec<FactObservation>,
  itemScopes: {
    table: 'item_scopes',
    keys: ['itemKind', 'itemId', 'workspaceId'],
    fields: { itemKind: 'text', itemId: 'text', workspaceId: 'text', source: 'text' },
  } satisfies LinkSpec<ItemScope>,
  entities: {
    table: 'entities',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', workspaceId: 'text', kind: 'text', name: 'text', nameKey: 'text', aliases: 'json',
      mergedIntoId: 'text', createdByRun: 'text', createdAt: 'text', updatedAt: 'text',
    },
  } satisfies TableSpec<Entity>,
  relations: {
    table: 'relations',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', fromEntityId: 'text', type: 'text', toEntityId: 'text', sourceKind: 'text',
      sourceId: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<Relation>,
  entityMergeSuggestions: {
    table: 'entity_merge_suggestions',
    key: 'id',
    fields: {
      id: 'text', rootWorkspaceId: 'text', entityId: 'text', candidateId: 'text', score: 'real', status: 'text',
      createdAt: 'text', decidedAt: 'text', actor: 'text',
    },
  } satisfies TableSpec<EntityMergeSuggestion>,
  retrievalEvents: {
    table: 'retrieval_events',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', rootWorkspaceId: 'text', agentRunId: 'text', taskId: 'text', role: 'text',
      provider: 'text', model: 'text', promptVersion: 'text', tool: 'text', query: 'text', scope: 'text', resultIds: 'json',
      resultCount: 'int', tokensReturned: 'int', truncated: 'bool', relaxed: 'bool', latencyMs: 'int', uploadDerived: 'bool',
      createdAt: 'text',
    },
  } satisfies TableSpec<RetrievalEvent>,
  retrievalUses: {
    table: 'retrieval_uses',
    keys: ['retrievalEventId', 'itemId', 'usedById'],
    fields: { retrievalEventId: 'text', itemId: 'text', usedByKind: 'text', usedById: 'text', createdAt: 'text' },
  } satisfies LinkSpec<RetrievalUse>,
} as const;

function createKnowledgeRepos(db: DatabaseSync) {
  return {
    artifactCaptures: new Repo<ArtifactCapture, 'id'>(db, knowledgeSpecs.artifactCaptures),
    artifactTexts: new Repo<ArtifactText, 'artifactId'>(db, knowledgeSpecs.artifactTexts),
    chunks: new Repo<TextChunk, 'id'>(db, knowledgeSpecs.chunks),
    ocrRuns: new Repo<OcrRun, 'id'>(db, knowledgeSpecs.ocrRuns),
    findingEvidence: new LinkRepo<FindingEvidence>(db, knowledgeSpecs.findingEvidence),
    factObservations: new Repo<FactObservation, 'id'>(db, knowledgeSpecs.factObservations),
    itemScopes: new LinkRepo<ItemScope>(db, knowledgeSpecs.itemScopes),
    entities: new Repo<Entity, 'id'>(db, knowledgeSpecs.entities),
    relations: new Repo<Relation, 'id'>(db, knowledgeSpecs.relations),
    entityMergeSuggestions: new Repo<EntityMergeSuggestion, 'id'>(db, knowledgeSpecs.entityMergeSuggestions),
    /** Append-only (triggers refuse UPDATE / DELETE). */
    retrievalEvents: new Repo<RetrievalEvent, 'id'>(db, knowledgeSpecs.retrievalEvents),
    retrievalUses: new LinkRepo<RetrievalUse>(db, knowledgeSpecs.retrievalUses),
  };
}

export type KnowledgeRepos = ReturnType<typeof createKnowledgeRepos>;

const knowledgeRepoCache = new WeakMap<DatabaseSync, KnowledgeRepos>();

/** The knowledge-store repositories of a store (one set per database connection). */
export function knowledgeRepos(store: { readonly db: DatabaseSync }): KnowledgeRepos {
  let r = knowledgeRepoCache.get(store.db);
  if (!r) {
    r = createKnowledgeRepos(store.db);
    knowledgeRepoCache.set(store.db, r);
  }
  return r;
}
// --- end knowledge store KS-0 repositories -------------------------------------------------------
