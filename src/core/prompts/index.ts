import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Directory holding the role/task prompt templates (`<name>.md`). */
export const PROMPTS_DIR = import.meta.dirname;

/**
 * Where a business tree's approved calibration appendices live:
 * `<dataDir>/<rootWorkspaceId>/calibration/<role>.md`. Calibration is per business (tree root),
 * never global — one company's corrections must not reach another company's prompts — and
 * nothing is ever written under `src/`.
 */
export type CalibrationScope = {
  dataDir: string;
  rootWorkspaceId: string;
  /**
   * Learning loop WP-E: the tree's accepted lesson rules for a role (`lessonsAppendix`, bound to the
   * store by `calibrationScope`); '' when there are none or lessons are off for the run.
   */
  lessons?: (name: string) => string;
};

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/** `<dataDir>/<rootWorkspaceId>/calibration` (absolute). */
export function calibrationDir(scope: CalibrationScope): string {
  if (!SAFE_NAME.test(scope.rootWorkspaceId)) throw new Error(`invalid workspace id '${scope.rootWorkspaceId}'`);
  return join(resolve(scope.dataDir), scope.rootWorkspaceId, 'calibration');
}

/**
 * Loads prompt `<name>.md`, appending the business tree's calibration appendix
 * (`<dataDir>/<root>/calibration/<name>.md`) when a `scope` is given and one exists. `version` =
 * first 8 hex chars of sha256 of the full text (appendix included), so an approved calibration
 * patch changes the prompt version recorded on each run.
 */
export function loadPrompt(name: string, scope?: CalibrationScope): { text: string; version: string } {
  const text = withCalibration(promptTemplate(name), name, scope);
  return { text, version: promptVersion(text) };
}

/** Raw `<name>.md` template, without any calibration appendix. */
export function promptTemplate(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid prompt name '${name}'`);
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
}

/**
 * The approved calibration appendix for `name` (usually a role name) in the business tree of
 * `scope`, trimmed; `''` when there is none or no scope is given.
 */
export function calibrationAppendix(name: string, scope?: CalibrationScope): string {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid calibration name '${name}'`);
  if (!scope) return '';
  const file = join(calibrationDir(scope), `${name}.md`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

/**
 * Appends `calibrationAppendix(name, scope)` to an assembled system prompt (unchanged when there
 * is no appendix). Use for prompts not loaded via `loadPrompt(name)` — e.g. persona agent.md
 * (`persona`), synthesizer runs that share `worker.md` (`synthesizer`) — so the recorded prompt
 * version changes when a calibration patch is applied.
 */
export function withCalibration(text: string, name: string, scope?: CalibrationScope): string {
  const extra = calibrationAppendix(name, scope);
  const out = extra ? `${text.trimEnd()}\n\n${extra}\n` : text;
  // --- learning loop WP-E: accepted lesson rules follow the calibration appendix ---
  const lessons = scope?.lessons?.(name).trim() ?? '';
  return lessons ? `${out.trimEnd()}\n\n${lessons}\n` : out;
  // --- end WP-E ---
}

/** First 8 hex chars of the sha256 of `text` (same scheme as `loadPrompt().version`). */
export function promptVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** Replaces `{{key}}` placeholders; unknown keys are left as-is. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m));
}
