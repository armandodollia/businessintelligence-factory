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
 *
 * Stakeholder personas (design §7): an id of withheld research (an own-stakeholder task of a node that
 * still has a hidden stakeholder, one of its runs, or a Decision of such a run) is blocked the same way,
 * so its review issues and audit misses are counted but never quoted.
 */
import { servedLine } from '../../knowledge/texts.js';
import { exportExclusion } from '../../scoring/export.js';
import { withholding, type Withholding } from '../../stakeholders/withheld.js';
import type { Store } from '../../store/db.js';
import type { LessonSignal } from './signals.js';

/** Longest quote of an example (after redaction). */
export const LESSON_QUOTE_CHARS = 160;

export class LessonPrivacy {
  private exclusion?: ReturnType<typeof exportExclusion>;
  private withheldCache?: Withholding;
  constructor(private readonly store: Store) {}

  private get exc(): ReturnType<typeof exportExclusion> {
    this.exclusion ??= exportExclusion(this.store);
    return this.exclusion;
  }

  /** The id is withheld research: a withheld task, a run of one, or a Decision of such a run. */
  private withheld(id: string): boolean {
    this.withheldCache ??= withholding(this.store);
    const w = this.withheldCache;
    if (id.startsWith('tsk_')) return w.task(this.store.tasks.get(id));
    if (id.startsWith('dec_')) return w.run(this.store.decisions.get(id)?.agentRunId);
    return w.run(id);
  }

  /** The id is upload-derived, an exposed run / task / output, or cites such an output (export bound), or is withheld research. */
  blocked(id: string | undefined): boolean {
    if (!id) return false;
    if (this.withheld(id)) return true;
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
