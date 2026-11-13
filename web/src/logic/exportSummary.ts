/**
 * Export summary (design §12 ruling, "visible cost"): what the training export leaves out by default,
 * by cause, as the API reports it (`GET /api/workspaces/:id/export/summary`, also the
 * `x-bif-export-summary` header of the download). Formatting only; the view renders it.
 */

export type ExportExclusionCause = 'cites_upload' | 'exposed_run' | 'exposed_task' | 'exposed_output';

export type ExportExclusionCount = { total: number; byCause: Array<{ cause: ExportExclusionCause; label: string; count: number }> };

export type ExportSummary = {
  includeUploads: boolean;
  excludedJudgments: ExportExclusionCount;
  excludedOtherLines: ExportExclusionCount;
  note: string;
};

export type ExportSummaryView = {
  headline: string;
  /** One line per cause, in the API's order (cites an upload, exposed run, task of an exposed run, output of such a task). */
  causes: Array<{ cause: ExportExclusionCause; text: string }>;
  /** How to include them (the server's note). */
  includeHint: string;
};

const isCount = (x: unknown): x is ExportExclusionCount =>
  !!x && typeof x === 'object' && typeof (x as ExportExclusionCount).total === 'number' && Array.isArray((x as ExportExclusionCount).byCause);

/** The summary as shown next to the export links; null when there is none (or it is malformed). */
export function exportSummaryView(s: unknown): ExportSummaryView | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const sum = s as Partial<ExportSummary>;
  if (!isCount(sum.excludedJudgments) || !isCount(sum.excludedOtherLines)) return null;
  const j = sum.excludedJudgments;
  const o = sum.excludedOtherLines;
  if (j.total + o.total === 0) return { headline: 'The export leaves nothing out for uploads.', causes: [], includeHint: '' };
  return {
    headline: `The export leaves out ${j.total} judgment(s) by default${o.total ? ` (and ${o.total} other line(s))` : ''}.`,
    causes: j.byCause.map((c) => ({ cause: c.cause, text: `${c.label}: ${c.count}` })),
    includeHint: typeof sum.note === 'string' ? sum.note : 'Export with includeUploads to include them.',
  };
}
