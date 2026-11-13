import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Directory holding the role/task prompt templates (`<name>.md`). */
export const PROMPTS_DIR = import.meta.dirname;

/**
 * Directory of user-approved calibration appendices (`<name>.md`, written by `applyPromptPatch`).
 * Overridable with `BIF_CALIBRATION_DIR` (tests, alternative data roots).
 */
export function calibrationDir(): string {
  return process.env.BIF_CALIBRATION_DIR ?? join(PROMPTS_DIR, 'calibration');
}

/**
 * Loads prompt `<name>.md`, appending the calibration appendix `calibration/<name>.md` when one
 * exists. `version` = first 8 hex chars of sha256 of the full text (appendix included), so an
 * approved calibration patch changes the prompt version recorded on each run.
 */
export function loadPrompt(name: string): { text: string; version: string } {
  const text = withCalibration(promptTemplate(name), name);
  return { text, version: promptVersion(text) };
}

/** Raw `<name>.md` template, without any calibration appendix. */
export function promptTemplate(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid prompt name '${name}'`);
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
}

/**
 * The approved calibration appendix for `name` (`calibration/<name>.md`, usually a role name),
 * trimmed; `''` when there is none.
 */
export function calibrationAppendix(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid calibration name '${name}'`);
  const file = join(calibrationDir(), `${name}.md`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

/**
 * Appends `calibrationAppendix(name)` to an assembled system prompt (unchanged when there is no
 * appendix). Use for prompts not loaded via `loadPrompt(name)` — e.g. persona agent.md (`persona`),
 * synthesizer runs that share `worker.md` (`synthesizer`) — so the recorded prompt version changes
 * when a calibration patch is applied.
 */
export function withCalibration(text: string, name: string): string {
  const extra = calibrationAppendix(name);
  return extra ? `${text.trimEnd()}\n\n${extra}\n` : text;
}

/** First 8 hex chars of the sha256 of `text` (same scheme as `loadPrompt().version`). */
export function promptVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** Replaces `{{key}}` placeholders; unknown keys are left as-is. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m));
}
