/**
 * The "Send feedback" page's behaviour (design 2026-11-16-desktop-app-and-feedback-bundle-design.md
 * §3.1): the choices (period, level, note), the preview of what the file would hold, the first rows
 * of a section on demand, and saving the file. The application sends nothing: saving hands the file
 * to the browser's download (in the desktop app, to its save dialog).
 */
import { useCallback, useState } from 'react';
import { feedbackBundleApi } from './api.js';
import type { BundleChoices, BundleLevel, BundlePreview } from './types.js';

/** The two levels, each with one plain sentence on what it includes. */
export const LEVELS: ReadonlyArray<{ level: BundleLevel; label: string; includes: string }> = [
  {
    level: 'standard',
    label: 'Standard',
    includes:
      'Numbers, labels, ids, timings, versions and your own feedback: your ratings, your accept and reject decisions and your corrections, with the reasons you typed. Nothing of what the research found, and no web address: one is written <url>.',
  },
  {
    level: 'with_texts',
    label: 'With review texts',
    includes:
      'Also the text of review issues and council findings, failure messages in full, and the decision lines of the training export. These texts speak about your research, and web addresses are kept.',
  },
];

/** What no file holds, at either level. */
export const NEVER_INCLUDED =
  'Never included, at either level: uploads, text taken from uploads, internal stakeholder records, stored site passwords, the names of your businesses and their parts (their ids are written), your user id (written as "tester"), and the folders of this computer (a file path is cut to the file name).';

/** How the note and typed reasons are treated. */
export const OWN_WORDS_HINT =
  'Your note, and the reasons you typed with your ratings and decisions, are your own words: they are included as you typed them, after stored site passwords, business names and file paths are removed. At the standard level a web address in them is written <url>.';

/** `64 B`, `15 KB`, `3.0 MB`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${n < 10 * 1024 ? (n / 1024).toFixed(1) : Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Hands `blob` to the browser as a download named `fileName`. */
function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // After the click has been taken up.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The choices as the API takes them (empty fields left out). */
/**
 * What the page says after "Save". The file went to the browser's download or to the desktop app's
 * save dialog, and the page is not told what became of it there (the dialog can be cancelled), so
 * the words must hold in every case.
 */
export const OFFERED_NOTE =
  'If you chose a place for it, it is there now; a browser puts it with its downloads. Nothing was sent: send the file to the person who asked you for it.';

function bodyOf(c: { level: BundleLevel; since: string; until: string; note: string }): BundleChoices {
  return { level: c.level, ...(c.since ? { since: c.since } : {}), ...(c.until ? { until: c.until } : {}), ...(c.note.trim() ? { note: c.note.trim() } : {}) };
}

/**
 * State of the page. Nothing is built until `preview()` is called; changing a choice clears the
 * preview, so what is saved is what was shown.
 */
export function useFeedbackBundle() {
  const [choices, setChoices] = useState({ level: 'standard' as BundleLevel, since: '', until: '', note: '' });
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [firstRows, setFirstRows] = useState<{ section: string; rows: unknown[] } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'rows' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The name of the file handed to the browser's download or the desktop app's save dialog. Whether it was written the page cannot know. */
  const [offered, setOffered] = useState<string | null>(null);

  const set = useCallback(<K extends keyof typeof choices>(key: K, value: (typeof choices)[K]) => {
    setChoices((c) => ({ ...c, [key]: value }));
    setPreview(null);
    setFirstRows(null);
    setOffered(null);
    setError(null);
  }, []);

  const run = useCallback(async (what: 'preview' | 'rows' | 'save', work: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const makePreview = useCallback(
    () =>
      run('preview', async () => {
        setFirstRows(null);
        setOffered(null);
        setPreview(null);
        setPreview(await feedbackBundleApi.preview(bodyOf(choices)));
      }),
    [choices, run],
  );

  const showRows = useCallback(
    (section: string) =>
      run('rows', async () => {
        const p = await feedbackBundleApi.preview(bodyOf(choices), section);
        setFirstRows(p.firstRows ?? { section, rows: [] });
      }),
    [choices, run],
  );

  const save = useCallback(
    () =>
      run('save', async () => {
        const file = await feedbackBundleApi.download(bodyOf(choices));
        download(file.blob, file.fileName);
        setOffered(file.fileName);
      }),
    [choices, run],
  );

  return { choices, set, preview, firstRows, hideRows: () => setFirstRows(null), busy, error, offered, makePreview, showRows, save };
}
