import { z } from 'zod';
import { modelRefSchema, taskTypeSchema } from '../../config/schema.js';
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
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const BASE: ToolName[] = ['log_decision', 'save_artifact', 'request_user_action', 'request_approval'];

/** Which harness tools each role sees (`tools/list`) and may call. */
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  worker: [...BASE, 'save_finding', 'submit_result', 'respond_to_review', 'get_identity', 'save_persona'],
  orchestrator: [...BASE, 'propose_tasks'],
  reviewer: ['log_decision', 'submit_review', 'read_artifact'],
  persona: ['log_decision', 'submit_persona_feedback'],
  interviewer: ['log_decision', 'update_profile', 'save_symptom'],
  synthesizer: [...BASE, 'save_recommendation', 'save_finding', 'submit_result'],
};

export const ISSUE_CLASSES = ['blocking', 'substantive', 'nit', 'scope_expansion'] as const;
export type IssueClass = (typeof ISSUE_CLASSES)[number];

const id = z.string().min(1);
const criteria = z.record(z.string(), z.union([z.number(), z.string()]));

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
      file_path: z.string().optional().describe('Absolute path of a local file to store (e.g. a screenshot)'),
      source_url: z.string().optional(),
      title: z.string().optional(),
      flow: z.string().optional().describe('Flow name for walkthroughs, e.g. signup'),
      step: z.number().int().min(0).optional().describe('Step index within the flow'),
      note: z.string().optional(),
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
          model: modelRefSchema,
          needs_browser: z.boolean(),
          acceptance_criteria: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
  }),
  get_identity: z.object({ site: z.string().min(1) }),
  save_persona: z.object({
    segment: z.string().min(1),
    slug: z.string().optional(),
    profile: z.record(
      z.string(),
      z.object({ value: z.string(), confidence: z.number().min(0).max(1), evidence: z.array(id) }),
    ),
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
    criteria: criteria.default({}),
    finding_ids: z.array(id).min(1),
    priority: z.number().optional(),
  }),
} satisfies Record<ToolName, z.ZodType>;

export type ToolInput<N extends ToolName> = z.output<(typeof toolInputSchemas)[N]>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  log_decision: 'Record a judgment call (what, why, alternatives, signals, confidence) in the decision log.',
  save_artifact: 'Store evidence (screenshot, page snapshot, document or text). Returns artifactId.',
  read_artifact: 'Read a stored evidence artifact by id (text content, or the image for screenshots).',
  save_finding:
    'Save a finding. Rejected unless evidence lists at least one artifact saved in this workspace.',
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
