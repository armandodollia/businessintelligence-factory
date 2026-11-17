// @vitest-environment jsdom
/**
 * The "Send feedback" page (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §3.1): the
 * period, the level, a note, the preview, "Save". The page says what each level includes and what is
 * never included, and the application sends nothing. Behaviour in web/src/logic, markup in the view,
 * no fetch in views.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatBytes, OFFERED_NOTE } from '../../web/src/logic/feedbackBundle.js';
import { href, parseRoute } from '../../web/src/logic/router.js';
import { App } from '../../web/src/views/App.js';

const FILE_NAME = 'bif-feedback-2026-11-16-ab12cd34.json.gz';
const preview = (level: string) => ({
  id: 'ab12cd34', level, fileName: FILE_NAME, totalBytes: 2048,
  sections: [
    { name: 'manifest', rows: 1, bytes: 412 },
    { name: 'runs', rows: 37, bytes: 15_360 },
    { name: 'feedback', rows: 0, bytes: 64 },
    ...(level === 'with_texts' ? [{ name: 'texts', rows: 12, bytes: 3_145_728 }] : []),
  ],
});

type Call = { path: string; body: any };
let calls: Call[] = [];
let failPreview = false;
let clicked: Array<{ download: string; href: string }> = [];

class NoopEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  calls = [];
  clicked = [];
  failPreview = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname, body });
      if (url.pathname === '/api/feedback-bundle/preview') {
        if (failPreview) return new Response(JSON.stringify({ error: 'since must not be after until' }), { status: 400, headers: { 'content-type': 'application/json' } });
        const p = preview(body.level ?? 'standard');
        const firstRows = body.rows ? { section: body.rows.section, rows: [{ tree: 'ws_1', table: 'runs', row: { role: 'worker', status: 'done' } }] } : undefined;
        return new Response(JSON.stringify({ ...p, ...(firstRows ? { firstRows } : {}) }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/feedback-bundle') {
        return new Response(new Uint8Array([0x1f, 0x8b, 0x08]), { headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${FILE_NAME}"` } });
      }
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('EventSource', NoopEventSource);
  URL.createObjectURL = vi.fn(() => 'blob:feedback-bundle');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ download: this.download, href: this.href });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

const open = () => {
  window.location.hash = '#/feedback';
  render(<App />);
};
const bundleCalls = () => calls.filter((c) => c.path.startsWith('/api/feedback-bundle'));

describe('send feedback (logic)', () => {
  it('has its own route', () => {
    expect(parseRoute('#/feedback')).toEqual({ name: 'feedback' });
    expect(href({ name: 'feedback' })).toBe('#/feedback');
  });

  it('formats sizes', () => {
    expect([formatBytes(64), formatBytes(15_360), formatBytes(3_145_728)]).toEqual(['64 B', '15 KB', '3.0 MB']);
  });
});

describe('send feedback (view)', () => {
  it('is in the navigation, and builds nothing until asked', async () => {
    window.location.hash = '';
    render(<App />);
    const link = screen.getByRole('link', { name: 'Send feedback' });
    expect(link.getAttribute('href')).toBe('#/feedback');
    cleanup();
    open();
    expect(await screen.findByRole('heading', { name: 'Send feedback' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(bundleCalls()).toEqual([]);
  });

  it('says what each level includes, what is never included, that the note is sent as typed and that the application sends nothing', () => {
    open();
    const standard = screen.getByRole('radio', { name: /Standard/ }) as HTMLInputElement;
    const fuller = screen.getByRole('radio', { name: /With review texts/ }) as HTMLInputElement;
    expect(standard.checked).toBe(true);
    expect(fuller.checked).toBe(false);
    expect(screen.getByText(/Numbers, labels, ids, timings, versions and your own feedback/)).toBeTruthy();
    expect(screen.getByText(/Also the text of review issues and council findings, failure messages in full/)).toBeTruthy();
    const never = screen.getByTestId('never-included').textContent ?? '';
    for (const part of ['uploads', 'text taken from uploads', 'internal stakeholder records', 'site passwords', 'names of your businesses', 'your user id', 'folders of this computer']) {
      expect(never, part).toContain(part);
    }
    expect(screen.getByText(/included as you typed them/)).toBeTruthy();
    expect(screen.getByText(/The application sends nothing/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('previews everything at the standard level by default: each section with its rows and size', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const table = await screen.findByRole('table');
    expect(bundleCalls()).toEqual([{ path: '/api/feedback-bundle/preview', body: { level: 'standard' } }]);
    const row = within(table).getByText('runs').closest('tr')!;
    expect(within(row).getByText('37')).toBeTruthy();
    expect(within(row).getByText('15 KB')).toBeTruthy();
    expect(screen.getByText(/File size: 2\.0 KB/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the period, the level and the note; a changed choice needs a new preview before saving', async () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: /With review texts/ }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-15' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'The setup took long.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('texts');
    expect(bundleCalls().at(-1)).toEqual({ path: '/api/feedback-bundle/preview', body: { level: 'with_texts', since: '2026-11-01', until: '2026-11-15', note: 'The setup took long.' } });
    fireEvent.click(screen.getByRole('radio', { name: /Standard/ }));
    expect(screen.queryByRole('table')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the first rows of a section on demand', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const table = await screen.findByRole('table');
    fireEvent.click(within(within(table).getByText('runs').closest('tr')!).getByRole('button', { name: 'Show first rows' }));
    expect(await screen.findByText(/"role": "worker"/)).toBeTruthy();
    expect(bundleCalls().at(-1)).toEqual({ path: '/api/feedback-bundle/preview', body: { level: 'standard', rows: { section: 'runs' } } });
  });

  it('Save downloads the file under its name and says that nothing was sent', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // The page cannot know what the desktop app's save dialog answered (it may have been cancelled),
    // so it does not say the file was saved: it says the file was offered, which holds either way.
    const said = await screen.findByText(new RegExp(`${FILE_NAME.replace(/\./g, '\\.')} was offered for saving`));
    expect(said.textContent).toBe(`${FILE_NAME} was offered for saving. ${OFFERED_NOTE}`);
    expect(OFFERED_NOTE).toBe('If you chose a place for it, it is there now; a browser puts it with its downloads. Nothing was sent: send the file to the person who asked you for it.');
    expect(screen.queryByText(/\bSaved\b/)).toBeNull();
    expect(bundleCalls().at(-1)).toEqual({ path: '/api/feedback-bundle', body: { level: 'standard' } });
    expect(clicked).toEqual([{ download: FILE_NAME, href: 'blob:feedback-bundle' }]);
    expect(screen.getByText(/Nothing was sent/)).toBeTruthy();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:feedback-bundle'));
  });

  it('shows why a preview failed', async () => {
    failPreview = true;
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('since must not be after until')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('the view never calls fetch and never imports the API client', () => {
    const src = readFileSync(join(import.meta.dirname, '../../web/src/views/SendFeedback.tsx'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/logic\/api/);
  });
});
