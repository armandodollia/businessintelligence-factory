/**
 * The lessons appendix of a role's prompt (learning loop WP-E): the role's ACTIVE rules in one
 * business tree, each line tagged with its tracking marker and rule version (`[L-7F3A2C.v2]`).
 * `withCalibration` (prompts/index.ts) appends it after the calibration appendix through
 * `CalibrationScope.lessons`, which `calibrationScope` (scoring/calibration.ts) binds to the store,
 * so every role prompt built for a tree carries that tree's accepted rules and nothing else.
 */
import { randomBytes } from 'node:crypto';
import type { Store } from '../../store/db.js';
import type { Role } from '../../types.js';
import { lessonsOff } from '../runTags.js';
import { lessonsMode } from './mode.js';
import { lessonRepos } from './store.js';
import type { LessonRule } from './types.js';

export const LESSONS_HEADING = '## Lessons from past work (approved by the user)';

/** The tag a rule's prompt line carries: marker + rule version. */
export const markerTag = (rule: Pick<LessonRule, 'marker' | 'version'>): string => `[${rule.marker}.v${rule.version}]`;
/** Text fragment present in a prompt that carries any version of the rule. */
export const markerPrefix = (marker: string): string => `[${marker}.v`;

/** Active rules of a tree (one role or all), oldest first. */
export function activeRules(store: Store, rootWorkspaceId: string, role?: Role): LessonRule[] {
  return lessonRepos(store).rules.list({ rootWorkspaceId, status: 'active', ...(role ? { role } : {}) });
}

/** One prompt line of a rule. */
export function ruleLine(rule: Pick<LessonRule, 'marker' | 'version' | 'text'>): string {
  return `- ${markerTag(rule)} ${rule.text.replace(/\s+/g, ' ').trim()}`;
}

/**
 * What the prompt is built for (wave-2 integration): the stored lessons-off flag of the task / run is
 * read from the store (`lessonsOff`, WP-F), so it survives a restart or resume. `lessonsOff: true`
 * forces it (reviewer audits, ruling R5).
 */
export type LessonsTarget = { taskId?: string; agentRunId?: string; lessonsOff?: boolean };

/** Whether a prompt built for `target` leaves the lessons out (stored flag, forced, or `withLessons('off')`). */
export function lessonsOffFor(store: Store, target: LessonsTarget = {}): boolean {
  // `withLessons('off')` marks the runs it starts (`runAgent` stores the flag); it also covers the
  // first prompt of a task, built before any of its runs (and so any stored flag) exists.
  return target.lessonsOff === true || lessonsMode() === 'off' || lessonsOff(store, target);
}

/**
 * The lessons section for `role` in the tree of `rootWorkspaceId` ('' when it has no active rule, or
 * when lessons are off for the task / run the prompt is built for: `lessonsOffFor`).
 */
export function lessonsAppendix(store: Store, rootWorkspaceId: string, role: string, target: LessonsTarget = {}): string {
  if (lessonsOffFor(store, target)) return '';
  const rules = lessonRepos(store).rules.list({ rootWorkspaceId, status: 'active' }).filter((r) => r.role === role);
  if (!rules.length) return '';
  return [
    LESSONS_HEADING,
    '',
    'Rules learned from reviews, outcomes and feedback on earlier work in this business. Follow them unless your task says',
    'otherwise. The bracketed tag of each rule is a tracking marker: ignore it.',
    '',
    ...rules.map(ruleLine),
  ].join('\n');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new unique tracking marker (`L-` + 6 Crockford characters). */
export function newMarker(store: Store): string {
  const repo = lessonRepos(store).rules;
  for (;;) {
    let m = 'L-';
    for (const b of randomBytes(6)) m += CROCKFORD[b % 32];
    if (!repo.list({ marker: m }).length) return m;
  }
}
