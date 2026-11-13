import { z } from 'zod';

export const PROVIDER_IDS = ['claude', 'codex', 'opencode'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const ROLES = [
  'orchestrator',
  'worker',
  'reviewer',
  'interviewer',
  'persona',
  'synthesizer',
] as const;
export type Role = (typeof ROLES)[number];

export const TASK_TYPES = [
  'audience_segments',
  'persona_profile',
  'discover_competitors',
  'flow_walkthrough',
  'news_scan',
  'public_filings',
  'customer_pain_points',
  'own_company_audit',
  'symptom_hypotheses',
  'synthesize_recommendations',
  'persona_panel',
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
    news_scan: opt,
    public_filings: opt,
    customer_pain_points: opt,
    own_company_audit: opt,
    symptom_hypotheses: opt,
    synthesize_recommendations: opt,
    persona_panel: opt,
  });
}

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
    }),
    limits: z.strictObject({
      maxParallelWorkers: z.number().int().min(1),
      maxBrowserRuns: z.number().int().min(0),
      maxTasksPerRun: z.number().int().min(1),
      idleTimeoutMs: z.number().int().min(1),
    }),
    browser: z.strictObject({
      backend: z.enum(['mcp', 't3']),
      /** Passed verbatim to each CLI's MCP config. */
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
  browser: { backend: 'mcp', mcpServers: {}, profileDir: 'data/browser-profile' },
  identity: { emailProvider: 'mailtm' },
  actionPolicy: defaultActionPolicy,
  scoring: { personaWeight: 0, weights: {} },
  server: { port: 4317 },
  dataDir: 'data',
};
