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
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid prompt name '${name}'`);
  let text = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
  const appendix = join(calibrationDir(), `${name}.md`);
  if (existsSync(appendix)) {
    const extra = readFileSync(appendix, 'utf8').trim();
    if (extra) text = `${text.trimEnd()}\n\n${extra}\n`;
  }
  const version = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return { text, version };
}

/** First 8 hex chars of the sha256 of `text` (same scheme as `loadPrompt().version`). */
export function promptVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** Replaces `{{key}}` placeholders; unknown keys are left as-is. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m));
}
