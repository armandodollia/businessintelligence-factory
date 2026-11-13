/**
 * Upload privacy of lessons (learning loop WP-E, design §12 of the knowledge-store spec). Rule text is
 * written from templates and never quotes stored text. Examples (proposal evidence, the retro digest)
 * may quote a review issue or a recorded note only when NONE of these holds — else they name the id
 * only:
 * - the quoted text or any id it rests on is upload-derived now (`itemIsUploadDerived`, through the
 *   export's exclusion set);
 * - a run that wrote it is upload-exposed (`runIsUploadExposed`);
 * - its task is the task of an exposed run or a task whose outputs cite an output of one, or an id it
 *   rests on is such an output or a record citing one (the export's rule, `exportExclusion()`).
 * The check is computed when the example is built (never stored), exactly as the export does.
 */
import { servedLine } from '../../knowledge/texts.js';
import { exportExclusion } from '../../scoring/export.js';
import type { Store } from '../../store/db.js';
import type { LessonSignal } from './signals.js';

/** Longest quote of an example (after redaction). */
export const LESSON_QUOTE_CHARS = 160;

export class LessonPrivacy {
  private exclusion?: ReturnType<typeof exportExclusion>;
  constructor(private readonly store: Store) {}

  private get exc(): ReturnType<typeof exportExclusion> {
    this.exclusion ??= exportExclusion(this.store);
    return this.exclusion;
  }

  /** The id is upload-derived, an exposed run / task / output, or cites such an output (export bound). */
  blocked(id: string | undefined): boolean {
    if (!id) return false;
    return this.exc.runExposed(id) || this.exc.has(id) || (id.startsWith('tsk_') && this.exc.taskCitesExposedOutput(id) !== undefined);
  }

  /** The signal's text may be quoted (see module doc). */
  quotable(sig: Pick<LessonSignal, 'text' | 'taskId' | 'agentRunId' | 'refId' | 'textRefs'>): boolean {
    if (!sig.text?.trim()) return false;
    return ![sig.taskId, sig.agentRunId, sig.refId, ...(sig.textRefs ?? [])].some((id) => this.blocked(id));
  }

  /** The quote to show for a signal (redacted whole, then cut), or undefined when it must stay an id. */
  quote(sig: LessonSignal, workspaceId: string, maxChars = LESSON_QUOTE_CHARS): string | undefined {
    return this.quotable(sig) ? servedLine(this.store, workspaceId, sig.text!, maxChars) : undefined;
  }
}
