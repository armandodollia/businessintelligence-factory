import { z } from 'zod';
import { HIGHEST_READ_FLOOR } from '../knowledge/floors.js';

export const PROVIDER_IDS = ['claude', 'codex', 'opencode'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const ROLES = [
  'orchestrator',
  'worker',
  'reviewer',
  'interviewer',
  'persona',
  'synthesizer',
  // WP-D: writes multiple-choice questions for the user when a task ends unverified / failed.
  'escalation',
  // Learning loop WP-E: the weekly retro agent (proposes prompt and calibration edits for the user).
  'retro',
] as const;
export type Role = (typeof ROLES)[number];

export const TASK_TYPES = [
  'audience_segments',
  'persona_profile',
  'discover_competitors',
  'flow_walkthrough',
  // Flow records: public feedback per subject (review mentions)
  'flow_reviews',
  'news_scan',
  'public_filings',
  'customer_pain_points',
  'own_company_audit',
  'symptom_hypotheses',
  'synthesize_recommendations',
  'persona_panel',
  'map_business_units',
  // Stakeholder personas: of the node itself (never with a browser) and of its main competitors
  'own_stakeholders',
  'competitor_stakeholders',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const providerIdSchema = z.enum(PROVIDER_IDS);
export const roleSchema = z.enum(ROLES);
export const taskTypeSchema = z.enum(TASK_TYPES);

export const modelRefSchema = z.strictObject({
  provider: providerIdSchema,
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

const providerSchema = z.strictObject({
  enabled: z.boolean(),
  command: z.string().min(1),
  models: z.array(z.string().min(1)),
});

const loopOverrideSchema = z.strictObject({
  maxRounds: z.number().int().min(1).optional(),
  passThreshold: z.number().min(0).max(10).optional(),
});

/** Explicit per-task-type shape so the inferred type is `Partial<Record<TaskType, T>>`. */
function perTaskType<T extends z.ZodType>(item: T) {
  const opt = item.optional();
  return z.strictObject({
    audience_segments: opt,
    persona_profile: opt,
    discover_competitors: opt,
    flow_walkthrough: opt,
    flow_reviews: opt,
    news_scan: opt,
    public_filings: opt,
    customer_pain_points: opt,
    own_company_audit: opt,
    symptom_hypotheses: opt,
    synthesize_recommendations: opt,
    persona_panel: opt,
    map_business_units: opt,
    own_stakeholders: opt,
    competitor_stakeholders: opt,
  });
}

/**
 * The shared browser MCP server. `args` / `env` placeholders: `{{port}}`, `{{profileDir}}` (absolute
 * `browser.profileDir`), `{{outputDir}}` (a directory under the OS temp dir, so agents can hand the
 * files to `save_artifact`). `port: 0` picks a free port at start. Runs connect to
 * `http://127.0.0.1:<port><path>`.
 */
export const sharedBrowserSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()),
  port: z.number().int().min(0).max(65535),
  path: z.string().startsWith('/').default('/mcp'),
  env: z.record(z.string(), z.string()).optional(),
});

/** Pinned Playwright MCP shared on one persistent research profile (`--shared-browser-context`). */
export const PLAYWRIGHT_SHARED_BROWSER: z.output<typeof sharedBrowserSchema> = {
  command: 'npx',
  args: [
    '-y', '@playwright/mcp@0.0.85',
    '--host', '127.0.0.1', '--port', '{{port}}',
    '--shared-browser-context',
    '--user-data-dir', '{{profileDir}}',
    '--output-dir', '{{outputDir}}',
    '--file-paths', 'absolute',
  ],
  port: 0,
  path: '/mcp',
};

// --- learning loop WP-B: budgets -------------------------------------------------------------
/** A token and/or cost cap (either may be omitted). Tokens = input + output + cache read + cache write. */
export const budgetCapSchema = z.strictObject({
  maxTokens: z.number().int().min(1).optional(),
  maxCostUsd: z.number().positive().optional(),
});
/**
 * Optional spend caps (spec §5 "budgets"). `workspace`: total spend of each workspace;
 * `pipeline`: spend of each research pipeline. Past a cap the supervisor starts no new run and asks
 * the user (a `user_request`) to extend it by one more cap; denying stops new runs for that scope
 * until the cap is raised in config.
 */
export const budgetsSchema = z.strictObject({
  workspace: budgetCapSchema.optional(),
  pipeline: budgetCapSchema.optional(),
});
export type BudgetCap = z.infer<typeof budgetCapSchema>;
// --- end WP-B budgets --------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// WP-D (learning loop): escalation and telemetry settings. Both blocks are optional; read them
// through `escalationSettings` / `telemetrySettings`, which apply the defaults.

export const escalationConfigSchema = z.strictObject({
  /** Run the escalation agent when a task ends unverified / failed. Default true. */
  enabled: z.boolean().optional(),
  /** Model of the escalation agent. Default `roles.orchestrator`. */
  model: modelRefSchema.optional(),
  /** Questions per escalation (0–3). Default 3. */
  maxQuestions: z.number().int().min(0).max(3).optional(),
  /** Escalations per task (each fully answered one re-runs the task). Default 2. */
  maxPerTask: z.number().int().min(0).optional(),
});

export const otlpConfigSchema = z.strictObject({
  enabled: z.boolean(),
  /** OTLP/HTTP base URL; logs go to `<endpoint>/v1/logs`. Default `http://127.0.0.1:4318`. */
  endpoint: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Default `bif`. */
  serviceName: z.string().min(1).optional(),
});

export const telemetryConfigSchema = z.strictObject({
  /** Days `bus_events` rows are kept; 0 keeps them forever. Default 30. */
  busEventRetentionDays: z.number().int().min(0).optional(),
  /** Optional OTLP/HTTP (JSON) log export of the event bus. Off by default. */
  otlp: otlpConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Learning loop WP-E: lessons engine and weekly retro. Optional; read it through `lessonsSettings`
// (src/core/learning/lessons/settings.ts), which applies the defaults.

export const lessonsConfigSchema = z.strictObject({
  /** Lessons engine and retro proposals (default true). Accepted rules stay in prompts until retired. */
  enabled: z.boolean().optional(),
  /** Distinct tasks a signal category must recur in before a rule is proposed (default 3). */
  minTasks: z.number().int().min(1).optional(),
  /** Consecutive clean tasks under a rule before its retirement is proposed (default 10). */
  retireAfterCleanTasks: z.number().int().min(1).optional(),
  /** Tasks under a rule's current version before its effect is judged (revert; default 5). */
  minEffectTasks: z.number().int().min(1).optional(),
  /** Active rules (plus pending additions) per role and business tree (default 15). */
  maxRulesPerRole: z.number().int().min(1).max(15).optional(),
  retro: z
    .strictObject({
      /** Weekly retro per business tree (default true). */
      enabled: z.boolean().optional(),
      /** When it runs (default `0 6 * * 1`, Mondays 06:00 server time). */
      cron: z.string().min(1).optional(),
      /** Model of the retro agent (default `roles.orchestrator`). */
      model: modelRefSchema.optional(),
      /** Days of history a retro digests when there was no earlier retro (default 7). */
      windowDays: z.number().int().min(1).optional(),
      /** Proposals one retro may make (default 5). */
      maxProposals: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
});
// --- end learning loop WP-E config ---------------------------------------------------------------

// ---------------------------------------------------------------------------
// Knowledge store KS-0: `config.knowledge` (design 2026-11-13-knowledge-store-design.md §16).
// Optional; every field defaulted. Read it through `knowledgeSettings` (src/core/knowledge/config.ts),
// which applies `KNOWLEDGE_DEFAULTS`.

/** Kinds of knowledge-store entities (design §7). */
export const ENTITY_KINDS = [
  'company', 'competitor', 'product', 'feature', 'flow', 'persona', 'segment', 'pain_point', 'symptom', 'cause', 'topic',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const entityKindSchema = z.enum(ENTITY_KINDS);

/** Response budgets per kind of read (tokens). `read_artifact` uses `expand`, `list_changes` uses `search`. */
export const KNOWLEDGE_BUDGET_KINDS = ['search', 'card', 'expand', 'briefing'] as const;
export type KnowledgeBudgetKind = (typeof KNOWLEDGE_BUDGET_KINDS)[number];

const budgetTokens = z.number().int().min(1);
export const knowledgeBudgetSetSchema = z.strictObject({
  search: budgetTokens.optional(),
  card: budgetTokens.optional(),
  expand: budgetTokens.optional(),
  briefing: budgetTokens.optional(),
});

export const knowledgeConfigSchema = z.strictObject({
  budgets: z
    .strictObject({
      default: knowledgeBudgetSetSchema.optional(),
      /** Per-role overrides (merged over `default` per kind). */
      roles: z.partialRecord(roleSchema, knowledgeBudgetSetSchema).optional(),
      /** Per-provider scale (e.g. 0.5 for a CLI with a small tool-output limit). */
      providers: z.partialRecord(providerIdSchema, z.number().positive()).optional(),
    })
    .optional(),
  /**
   * Cap on any single knowledge response, whatever the caller asks. At least the highest read-tool floor
   * (a read never answers with less than its floor, so a smaller cap could not hold).
   */
  hardMaxTokens: budgetTokens
    .min(HIGHEST_READ_FLOOR, `must be at least ${HIGHEST_READ_FLOOR}: the highest read-tool floor (a knowledge read never returns less than its floor)`)
    .optional(),
  freshness: z
    .strictObject({
      defaultDays: z.number().int().min(1).optional(),
      byEntityKind: z.partialRecord(entityKindSchema, z.number().int().min(1)).optional(),
    })
    .optional(),
  extraction: z
    .strictObject({
      maxTextChars: z.number().int().min(1).optional(),
      chunkTokens: z.number().int().min(1).optional(),
      maxChunkTokens: z.number().int().min(1).optional(),
      xlsxMaxRows: z.number().int().min(1).optional(),
      /** Artifacts up to this size are extracted inline at save; larger ones are queued. */
      inlineMaxBytes: z.number().int().min(0).optional(),
      concurrency: z.number().int().min(1).optional(),
    })
    .optional(),
  captions: z
    .strictObject({
      /** Agents must describe image artifacts when saving them. */
      required: z.boolean().optional(),
      minChars: z.number().int().min(0).optional(),
    })
    .optional(),
  dedupe: z
    .strictObject({
      /** Duplicate-handshake candidates returned to the saving agent. */
      candidateLimit: z.number().int().min(1).max(20).optional(),
      /**
       * Minimum similarity (0–1) for a candidate (KS-2): Jaccard overlap of the word-token sets of the
       * two normalized claims, |A ∩ B| / |A ∪ B| (`claimSimilarity`, knowledge/facts.ts). bm25 is
       * unbounded and corpus-dependent, so it only selects which facts are compared.
       */
      similarityFloor: z.number().min(0).max(1).optional(),
    })
    .optional(),
  retention: z
    .strictObject({
      /** Prune never touches artifacts younger than this. */
      pruneMinAgeDays: z.number().int().min(0).optional(),
    })
    .optional(),
  /**
   * Two-pass OCR. Pass 1 is rules (no model): a PDF page with a usable text layer is settled. Pass 2
   * sends what is left (image-only PDF pages, images) to a small model through the Claude CLI
   * (`providers.claude`); it runs only when that provider is enabled.
   */
  ocr: z
    .strictObject({
      enabled: z.boolean().optional(),
      /** Model of the Claude CLI for pass 2 (alias or full name). */
      model: z.string().min(1).optional(),
      /** Images read by the model: uploads only, every image (agent screenshots too), or none. */
      images: z.enum(['uploads', 'all', 'none']).optional(),
      /** A PDF page with fewer non-space characters than this has no text layer worth keeping. */
      minPageChars: z.number().int().min(1).optional(),
      /** Pages of one document read by the model; the rest stay unread (the artifact says how many). */
      maxPages: z.number().int().min(1).max(100).optional(),
      /** Pages asked for in one model call. */
      pagesPerCall: z.number().int().min(1).max(20).optional(),
      /** Files larger than this are never sent (images are also capped at 5 MB). */
      maxFileBytes: z.number().int().min(1).max(20_000_000).optional(),
      timeoutSeconds: z.number().int().min(5).optional(),
      /** Model calls running at once. */
      concurrency: z.number().int().min(1).max(10).optional(),
      /** How long the queue waits after a rate limit before trying again. */
      rateLimitPauseMinutes: z.number().int().min(1).optional(),
    })
    .optional(),
});
export type KnowledgeConfig = z.infer<typeof knowledgeConfigSchema>;

/** Defaults of `config.knowledge` (design §8.2, §8.3, §9, §16). */
export const KNOWLEDGE_DEFAULTS = {
  budgets: {
    default: { search: 1200, card: 800, expand: 2000, briefing: 1500 },
    roles: { reviewer: { expand: 3000 }, synthesizer: { briefing: 4000 } },
    providers: {},
  },
  hardMaxTokens: 8000,
  freshness: { defaultDays: 90, byEntityKind: {} },
  extraction: {
    maxTextChars: 2_000_000,
    chunkTokens: 400,
    maxChunkTokens: 600,
    xlsxMaxRows: 2000,
    inlineMaxBytes: 1_048_576,
    concurrency: 1,
  },
  captions: { required: true, minChars: 20 },
  dedupe: { candidateLimit: 3, similarityFloor: 0.5 },
  retention: { pruneMinAgeDays: 90 },
  ocr: {
    enabled: true,
    model: 'haiku',
    images: 'all',
    minPageChars: 40,
    maxPages: 30,
    pagesPerCall: 8,
    maxFileBytes: 20_000_000,
    timeoutSeconds: 180,
    concurrency: 2,
    rateLimitPauseMinutes: 15,
  },
} as const;
// --- end knowledge store KS-0 config ---------------------------------------------------------

// --- learning loop wave 2, ruling R4: experiments ------------------------------------------------
/** `config.experiments` (optional). */
export const experimentsConfigSchema = z.strictObject({
  /**
   * Allow experiments on tasks that use the browser (default false). Real-world actions such a task
   * takes repeat once per arm and per repeat; when allowed, each start must also confirm it.
   */
  allowBrowser: z.boolean().optional(),
});
// --- end ruling R4 ---------------------------------------------------------------------------------

// --- learning loop WP-F: reviewer audits --------------------------------------------------------
/** `config.audit` (optional): who audits verified tasks, and how many per audit by default. */
export const auditConfigSchema = z.strictObject({
  /**
   * Auditor model. Used when it differs from the original reviewer's model; otherwise (and when
   * unset) the auditor is the first model of another enabled provider (cross-provider), else another
   * model of the same provider (`auditModelFor`, learning/reviewerAudit.ts).
   */
  model: modelRefSchema.optional(),
  /** Tasks re-reviewed per audit when the caller gives no N. Default 5. */
  n: z.number().int().min(1).max(50).optional(),
});
// --- end WP-F config ---------------------------------------------------------------------------

// --- flow records and flow ranking (design 2026-11-14 §15) -----------------------------------------
/** `config.flows` (optional; every field defaulted). Read it through `flowsSettings` (flows/config.ts). */
export const flowsConfigSchema = z.strictObject({
  /** Rank scores closer than this (points, 0–100) are ordered by their direct head-to-head (default 5). */
  tieMargin: z.number().min(0).max(100).optional(),
  /** Distinct negative mentions that make a review-answered check `reported_problem` (default 3). */
  minMentionsForCheck: z.number().int().min(1).optional(),
  /** Mentions older than this many days are shown but not counted (default 365). */
  mentionWindowDays: z.number().int().min(1).optional(),
  /** Mentions attributed with less confidence are shown but not counted (default 0.6). */
  minAttributionConfidence: z.number().min(0).max(1).optional(),
  /** Focused (stage 2) head-to-heads per ranking round (default 20). */
  maxFocusedComparisons: z.number().int().min(0).optional(),
  /** A broad verdict below this confidence gets a focused head-to-head (default 0.5). */
  lowConfidence: z.number().min(0).max(1).optional(),
  /**
   * Flows one broad (stage 1) persona run reads at once (default 8). At most 20: 20 flows make 190
   * pairs, within the 200 verdicts one `submit_flow_verdicts` call takes.
   */
  maxFlowsPerSitting: z.number().int().min(2).max(20).optional(),
  /** Model of verdict runs (default `roles.persona`). */
  model: modelRefSchema.optional(),
  /** Coverage of a flow type judged on the general checklist alone (default 0.3). */
  generalCoverage: z.number().min(0).max(1).optional(),
});

/** Defaults of `config.flows` (`model` has none here: it falls back to `roles.persona` at use). */
export const FLOWS_DEFAULTS = {
  tieMargin: 5,
  minMentionsForCheck: 3,
  mentionWindowDays: 365,
  minAttributionConfidence: 0.6,
  maxFocusedComparisons: 20,
  lowConfidence: 0.5,
  maxFlowsPerSitting: 8,
  generalCoverage: 0.3,
} as const;
// --- end flows config ----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Persona learning (design 2026-11-15-persona-learning-design.md §12): the user's reactions to
// simulated personas become proposed persona adjustments in the weekly retro. Optional; read it
// through `personaLearningSettings` (src/core/personas/settings.ts), which applies the defaults.

export const personaLearningConfigSchema = z.strictObject({
  /** Persona learning in the retro (default true). */
  enabled: z.boolean().optional(),
  /** Signals a persona needs before the retro looks at it (default 6). */
  minSignals: z.number().int().min(1).optional(),
  /** Distinct items those signals must cover (default 4). */
  minDistinctItems: z.number().int().min(1).optional(),
  /** Lower bound of the disagree rate a persona must reach (default 0.3). */
  disagreeFloor: z.number().min(0).max(1).optional(),
  /** Days of signals read (default 180). */
  windowDays: z.number().int().min(1).optional(),
  /** Personas one retro may look at (default 5). */
  maxPersonasPerRetro: z.number().int().min(1).optional(),
  /** Proposals per persona and retro (default 3). */
  maxProposalsPerPersona: z.number().int().min(0).max(5).optional(),
  /** Signals a proposal must cite (default 3). */
  minEvidence: z.number().int().min(1).optional(),
  /** Active adjustments per persona (default 8). */
  maxAdjustments: z.number().int().min(1).max(20).optional(),
  /** Signals under an adjustment before its effect is judged (default 6). */
  minEffectSignals: z.number().int().min(1).optional(),
  /** Model of the persona learning agent (default: the retro model). */
  model: modelRefSchema.optional(),
});
// --- end persona learning config ---------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stakeholder personas (design 2026-11-15-stakeholder-personas-design.md §13). Optional; read it
// through `stakeholdersSettings` (src/core/stakeholders/settings.ts), which applies the defaults.

export const stakeholdersConfigSchema = z.strictObject({
  /** Stakeholder personas (default true). */
  enabled: z.boolean().optional(),
  /** Own stakeholders per node (default 8). */
  maxOwn: z.number().int().min(1).optional(),
  /** Competitors whose stakeholders are researched (default 3). */
  maxCompetitors: z.number().int().min(1).optional(),
  /** Stakeholders per competitor (default 3). */
  maxPerCompetitor: z.number().int().min(1).optional(),
  /** Stakeholder read runs per persona panel (default 40). */
  maxReadsPerPanel: z.number().int().min(1).optional(),
});
// --- end stakeholders config -----------------------------------------------------------------------

export const bifConfigSchema = z
  .strictObject({
    providers: z.strictObject({
      claude: providerSchema,
      codex: providerSchema,
      opencode: providerSchema,
    }),
    roles: z.strictObject({
      orchestrator: modelRefSchema,
      interviewer: modelRefSchema,
      reviewer: modelRefSchema,
      synthesizer: modelRefSchema,
      persona: modelRefSchema,
      workers: perTaskType(modelRefSchema).extend({ default: modelRefSchema }),
    }),
    loop: z.strictObject({
      maxRounds: z.number().int().min(1),
      passThreshold: z.number().min(0).max(10),
      perTaskType: perTaskType(loopOverrideSchema),
      /**
       * Learning loop WP-C: how many times a reviewer may reassert an issue the worker pushed back on
       * before the dispute is closed (the worker is then told to fix it). Default 1 when unset.
       */
      maxReasserts: z.number().int().min(0).optional(),
    }),
    limits: z.strictObject({
      maxParallelWorkers: z.number().int().min(1),
      maxBrowserRuns: z.number().int().min(0),
      maxTasksPerRun: z.number().int().min(1),
      idleTimeoutMs: z.number().int().min(1),
    }),
    browser: z.strictObject({
      backend: z.enum(['mcp', 't3']),
      /**
       * Backend `mcp` only. `shared` (default): the harness starts `browser.shared` once (lazily)
       * and every browser-using run connects to it over HTTP, so all runs share one browser on the
       * research profile. `per_run`: each run spawns `browser.mcpServers` itself (stdio); runs on
       * one profile directory cannot overlap, so `limits.maxBrowserRuns` is capped at 1.
       */
      mode: z.enum(['shared', 'per_run']).default('shared'),
      /** Shared browser MCP server (HTTP). See `sharedBrowserSchema`. */
      shared: sharedBrowserSchema.optional(),
      /** `per_run` mode: passed to each CLI's MCP config (`{{profileDir}}` substituted). */
      mcpServers: z.record(z.string(), z.unknown()),
      profileDir: z.string().min(1),
    }),
    identity: z.strictObject({
      emailProvider: z.enum(['catchall', 'mailtm']),
      catchallDomain: z.string().min(1).optional(),
    }),
    actionPolicy: z.strictObject({
      allowed: z.array(z.string()),
      approvalRequired: z.array(z.string()),
      never: z.array(z.string()),
    }),
    scoring: z.strictObject({
      personaWeight: z.number().min(0),
      weights: z.record(z.string(), z.number()),
    }),
    server: z.strictObject({
      port: z.number().int().min(1).max(65535),
    }),
    dataDir: z.string().min(1),
    /** Learning loop WP-A: the acting user recorded on every human input (default `local-user`). */
    user: z.strictObject({ id: z.string().trim().min(1) }).optional(),
    /** Learning loop WP-B: optional token/cost caps. */
    budgets: budgetsSchema.optional(),
    // WP-D (learning loop): structured escalations, bus-event persistence, optional OTLP export.
    escalation: escalationConfigSchema.optional(),
    telemetry: telemetryConfigSchema.optional(),
    /** Knowledge store KS-0: budgets, freshness, extraction, captions, dedupe, retention (all defaulted). */
    knowledge: knowledgeConfigSchema.optional(),
    /** Learning loop WP-E: lessons engine and weekly retro (all defaulted). */
    lessons: lessonsConfigSchema.optional(),
    /** Learning loop WP-F: reviewer audit model and default size. */
    audit: auditConfigSchema.optional(),
    /** Ruling R4: experiments on browser tasks (off by default). */
    experiments: experimentsConfigSchema.optional(),
    /** Flow records and flow ranking: thresholds, caps and the verdict model (all defaulted). */
    flows: flowsConfigSchema.optional(),
    /** Persona learning: gates, caps and the model (all defaulted). */
    personaLearning: personaLearningConfigSchema.optional(),
    /** Stakeholder personas: on / off and caps (all defaulted). */
    stakeholders: stakeholdersConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    // Every role model must be an allowed model of an enabled provider.
    const check = (ref: ModelRef | undefined, path: (string | number)[]) => {
      if (!ref) return;
      const p = cfg.providers[ref.provider];
      if (!p.enabled) {
        ctx.addIssue({ code: 'custom', path, message: `provider '${ref.provider}' is not enabled` });
      } else if (!p.models.includes(ref.model)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `model '${ref.model}' is not in providers.${ref.provider}.models`,
        });
      }
    };
    for (const role of ['orchestrator', 'interviewer', 'reviewer', 'synthesizer', 'persona'] as const) {
      check(cfg.roles[role], ['roles', role]);
    }
    for (const [key, ref] of Object.entries(cfg.roles.workers)) {
      check(ref as ModelRef | undefined, ['roles', 'workers', key]);
    }
    check(cfg.escalation?.model, ['escalation', 'model']); // WP-D
    check(cfg.lessons?.retro?.model, ['lessons', 'retro', 'model']); // learning loop WP-E
    check(cfg.audit?.model, ['audit', 'model']); // WP-F
    check(cfg.flows?.model, ['flows', 'model']); // flow ranking
    check(cfg.personaLearning?.model, ['personaLearning', 'model']); // persona learning
    // Knowledge store KS-0: chunk target must not exceed the chunk cap (after defaults).
    const ex = cfg.knowledge?.extraction;
    if (ex && (ex.chunkTokens ?? KNOWLEDGE_DEFAULTS.extraction.chunkTokens) > (ex.maxChunkTokens ?? KNOWLEDGE_DEFAULTS.extraction.maxChunkTokens)) {
      ctx.addIssue({ code: 'custom', path: ['knowledge', 'extraction', 'chunkTokens'], message: 'must not exceed maxChunkTokens' });
    }
    if (cfg.identity.emailProvider === 'catchall' && !cfg.identity.catchallDomain) {
      ctx.addIssue({
        code: 'custom',
        path: ['identity', 'catchallDomain'],
        message: "required when emailProvider is 'catchall'",
      });
    }
  });

export type BifConfig = z.infer<typeof bifConfigSchema>;

/** Action policy from spec §6.6. Lives in config and in every worker prompt. */
export const defaultActionPolicy: BifConfig['actionPolicy'] = {
  allowed: [
    'browse',
    'sign up with a disposable identity',
    'accept standard terms of service for those signups',
    'start free trials that need no payment card',
    'walk checkout up to (not including) payment',
  ],
  approvalRequired: [
    'enter payment details (the user enters them personally; agents never see or store card data)',
    'request a demo',
    'contact sales, support, or anything that reaches a real person',
  ],
  never: ['complete a purchase'],
};

export const defaultConfig: BifConfig = {
  providers: {
    claude: { enabled: true, command: 'claude', models: ['opus', 'sonnet', 'haiku'] },
    codex: { enabled: true, command: 'codex', models: ['gpt-6.1-sol'] },
    opencode: { enabled: false, command: 'opencode', models: [] },
  },
  roles: {
    orchestrator: { provider: 'claude', model: 'opus' },
    interviewer: { provider: 'claude', model: 'opus' },
    reviewer: { provider: 'codex', model: 'gpt-6.1-sol' },
    synthesizer: { provider: 'claude', model: 'opus' },
    persona: { provider: 'claude', model: 'sonnet' },
    workers: { default: { provider: 'claude', model: 'sonnet' } },
  },
  loop: { maxRounds: 3, passThreshold: 8, perTaskType: {} },
  limits: { maxParallelWorkers: 3, maxBrowserRuns: 2, maxTasksPerRun: 30, idleTimeoutMs: 600000 },
  browser: {
    backend: 'mcp',
    mode: 'shared',
    shared: PLAYWRIGHT_SHARED_BROWSER,
    mcpServers: {},
    profileDir: 'data/browser-profile',
  },
  identity: { emailProvider: 'mailtm' },
  actionPolicy: defaultActionPolicy,
  scoring: { personaWeight: 0, weights: {} },
  server: { port: 4317 },
  dataDir: 'data',
};
