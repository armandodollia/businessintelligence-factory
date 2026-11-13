import { randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type {
  AgentRun,
  Artifact,
  Decision,
  Finding,
  InterviewTurn,
  Persona,
  Profile,
  Rating,
  Recommendation,
  ResearchRun,
  Schedule,
  Symptom,
  Task,
  UserRequest,
  Workspace,
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
 * Column encodings. `json` → TEXT via JSON.stringify; `bool` → INTEGER 0/1;
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

  private encode(field: string, value: unknown): SQLInputValue {
    if (value === undefined || value === null) return null;
    const spec = this.spec.fields[field as keyof T];
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

  insert(entity: T): T {
    const fields = Object.keys(this.spec.fields);
    const sql = `INSERT INTO ${this.spec.table} (${fields.map((f) => this.cols[f]).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
    const e = entity as Record<string, unknown>;
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
    fields: { id: 'text', name: 'text', sector: 'text', createdAt: 'text' },
  } satisfies TableSpec<Workspace>,
  artifacts: {
    table: 'artifacts',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', kind: 'text', path: 'text', sha256: 'text', mime: 'text',
      sourceUrl: 'text', title: 'text', flow: 'text', step: 'int', note: 'text', capturedAt: 'text',
    },
  } satisfies TableSpec<Artifact>,
  findings: {
    table: 'findings',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', runId: 'text', taskId: 'text', subject: 'text', claim: 'text',
      criteria: 'json', evidence: 'json', status: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<Finding>,
  tasks: {
    table: 'tasks',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', runId: 'text', phase: 'text', type: 'text', brief: 'text',
      subject: 'text', model: 'json', needsBrowser: 'bool', acceptanceCriteria: 'json', status: 'text',
      round: 'int', result: 'json', createdAt: 'text',
    },
  } satisfies TableSpec<Task>,
  researchRuns: {
    table: 'research_runs',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', phase: 'text', status: 'text', startedAt: 'text', endedAt: 'text',
    },
  } satisfies TableSpec<ResearchRun>,
  agentRuns: {
    table: 'agent_runs',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', taskId: 'text', role: 'text', model: 'json', token: 'text',
      status: 'text', exitCode: 'int', startedAt: 'text', endedAt: 'text',
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
    },
  } satisfies TableSpec<Rating>,
  userRequests: {
    table: 'user_requests',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', agentRunId: 'text', taskId: 'text', kind: 'text', site: 'text',
      details: 'text', status: 'text', response: 'text', createdAt: 'text',
    },
  } satisfies TableSpec<UserRequest>,
  recommendations: {
    table: 'recommendations',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', title: 'text', summary: 'text', criteria: 'json',
      findingIds: 'json', personaFeedback: 'json', priority: 'real', createdAt: 'text',
    },
  } satisfies TableSpec<Recommendation>,
  personas: {
    table: 'personas',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', slug: 'text', segment: 'text', profile: 'json',
      agentMdPath: 'text', version: 'int',
    },
  } satisfies TableSpec<Persona>,
  symptoms: {
    table: 'symptoms',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', kind: 'text', title: 'text', detail: 'text', criteria: 'json',
      evidence: 'json',
    },
  } satisfies TableSpec<Symptom>,
  schedules: {
    table: 'schedules',
    key: 'id',
    fields: {
      id: 'text', workspaceId: 'text', name: 'text', cron: 'text', phases: 'json', lastRunAt: 'text',
      enabled: 'bool',
    },
  } satisfies TableSpec<Schedule>,
  interview: {
    table: 'interview_turns',
    key: 'id',
    fields: { id: 'text', workspaceId: 'text', role: 'text', text: 'text', createdAt: 'text' },
  } satisfies TableSpec<InterviewTurn>,
  profiles: {
    table: 'profiles',
    key: 'workspaceId',
    fields: { workspaceId: 'text', data: 'json' },
  } satisfies TableSpec<Profile>,
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
    personas: new Repo<Persona, 'id'>(db, specs.personas),
    symptoms: new Repo<Symptom, 'id'>(db, specs.symptoms),
    schedules: new Repo<Schedule, 'id'>(db, specs.schedules),
    interview: new Repo<InterviewTurn, 'id'>(db, specs.interview),
    profiles: new Repo<Profile, 'workspaceId'>(db, specs.profiles),
  };
}

export type Repos = ReturnType<typeof createRepos>;
