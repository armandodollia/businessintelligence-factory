// @vitest-environment jsdom
/**
 * The setup check and the data folder on the Settings page (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.2, §4.3). Behaviour in web/src/logic, markup
 * in the view, no fetch in views.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliState } from '../../web/src/logic/setup.js';
import { Settings } from '../../web/src/views/Settings.js';

const cli = (id: string, name: string, more: Record<string, unknown>) => ({
  id, name, command: id, found: true, runs: true, signedIn: 'yes', signedInDetail: `\`${id}\` says so. It cannot tell whether the login is still accepted.`, howTo: '', ready: true, path: `/opt/tools/${id}`, onPath: true, version: '1.2.3', ...more,
});

const REPORT = {
  checkedAt: '2026-11-16T10:00:00.000Z',
  platform: 'darwin',
  clis: [
    cli('claude', 'Claude Code', { version: '2.1.325' }),
    cli('codex', 'Codex', { signedIn: 'no', ready: false, howTo: 'Sign in: run `codex login` in a terminal.', path: '/Users/t/.local/bin/codex', onPath: false }),
    { id: 'opencode', name: 'OpenCode', command: 'opencode', found: false, runs: false, signedIn: 'unknown', signedInDetail: 'Not checked: the command was not found.', howTo: 'Install OpenCode (https://opencode.ai), then sign in with `opencode auth login`.', ready: false },
  ],
  chrome: { found: false, howTo: 'Install Google Chrome (https://www.google.com/chrome/): the research browser uses it.' },
  canResearch: true,
  summary: 'Research can start with Claude Code. Google Chrome was not found: tasks that need the research browser will fail.',
};

type Reply = { status?: number; body: unknown };
let info: Record<string, unknown>;
let calls: Array<{ method: string; path: string; search: string; body: unknown }>;
let applyReply: () => Reply;
let config: Record<string, unknown>;

beforeEach(() => {
  calls = [];
  config = { providers: { claude: { enabled: true } }, marker: 'before' };
  info = {
    available: true, report: REPORT, configExists: false, version: '0.1.0', packaged: true, canOpenFolder: true,
    folders: { app: '/Users/t/Library/Application Support/Business Intelligence Factory', data: '/Users/t/Library/Application Support/Business Intelligence Factory/data', config: '/Users/t/Library/Application Support/Business Intelligence Factory/bif.config.json', logs: '/Users/t/Library/Application Support/Business Intelligence Factory/logs', browserProfile: '/Users/t/Library/Application Support/Business Intelligence Factory/data/browser-profile', open: '/Users/t/Library/Application Support/Business Intelligence Factory' },
  };
  applyReply = () => {
    info = { ...info, configExists: true };
    config = { ...config, marker: 'after' };
    return { body: { config, report: REPORT, configExists: true } };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, search: url.search, body });
      const reply = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url.pathname === '/api/setup') return reply({ body: info });
      if (method === 'POST' && url.pathname === '/api/setup/apply') return reply(applyReply());
      if (method === 'POST' && url.pathname === '/api/setup/open-folder') return reply({ body: { opened: (info.folders as { open: string }).open } });
      if (method === 'GET' && url.pathname === '/api/config') return reply({ body: config });
      if (method === 'GET' && url.pathname === '/api/council') return reply({ body: { council: null } });
      return reply({ status: 404, body: { error: 'not found' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setupCalls = () => calls.filter((c) => c.path.startsWith('/api/setup'));
const section = async () => (await screen.findByRole('heading', { name: 'This computer' })).closest('section')!;
const rowOf = (el: HTMLElement, name: string) => within(el).getByRole('rowheader', { name }).closest('tr')!;

describe('the Settings page: this computer', () => {
  it('comes first on the page: before the configuration editor, which is long', async () => {
    const { container } = render(<Settings />);
    const s = await section();
    const editor = container.querySelector('textarea')!;
    expect(editor).toBeTruthy();
    // The section is not inside anything the editor follows, and the editor comes after it in the page.
    expect(s.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const council = screen.getByRole('heading', { name: 'Review council' });
    expect(editor.compareDocumentPosition(council) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing but the page's own heading is above it.
    expect(s.previousElementSibling?.tagName).toBe('H2');
  });

  it('shows each agent CLI: installed or not and where, its version, signed in or not, and what to do', async () => {
    render(<Settings />);
    const s = await section();
    const claude = rowOf(s, 'Claude Code');
    expect(claude.textContent).toContain('/opt/tools/claude');
    expect(claude.textContent).toContain('2.1.325');
    expect(within(claude).getByText('signed in')).toBeTruthy();
    const codex = rowOf(s, 'Codex');
    expect(within(codex).getByText('not signed in')).toBeTruthy();
    expect(codex.textContent).toContain('Sign in: run `codex login` in a terminal.');
    expect(codex.textContent).toContain('/Users/t/.local/bin/codex');
    expect(codex.textContent).toContain('not on PATH');
    const opencode = rowOf(s, 'OpenCode');
    expect(within(opencode).getByText('not found')).toBeTruthy();
    expect(opencode.textContent).toContain('Install OpenCode');
    const chrome = rowOf(s, 'Google Chrome');
    expect(within(chrome).getByText('not found')).toBeTruthy();
    expect(chrome.textContent).toContain('Install Google Chrome');
    expect(within(s).getByText(REPORT.summary)).toBeTruthy();
    // How sign-in was judged, and what the check cannot tell.
    expect(claude.textContent).toContain('It cannot tell whether the login is still accepted.');
  });

  it('shows the version and where the data is, and opens the folder', async () => {
    render(<Settings />);
    const s = await section();
    expect(s.textContent).toContain('Version 0.1.0');
    expect(s.textContent).toContain('/Users/t/Library/Application Support/Business Intelligence Factory');
    expect(s.textContent).toContain('bif.config.json');
    expect(s.textContent).toContain('/logs');
    expect(s.textContent).toContain('Research browser profile: /Users/t/Library/Application Support/Business Intelligence Factory/data/browser-profile');
    fireEvent.click(within(s).getByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(setupCalls().some((c) => c.method === 'POST' && c.path === '/api/setup/open-folder')).toBe(true));
    expect(calls.find((c) => c.path === '/api/setup/open-folder')!.body).toEqual({});
  });

  it('"Check again" runs the check anew', async () => {
    render(<Settings />);
    const s = await section();
    expect(setupCalls()).toEqual([{ method: 'GET', path: '/api/setup', search: '', body: undefined }]);
    info = { ...info, report: { ...REPORT, canResearch: false, summary: 'No agent CLI was found, so research cannot start.' } };
    fireEvent.click(within(s).getByRole('button', { name: 'Check again' }));
    expect(await within(s).findByText('No agent CLI was found, so research cannot start.')).toBeTruthy();
    expect(setupCalls().at(-1)).toMatchObject({ method: 'GET', path: '/api/setup', search: '?refresh=1' });
  });

  it('with no configuration yet: one button writes the configuration that fits, and the editor shows it', async () => {
    render(<Settings />);
    const s = await section();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('"marker": "before"');
    fireEvent.click(within(s).getByRole('button', { name: 'Write the configuration for what was found' }));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('"marker": "after"'));
    expect(calls.find((c) => c.path === '/api/setup/apply')!.body).toEqual({});
    expect(await within(s).findByText(/The configuration was written/)).toBeTruthy();
  });

  it('with a configuration: replacing it is asked for explicitly, in two steps', async () => {
    info = { ...info, configExists: true };
    render(<Settings />);
    const s = await section();
    expect(within(s).queryByRole('button', { name: 'Write the configuration for what was found' })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Replace the configuration with what was found' }));
    expect(calls.some((c) => c.path === '/api/setup/apply')).toBe(false);
    expect(within(s).getByText(/switches off the agent CLIs that were not found/)).toBeTruthy();
    fireEvent.click(within(s).getByRole('button', { name: 'Cancel' }));
    expect(within(s).queryByRole('button', { name: 'Replace it' })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Replace the configuration with what was found' }));
    fireEvent.click(within(s).getByRole('button', { name: 'Replace it' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/setup/apply')?.body).toEqual({ overwrite: true }));
  });

  it("shows the server's message when writing fails", async () => {
    applyReply = () => ({ status: 409, body: { error: 'a configuration already exists (/x/bif.config.json): it is left as it is unless you ask to replace it' } });
    render(<Settings />);
    const s = await section();
    fireEvent.click(within(s).getByRole('button', { name: 'Write the configuration for what was found' }));
    expect(await within(s).findByText(/a configuration already exists/)).toBeTruthy();
  });

  it('a server without the check still shows the folders, and offers no check', async () => {
    info = { ...info, available: false, report: null, canOpenFolder: false, packaged: false, folders: { data: '/repo/data', config: '/repo/bif.config.json', open: '/repo/data' } };
    render(<Settings />);
    const s = await section();
    expect(s.textContent).toContain('/repo/data');
    expect(within(s).getByText(/The setup check is not available on this server/)).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(within(s).queryByRole('button', { name: 'Open folder' })).toBeNull();
  });

  it('an answer that is not the setup check (an older server) does not break the page', async () => {
    info = [] as unknown as Record<string, unknown>;
    render(<Settings />);
    const s = await section();
    expect(await within(s).findByText('This server did not answer the setup check.')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('with no agent CLI ready, says that research cannot start', async () => {
    info = { ...info, report: { ...REPORT, canResearch: false, clis: REPORT.clis.map((c) => ({ ...c, found: false, ready: false })), summary: 'No agent CLI was found, so research cannot start. Install Claude Code, Codex or OpenCode and sign in.' } };
    render(<Settings />);
    const s = await section();
    const summary = within(s).getByText(/research cannot start/);
    expect(summary.className).toContain('error');
  });
});

describe('cliState', () => {
  it('says the state of an agent CLI in two words', () => {
    expect(cliState({ found: false, runs: false, signedIn: 'unknown' })).toBe('not found');
    expect(cliState({ found: true, runs: false, signedIn: 'unknown' })).toBe('does not run');
    expect(cliState({ found: true, runs: true, signedIn: 'yes' })).toBe('signed in');
    expect(cliState({ found: true, runs: true, signedIn: 'no' })).toBe('not signed in');
    expect(cliState({ found: true, runs: true, signedIn: 'unknown' })).toBe('sign-in not known');
  });
});

describe('no fetch in the view', () => {
  it('the setup view and the Settings page call the server only through web/src/logic', () => {
    for (const file of ['SetupCheck.tsx', 'Settings.tsx']) {
      const src = readFileSync(join(import.meta.dirname, '../../web/src/views', file), 'utf8');
      expect(src, file).not.toMatch(/\bfetch\(/);
    }
  });
});
