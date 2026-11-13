import { z } from 'zod';
import { entityKindSchema, modelRefSchema, taskTypeSchema } from '../../config/schema.js';
// knowledge store KS-3
import { RELATION_TYPES } from '../../knowledge/relations.js';
import { PERSONA_FIELDS, type PersonaField } from '../../scoring/criteria.js';
import type { Role } from '../../types.js';

export const TOOL_NAMES = [
  'log_decision',
  'save_artifact',
  'read_artifact',
  'save_finding',
  'submit_result',
  'submit_review',
  'respond_to_review',
  'request_user_action',
  'request_approval',
  'propose_tasks',
  'get_identity',
  'save_persona',
  'submit_persona_feedback',
  'update_profile',
  'save_symptom',
  'save_recommendation',
  'read_workspace',
  'propose_business_unit',
  'save_competitor',
  'save_hypothesis',
  // WP-D
  'submit_escalation',
  // Knowledge store KS-1
  'describe_artifact',
  // Knowledge store KS-2: living facts
  'confirm_finding',
  'retract_finding',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const BASE: ToolName[] = ['log_decision', 'save_artifact', 'request_user_action', 'request_approval'];

/**
 * Which harness tools each role sees (`tools/list`) and may call. `read_artifact` is tree-scoped
 * (same business tree only). Reviewers get no `read_workspace`: they judge the deliverable and its
 * evidence, not the rest of the tree.
 */
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  worker: [
    ...BASE, 'save_finding', 'submit_result', 'respond_to_review', 'get_identity', 'save_persona',
    'read_workspace', 'propose_business_unit', 'read_artifact', 'save_competitor', 'save_hypothesis',
    'confirm_finding', 'retract_finding', // KS-2
  ],
  orchestrator: [...BASE, 'propose_tasks', 'read_workspace', 'read_artifact'],
  reviewer: ['log_decision', 'submit_review', 'read_artifact'],
  persona: ['log_decision', 'submit_persona_feedback'],
  interviewer: ['log_decision', 'update_profile', 'save_symptom', 'read_workspace', 'read_artifact'],
  synthesizer: [
    ...BASE, 'save_recommendation', 'save_finding', 'submit_result', 'respond_to_review', 'read_workspace', 'read_artifact',
  ],
  // WP-D: the escalation agent only reads evidence and asks the user multiple-choice questions.
  escalation: ['log_decision', 'read_artifact', 'submit_escalation'],
};

// --- Knowledge store KS-1: describe_artifact (design §9) ------------------------------------------
for (const role of ['worker', 'orchestrator', 'interviewer', 'synthesizer'] as const) ROLE_TOOLS[role].push('describe_artifact');
// --- end KS-1 ------------------------------------------------------------------------------------

export const ISSUE_CLASSES = ['blocking', 'substantive', 'nit', 'scope_expansion'] as const;
export type IssueClass = (typeof ISSUE_CLASSES)[number];

const id = z.string().min(1);
const criteria = z.record(z.string(), z.union([z.number(), z.string()]));
const score15 = z.number().min(1).max(5);

/** One persona profile field: value, confidence 0–1, ≥ 1 evidence artifact (fields may share artifacts). */
const personaField = z.object({
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(id).min(1, 'each persona field needs at least one evidence artifact'),
});
const personaProfileShape = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, personaField])) as {
  [K in PersonaField]: typeof personaField;
};

// --- knowledge store KS-3: entity references (design §7.4, §9) ---
/** An entity of this business tree: `{ id }`, or `{ kind, name }` (resolved by name or alias, else created). */
const entityRefInput = z.union([
  z.strictObject({ id: id.describe('Entity id from a search, card or earlier save') }),
  z.strictObject({ kind: entityKindSchema, name: z.string().min(1) }),
]);
const findingRelationInput = z.strictObject({
  type: z.enum(RELATION_TYPES),
  to: entityRefInput.describe('The other entity'),
});
// --- end knowledge store KS-3 ---

// ---------------------------------------------------------------------------
// input schemas (snake_case, as agents see them)

