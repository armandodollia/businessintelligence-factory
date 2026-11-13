/**
 * Rule texts of the lessons engine (learning loop WP-E). Written only from the category (code
 * identifiers: issue class, task type, outcome label, failure class, policy action, criterion, signal
 * kind) and a task count — never from stored text, so a rule can never carry upload-derived text.
 * Strength 1–3 changes the wording only.
 */
import type { Role } from '../../types.js';

const STRENGTH_PREFIX = ['', 'Important: ', 'Critical, this keeps recurring: '];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The instruction for a category (without strength prefix or count). */
function instruction(category: string, role: Role): string {
  const [area, a, b] = category.split(':');
  switch (area) {
    case 'review': {
      const where = b ? `In ${b} tasks, ` : '';
      switch (a) {
        case 'blocking':
          return `${where}check every acceptance criterion and make sure each claim cites an artifact you saved before you submit`;
        case 'substantive':
          return `${where}check that each claim is supported by the evidence it cites (source, date, figures) before you submit`;
        case 'nit':
          return `${where}proofread the deliverable (names, units, formatting, consistency) before you submit`;
        case 'scope_expansion':
          return `${where}stay within the brief and its acceptance criteria; do not add work the brief did not ask for`;
        default:
          return `${where}address the kind of issue reviewers keep raising (${a ?? 'review'}) before you submit`;
      }
    }
    case 'outcome':
      switch (a) {
        case 'missed-evidence':
          return 'support every claim with evidence saved in this task, and say plainly what you could not verify';
        case 'over-scoped':
          return 'stay within the brief; work outside it is not credited and blocks verification';
        case 'weak-review':
          return 'judge only against the brief, the acceptance criteria and the cited evidence, and check each issue before raising it';
        case 'reviewer-false-positive':
          return 'before raising an issue, check the deliverable and its evidence for the point; raise only issues you can show';
        case 'worker-miss':
          return 'before pushing back on a review issue, re-check it against your evidence; fix it when the reviewer is right';
        case 'user-rejected':
          return 'save only outputs that the evidence supports and that fit the business scope and audience of the brief';
        case 'run-failed':
          return 'always finish with your submit tool, even when the work is incomplete, and say what is missing';
        default:
          return `avoid the outcome "${a ?? 'unknown'}" that keeps recurring`;
      }
    case 'audit': // wave-2 integration: WP-F reviewer-audit misses (role reviewer)
      switch (a) {
        case 'blocking':
          return 'before you pass work, check every acceptance criterion and each cited artifact; independent re-reviews found blocking problems in work you passed';
        case 'substantive':
          return 'before you pass work, check that each claim is supported by the evidence it cites; independent re-reviews found unsupported claims in work you passed';
        default:
          return `before you pass work, look for the ${a ?? 'kind of'} issues that independent re-reviews keep finding in work you passed`;
      }
    case 'failure':
      return a === 'timeout'
        ? 'keep making progress and call your submit tool before you stop; long silent pauses end the run'
        : 'call tools with valid inputs, read their errors and retry with a corrected input, then finish with your submit tool';
    case 'policy':
      return a === 'approval_denied'
        ? `do not ask for approval to "${b ?? 'this action'}" unless the brief requires it`
        : `do not attempt "${b ?? 'this action'}"; the action policy blocks it`;
    case 'feedback':
      switch (a) {
        case 'exclude':
          return `save a ${b ?? 'output'} only when the evidence supports it and it is relevant to the brief`;
        case 'proposal_reject':
          return 'propose business units only with clear evidence that they exist as separate units';
        case 'proposal_edit':
          return 'check names, levels and audiences of proposed business units against the evidence before proposing';
        case 'hypothesis_correction':
          return 'state hypotheses and their confidence conservatively, in line with the evidence';
        case 'fact_retract':
          return 'save only facts your evidence states directly, and re-check facts that may have changed';
        default:
          return 'take the user corrections on this kind of output into account';
      }
    case 'rating':
      return `calibrate "${b ?? 'the criterion'}" for ${a ?? 'output'}s more carefully: use the full scale and justify the value with evidence`;
    case 'knowledge':
      switch (a) {
        case 'zero_result':
          return 'search the knowledge store with fewer, broader terms, or open a known entity with get_card';
        case 'unused_tokens':
          return 'search narrowly and expand only items you are likely to cite';
        case 'duplicate_saved':
          return 'when save_finding shows similar facts, confirm or replace them instead of saving a new one';
        case 'missing_caption':
          return 'describe every screenshot when you save it: what is on it that matters (at least 20 characters)';
        case 'rejected_quote':
          return 'quote evidence exactly as it appears in the artifact text';
        default:
          return `avoid the knowledge-store problem "${a ?? 'unknown'}"`;
      }
    default:
      return `take extra care with "${category}" (${role}), which checks of earlier work keep finding`;
  }
}

/** What the count means, per area. */
function evidencePhrase(category: string, tasks: number): string {
  const area = category.split(':')[0];
  const n = plural(tasks, 'task');
  switch (area) {
    case 'review':
      return `reviewers raised this in ${n}`;
    case 'outcome':
      return `this outcome occurred in ${n}`;
    case 'audit':
      return `an audit on another model failed work you passed in ${n}`;
    case 'failure':
      return `runs failed this way in ${n}`;
    case 'policy':
      return `this was denied in ${n}`;
    case 'feedback':
    case 'rating':
      return `the user corrected this in ${n}`;
    default:
      return `seen in ${n}`;
  }
}

/** Rule text for `category` at `strength` (1–3), from `tasks` recurrences. */
export function ruleText(category: string, role: Role, strength: number, tasks: number): string {
  const body = instruction(category, role);
  const prefix = STRENGTH_PREFIX[Math.max(0, Math.min(STRENGTH_PREFIX.length - 1, strength - 1))]!;
  const sentence = `${body.charAt(0).toUpperCase()}${body.slice(1)}`;
  return `${prefix}${sentence} (${evidencePhrase(category, tasks)}).`;
}

/** Short human label of a category for proposals and the UI. */
export function categoryLabel(category: string): string {
  const [area, a, b] = category.split(':');
  switch (area) {
    case 'review':
      return `review issues: ${a}${b ? ` (${b})` : ''}`;
    case 'outcome':
      return `outcome: ${a}`;
    case 'audit':
      return `reviewer audit misses: ${a}`;
    case 'failure':
      return `run failures: ${a}`;
    case 'policy':
      return `policy ${a === 'approval_denied' ? 'denials' : 'blocks'}: ${b}`;
    case 'feedback':
      return `user feedback: ${a}${b ? ` (${b})` : ''}`;
    case 'rating':
      return `rating disagreements: ${b} (${a})`;
    case 'knowledge':
      return `knowledge store: ${a}`;
    case 'retro':
      return 'retro prompt edit';
    default:
      return category;
  }
}
