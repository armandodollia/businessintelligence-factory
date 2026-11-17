/**
 * The window of the desktop app and what its pages may do (design 2026-11-16 §4.1): context
 * isolation, a sandbox, no Node integration, no preload script, no `webview`, no permission granted,
 * no request to any other origin. `desktop/main.ts` builds its window and sets up its session with
 * these two functions and adds nothing to them.
 */
import { describe, expect, it } from 'vitest';
import { applySessionRules, windowOptions, type SessionRules } from '../../desktop/window.js';

describe('the window', () => {
  it('isolates its pages: context isolation, a sandbox, no Node integration anywhere, no webview', () => {
    for (const devTools of [false, true]) {
      expect(windowOptions({ title: 'App', devTools }).webPreferences).toMatchObject({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      });
    }
  });

  it('has no preload script: nothing of the shell runs in a page', () => {
    expect(windowOptions({ title: 'App', devTools: true }).webPreferences).not.toHaveProperty('preload');
  });

  it('has the developer tools only in a build that is not packaged', () => {
    expect(windowOptions({ title: 'App', devTools: false }).webPreferences.devTools).toBe(false);
    expect(windowOptions({ title: 'App', devTools: true }).webPreferences.devTools).toBe(true);
  });

  it('is not shown before its page is ready', () => {
    expect(windowOptions({ title: 'Business Intelligence Factory', devTools: false })).toMatchObject({ show: false });
  });
});

describe('the session of the window', () => {
  /** A session that records the handlers it is given, as Electron's does. */
  function session() {
    const handlers: {
      request?: (details: { url: string }, answer: (r: { cancel: boolean }) => void) => void;
      permissionRequest?: (contents: unknown, permission: string, answer: (granted: boolean) => void) => void;
      permissionCheck?: (contents: unknown, permission: string) => boolean;
    } = {};
    const ses: SessionRules = {
      webRequest: { onBeforeRequest: (h) => void (handlers.request = h) },
      setPermissionRequestHandler: (h) => void (handlers.permissionRequest = h),
      setPermissionCheckHandler: (h) => void (handlers.permissionCheck = h),
    };
    return { ses, handlers };
  }

  it('refuses every permission, asked for or checked', () => {
    const { ses, handlers } = session();
    applySessionRules(ses, () => true);
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'openExternal', 'fullscreen', 'pointerLock', 'something new']) {
      const answers: boolean[] = [];
      handlers.permissionRequest!(null, permission, (granted) => answers.push(granted));
      expect(answers, permission).toEqual([false]);
      expect(handlers.permissionCheck!(null, permission), permission).toBe(false);
    }
  });

  it('cancels every request the rule does not allow, and asks the rule about each address', () => {
    const { ses, handlers } = session();
    const asked: string[] = [];
    applySessionRules(ses, (url) => {
      asked.push(url);
      return url.startsWith('http://127.0.0.1:4317/');
    });
    const cancelled = (url: string) => {
      let answer: { cancel: boolean } | undefined;
      handlers.request!({ url }, (r) => (answer = r));
      return answer!.cancel;
    };
    expect(cancelled('http://127.0.0.1:4317/api/setup')).toBe(false);
    expect(cancelled('https://example.com/tracker.js')).toBe(true);
    expect(asked).toEqual(['http://127.0.0.1:4317/api/setup', 'https://example.com/tracker.js']);
  });
});