export const toolInputSchemas = {
  log_decision: z.object({
    what: z.string().min(1).describe('The decision taken'),
    why: z.string().min(1).describe('Reasoning behind it'),
    alternatives: z.array(z.string()).default([]).describe('Options considered and not taken'),
    signals_positive: z.array(z.string()).default([]),
    signals_negative: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).describe('0–1'),
    refs: z.array(id).default([]).describe('Ids of artifacts/findings/tasks this decision concerns'),
  }),
  save_artifact: z
    .object({
      kind: z.enum(['screenshot', 'page_snapshot', 'document', 'text']),
      mime: z.string().min(1).describe('e.g. image/png, text/html, text/plain, application/pdf'),
      content: z.string().optional().describe('UTF-8 content (text, HTML, markdown)'),
      content_base64: z.string().optional().describe('Binary content, base64-encoded'),
      file_path: z
        .string()
        .optional()
        .describe('Absolute path of a local file to store (e.g. a screenshot); must be inside your working directory or the OS temp dir'),
      source_url: z.string().optional(),
      title: z.string().optional(),
      flow: z.string().optional().describe('Flow name for walkthroughs, e.g. signup'),
      step: z.number().int().min(0).optional().describe('Step index within the flow'),
      note: z.string().optional(),
      // Knowledge store KS-1 (design §8.1, §9)
      description: z
        .string()
        .optional()
        .describe(
          'What is on it that matters: page purpose, visible prices, plan names, button labels, error text. ' +
            'Required for screenshots and images (at least 20 characters)',
        ),
      entity: z
        .union([id, entityRefInput])
        .optional()
        .describe('What the artifact is about: an entity id, { id } or { kind, name } (found or created in this business tree)'),
      applies_to: z
        .array(id)
        .min(1)
        .optional()
        .describe('Workspace ids of this business tree the artifact is about, when not your own node (replaces the default label)'),
    })
    .refine(
      (v) => [v.content, v.content_base64, v.file_path].filter((x) => x !== undefined).length === 1,
      { message: 'provide exactly one of content, content_base64, file_path' },
    ),
  read_artifact: z.object({ artifact_id: id }),
  save_finding: z.object({
    claim: z.string().min(1),
    subject: z.string().min(1).describe('Company / product the claim is about'),
    criteria: criteria.default({}),
    evidence: z.array(id).min(1, 'evidence must reference at least one saved artifact'),
    // Knowledge store KS-2 (design §7.2, §7.3, §9)
    relation: z
      .union([z.literal('new'), z.object({ confirms: id }), z.object({ replaces: id })])
      .optional()
      .describe(
        'How this claim relates to facts already in the store: "new", {"confirms": "<fact id>"} (same claim, still true) or ' +
          '{"replaces": "<fact id>"} (the claim changed). Omit it and likely duplicates are returned instead of saving.',
      ),
    applies_to: z
      .array(id)
      .min(1)
      .optional()
      .describe('Workspace ids of this business tree the fact is about, when not (only) your own node'),
    evidence_refs: z
      .array(
        z.object({
          artifact_id: id,
          chunk_id: id.optional().describe('Passage id, a locator hint'),
          quote: z.string().min(1).max(2000).optional().describe('Exact text from the artifact; verified against its extracted text'),
        }),
      )
      .optional()
      .describe('Citations with optional verified quotes; their artifacts count as evidence'),
    ttl_days: z.number().int().min(1).max(3650).optional().describe('Days after which this fact should be re-checked'),
    // knowledge store KS-3
    entity: entityRefInput
      .optional()
      .describe(
        'What the claim is about: { id } or { kind, name }. Omitted: the subject names it — an existing competitor, persona ' +
          'or company entity of this business with that name or alias, else the company of a unit with that name, else a topic',
      ),
    relations: z
      .array(findingRelationInput)
      .max(10)
      .optional()
      .describe('Typed links this claim asserts from its entity, e.g. { type: "offers", to: { kind: "product", name: "Widget" } }'),
  }),
  confirm_finding: z.object({
    finding_id: id.describe('A current fact of this business tree, saved by earlier work'),
    evidence: z.array(id).min(1, 'cite at least one artifact you saved in this task'),
  }),
  retract_finding: z.object({
    finding_id: id.describe('A current fact of this business tree that is no longer true'),
    reason: z.string().min(1),
    evidence: z.array(id).min(1, 'cite at least one artifact you saved in this task'),
  }),
  submit_result: z
    .record(z.string(), z.unknown())
    .describe('The task deliverable as one JSON object (shape set by the task brief)'),
  submit_review: z.object({
    score: z.number().min(0).max(10).describe('0–10; pass threshold is set by the harness'),
    issues: z
      .array(
        z.object({
          id: z.string().min(1).optional().describe('Assigned by the harness when omitted (I1, I2, ...)'),
          class: z.enum(ISSUE_CLASSES),
          description: z.string().min(1),
          evidence: z.array(id).optional(),
        }),
      )
      .default([]),
    summary: z.string().optional(),
  }),
  respond_to_review: z.object({
    issue_id: z.string().min(1),
    action: z.enum(['fix', 'pushback']),
    reason: z.string().min(1),
  }),
  request_user_action: z.object({
    kind: z.enum(['register', 'login', 'captcha', 'other']),
    site: z.string().min(1),
    instructions: z.string().min(1).describe('What the user must do, step by step'),
  }),
  request_approval: z.object({
    action: z.string().min(1).describe('The gated action, e.g. "request a demo"'),
    site: z.string().min(1),
    details: z.string().min(1),
  }),
  propose_tasks: z.object({
    tasks: z
      .array(
        z.object({
          type: taskTypeSchema,
          brief: z.string().min(1),
          subject: z.string().optional(),
          model: modelRefSchema
            .optional()
            .describe('Omit to use the configured default for the task type (listed in your prompt); set only to override it'),
          needs_browser: z.boolean(),
          acceptance_criteria: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
  }),
  get_identity: z.object({ site: z.string().min(1) }),
  save_persona: z.object({
    segment: z.string().min(1).describe('Audience segment this persona represents'),
    slug: z.string().optional().describe('Stable id (lowercase-dashes); default: derived from segment. Same slug = update'),
    audience: z.enum(['external', 'internal']).describe('external = customers; internal = employees / internal users'),
    profile: z.object(personaProfileShape).describe('Every persona field, each with value, confidence 0–1 and evidence'),
  }),
  submit_persona_feedback: z.object({
    recommendation_id: id,
    /** Spec §8b: each score is on a 1–5 scale. */
    scores: z.object({
      appeal: z.number().min(1).max(5),
      adoption: z.number().min(1).max(5),
      willingness_to_pay: z.number().min(1).max(5),
      friction: z.number().min(1).max(5),
    }),
    concerns: z.array(z.string()),
    reasoning: z.string().min(1),
    would_change_mind: z.string(),
  }),
  update_profile: z.object({
    patch: z.record(z.string(), z.unknown()).describe('Merged into the workspace profile'),
  }),
  save_symptom: z.object({
    kind: z.enum(['symptom', 'strength']),
    title: z.string().min(1),
    detail: z.string().min(1),
    criteria: criteria.default({}),
    evidence: z.array(id).default([]),
  }),
  save_recommendation: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    // Keep in sync with COST_FORMATS / checkRecommendationCriteria in scoring/priority.ts.
    criteria: criteria
      .default({})
      .describe(
        'Keys: upside, difficulty, timeToValue, risk, strategicFit, competitiveUrgency (each 1–5; difficulty/timeToValue/risk: 5 = worst); ' +
          'confidence (percent 0–100); cost: a 1–5 score (5 = most expensive), very low|low|medium|high|very high, or a money ' +
          'amount/range such as "$250k", "$10k–$50k", "$1M–$5M", "$2 million", "2 million USD", "€500k–€1M" ' +
          '($ € £ or USD/EUR/GBP; k/M/B or thousand/million/billion). Effort/time units (months, weeks, hours, FTE) are rejected.',
      ),
    finding_ids: z.array(id).min(1),
    priority: z.number().optional(),
  }),
  read_workspace: z.object({
    workspace_id: id.describe('Any workspace of this business tree (ancestors, siblings, descendants)'),
  }),
  propose_business_unit: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    level: z.enum(['company', 'division', 'slice']),
    audiences: z.array(z.enum(['external', 'internal'])).min(1),
    evidence: z.array(id).default([]).describe('Artifact ids supporting the unit (site, filings, org signals)'),
    reasoning: z.string().min(1),
  }),
  save_competitor: z.object({
    name: z.string().min(1).describe('Competitor (or alternative) name; same name = update'),
    site: z.string().optional().describe('Main site / host'),
    threat: score15.describe('1–5: threat to the business in scope'),
    directness: score15.describe('1–5: how directly it competes for the same audience'),
    comparison: z
      .object({ pricing: score15, onboarding: score15, ux: score15, features: score15 })
      .describe('Each 1–5: competitor vs. the business in scope (5 = competitor much better, 3 = on par)'),
    evidence: z.array(id).min(1, 'evidence must reference at least one saved artifact'),
  }),
  save_hypothesis: z.object({
    symptom_id: id.describe('Interview symptom this hypothesis explains'),
    hypothesis: z.string().min(1).describe('Suspected cause, one sentence'),
    confidence: z.number().min(0).max(100).describe('0–100 (percent)'),
    evidence: z.array(id).min(1, 'cite at least one finding or artifact id'),
  }),
  // WP-D: 0–3 multiple-choice questions for the user about a task that ended unverified / failed.
  submit_escalation: z.object({
    questions: z
      .array(
        z
          .object({
            question: z.string().min(1).describe('One concrete question the user can answer by picking an option'),
            options: z.array(z.string().min(1)).min(2).max(4).describe('2–4 distinct answer options'),
            recommended: z.number().int().min(0).describe('0-based index of the option you recommend'),
            why: z.string().min(1).describe('One or two sentences: why you ask and why you recommend that option'),
          })
          .refine((q) => q.recommended < q.options.length, { message: 'recommended must index one of the options', path: ['recommended'] }),
      )
      .max(3)
      .describe('0–3 questions; an empty list when the user cannot help'),
  }),
  // Knowledge store KS-1 (design §8.1, §9)
  describe_artifact: z.object({
    artifact_id: id,
    description: z
      .string()
      .min(1)
      .describe('What is on it that matters: page purpose, visible prices, plan names, button labels, error text (at least 20 characters)'),
  }),
} satisfies Record<ToolName, z.ZodType>;

