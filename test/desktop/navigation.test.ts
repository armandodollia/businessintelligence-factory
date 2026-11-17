/**
 * What the desktop window may show (design 2026-11-16 §4.1, §6): only the local server. Every other
 * address goes to the system browser or nowhere.
 */
import { describe, expect, it } from 'vitest';
import { appOrigin, navigationVerdict, newWindowVerdict, pageUrl, requestAllowed, setupPassed, startUrl } from '../../desktop/navigation.js';

const ORIGIN = appOrigin(51234);

describe('the address of the app', () => {
  it('is the local server on the port it chose', () => {
    expect(ORIGIN).toBe('http://127.0.0.1:51234');
    expect(pageUrl(ORIGIN, '#/feedback')).toBe('http://127.0.0.1:51234/#/feedback');
    expect(pageUrl(ORIGIN, '#/')).toBe('http://127.0.0.1:51234/#/');
  });

  it('is refused for a port that is none', () => {
    for (const bad of [0, -1, 65536, 1.5, Number.NaN]) expect(() => appOrigin(bad), String(bad)).toThrow(/port/);
  });
});

describe('the navigation rule', () => {
  it('loads the pages of the local server, and nothing else, in the window', () => {
    for (const url of [`${ORIGIN}/`, `${ORIGIN}/#/settings`, `${ORIGIN}/api/artifacts/a1`, `${ORIGIN}/some/page?x=1#y`]) {
      expect(navigationVerdict(url, ORIGIN), url).toBe('load');
    }
  });

  it('sends web addresses of any other origin to the system browser', () => {
    for (const url of [
      'https://example.com/',
      'http://example.com/page',
      'mailto:someone@example.com',
      // The same machine, but not the server of this app: another port, another name, another scheme.
      'http://127.0.0.1:51235/',
      'http://127.0.0.1/',
      'http://localhost:51234/',
      'https://127.0.0.1:51234/',
      'http://[::1]:51234/',
    ]) {
      expect(navigationVerdict(url, ORIGIN), url).toBe('browser');
    }
  });

  it('is not fooled by an address made to look like the local server', () => {
    for (const url of [
      'http://127.0.0.1:51234@example.com/', // the local address as a user name
      'http://127.0.0.1.example.com:51234/', // as a sub-domain
      'http://example.com/#http://127.0.0.1:51234/',
      'http://example.com/?next=http://127.0.0.1:51234/',
      'http://2130706433:51235/', // 127.0.0.1 as a number, another port
    ]) {
      expect(navigationVerdict(url, ORIGIN), url).toBe('browser');
    }
    // No address at all (a port cannot have dots): refused.
    expect(navigationVerdict('http://127.0.0.1:51234.example.com/', ORIGIN)).toBe('refuse');
  });

  it('refuses everything that is not a web address: files, scripts, data, other programs', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'blob:http://127.0.0.1:51234/1c0f',
      'chrome://settings',
      'about:blank',
      'vscode://file/x',
      'smb://server/share',
      'ftp://example.com/x',
      'not an address',
      '',
    ]) {
      expect(navigationVerdict(url, ORIGIN), url).toBe('refuse');
    }
  });
});

describe('a link that asks for a new window', () => {
  it('never gets an app window: web addresses, the local server among them, open in the system browser', () => {
    expect(newWindowVerdict(`${ORIGIN}/api/artifacts/a1`, ORIGIN)).toBe('browser');
    expect(newWindowVerdict('https://example.com/source', ORIGIN)).toBe('browser');
    expect(newWindowVerdict('mailto:someone@example.com', ORIGIN)).toBe('browser');
  });

  it('is refused for anything else', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'data:text/html,x', 'vscode://file/x', '']) {
      expect(newWindowVerdict(url, ORIGIN), url).toBe('refuse');
    }
  });
});

describe('what the window may request', () => {
  it('is the local server, and data the page already holds', () => {
    for (const url of [`${ORIGIN}/assets/app.js`, `${ORIGIN}/api/events`, 'ws://127.0.0.1:51234/live', 'blob:http://127.0.0.1:51234/1c0f', 'data:image/png;base64,AAAA']) {
      expect(requestAllowed(url, ORIGIN), url).toBe(true);
    }
  });

  it('is no remote content of any kind', () => {
    for (const url of [
      'https://example.com/pixel.png',
      'http://example.com/script.js',
      'https://fonts.googleapis.com/css',
      'wss://example.com/socket',
      'ws://127.0.0.1:51235/live',
      'http://127.0.0.1:51235/',
      'http://localhost:51234/',
      'blob:https://example.com/1c0f',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'nonsense',
    ]) {
      expect(requestAllowed(url, ORIGIN), url).toBe(false);
    }
  });

  it("allows the developer tools' own pages only in a build that has them", () => {
    expect(requestAllowed('devtools://devtools/bundled/inspector.html', ORIGIN)).toBe(false);
    expect(requestAllowed('devtools://devtools/bundled/inspector.html', ORIGIN, { devTools: true })).toBe(true);
    expect(requestAllowed('https://example.com/', ORIGIN, { devTools: true })).toBe(false);
  });
});

describe('the first page', () => {
  const found = { available: true, configExists: true, report: { canResearch: true } };

  it('is the setup screen until a configuration is written and research can start', () => {
    expect(setupPassed(found)).toBe(true);
    expect(startUrl(ORIGIN, found)).toBe(`${ORIGIN}/#/`);
    for (const notYet of [
      { available: true, configExists: false, report: { canResearch: true } }, // nothing written yet
      { available: true, configExists: true, report: { canResearch: false } }, // no agent CLI is ready
      { available: true, configExists: false, report: { canResearch: false } },
    ]) {
      expect(setupPassed(notYet), JSON.stringify(notYet)).toBe(false);
      expect(startUrl(ORIGIN, notYet)).toBe(`${ORIGIN}/#/settings`);
    }
  });

  it('is the setup screen too when the check could not be made or did not answer in time: only a check that passed opens the home page', () => {
    for (const unknown of [undefined, null, 'nonsense', {}, { available: false, report: null, configExists: false }, { available: true, configExists: true, report: null }]) {
      expect(setupPassed(unknown), JSON.stringify(unknown)).toBeUndefined();
      expect(startUrl(ORIGIN, unknown), JSON.stringify(unknown)).toBe(`${ORIGIN}/#/settings`);
    }
  });
});
