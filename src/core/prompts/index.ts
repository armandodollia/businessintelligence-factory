import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding the `.md` prompt templates (and `calibration/<name>.md` patches). */
export const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** First 8 hex chars of the sha256 of `text`. */
export function promptVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/**
 * Loads prompt `<name>.md`. When `calibration/<name>.md` exists (written by an approved calibration
 * patch, Task 13) it is appended, so the version changes with it. `version` = sha256(text)[0:8].
 */
export function loadPrompt(name: string): { text: string; version: string } {
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`invalid prompt name '${name}'`);
  let text = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8').trimEnd();
  const calibration = join(PROMPTS_DIR, 'calibration', `${name}.md`);
  if (existsSync(calibration)) text += '\n\n' + readFileSync(calibration, 'utf8').trimEnd();
  return { text, version: promptVersion(text) };
}

/** Replaces `{{key}}` placeholders; unknown keys are left as-is. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m));
}