export type ToolInput<N extends ToolName> = z.output<(typeof toolInputSchemas)[N]>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  log_decision: 'Record a judgment call (what, why, alternatives, signals, confidence) in the decision log.',
  save_artifact:
    'Store evidence (screenshot, page snapshot, document or text). Screenshots and images need a description. ' +
    'Returns artifactId, captureId and the text extraction status.',
  read_artifact: 'Read a stored evidence artifact by id (text content, or the image for screenshots).',
  save_finding:
    'Save a finding (a fact). Rejected unless evidence lists at least one artifact saved in this workspace. Without `relation`, ' +
    'the store is checked for the same fact: an identical current claim is confirmed instead (cite an artifact saved in this ' +
    'task), and similar current facts are returned WITHOUT saving — call again with relation "new", {"confirms": id} or ' +
    '{"replaces": id}. `evidence_refs` quotes must occur in the artifact text. ' +
    // knowledge store KS-3
    'The finding is filed under an entity: `entity` when given, else the subject names it (an existing competitor, persona ' +
    'or company entity with that name or alias, else the company of a business unit with that name, else a topic). Returns entityId.',
  submit_result: 'Submit your task deliverable (one JSON object). Call once at the end; resubmit after revisions.',
  submit_review: 'Submit your review: score 0–10 and issues classed blocking | substantive | nit | scope_expansion.',
  respond_to_review: 'Answer one review issue: fix (and say what changed) or pushback (with reason).',
  request_user_action:
    'Ask the user to do something you cannot (register, login, captcha). Blocks until the user resolves it.',
  request_approval:
    'Ask the user to approve a gated action (payment entry, demo request, contacting a human). Blocks until answered.',
  propose_tasks: 'Propose research tasks for this phase. Returns accepted tasks and rejections with reasons.',
  get_identity: 'Get the disposable identity (email, name) to use for signing up on a site.',
  save_persona: 'Save or update an evidence-backed persona profile for an audience segment.',
  submit_persona_feedback: 'Submit your in-character feedback on a recommendation (simulated persona).',
  update_profile: 'Merge facts learned in the interview into the business profile.',
  save_symptom: 'Save a business symptom or strength surfaced in the interview.',
  save_recommendation: 'Save a recommendation that references the findings supporting it.',
  read_workspace:
    'Read another workspace of this business tree (read-only): scope, profile, finding and symptom titles, tagged by source.',
  propose_business_unit:
    'Propose a child business unit (division, product, team, internal platform) for the user to accept or reject.',
  save_competitor:
    'Save or update a rated competitor: threat, directness and per-area comparison (pricing, onboarding, ux, features), each 1–5, with evidence.',
  save_hypothesis:
    'Save a hypothesis about the cause of an interview symptom (confidence 0–100, evidence); the interviewer asks the user about it.',
  confirm_finding:
    'Confirm that a current fact saved by earlier work is still true, citing at least one artifact you saved in this task. Applied when your task is verified.',
  retract_finding:
    'Retract a current fact that is no longer true (reason + at least one artifact you saved in this task). Applied when your task is verified.',
  submit_escalation:
    'Ask the user 0–3 multiple-choice questions (2–4 options each, one recommended) about a task that ended unverified or failed. Call once.',
  // Knowledge store KS-1
  describe_artifact:
    'Add a description to an artifact that has none (e.g. an uploaded image), or replace the description of one you saved in this run.',
};

/** JSON Schema of a tool's input as agents should send it (defaults shown as optional). */
export function toolJsonSchema(name: ToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(toolInputSchemas[name], { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  if (schema.type !== 'object') schema.type = 'object';
  return schema;
}
