/**
 * The window of the desktop app and what its pages may do (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1). The window is a view on the local server
 * and has no access to Node or to the shell:
 *
 * - context isolation and a sandbox;
 * - no Node integration, in the page, in a worker or in a frame;
 * - no preload script: nothing of the shell runs in a page;
 * - no `webview`;
 * - no permission is ever granted (camera, location, notifications, the clipboard, …);
 * - no request leaves for another origin (`requestAllowed` in `navigation.ts` is the rule).
 *
 * Nothing here imports Electron: these are the rules, and `main.ts` builds its window and sets up its
 * session with them, adding nothing.
 */

/** What `windowOptions` needs to know of the app. */
export type WindowInfo = {
  title: string;
  /** The developer tools: only in a build that is not packaged. */
  devTools: boolean;
};

/** The options of the one window (Electron's `BrowserWindowConstructorOptions`). */
export function windowOptions(info: WindowInfo) {
  return {
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // Shown when its page is ready.
    show: false,
    title: info.title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // The spell checker would fetch its dictionaries from the network on Windows.
      spellcheck: false,
      devTools: info.devTools,
    },
  };
}

/** The part of Electron's session the rules are set on. */
export type SessionRules = {
  webRequest: { onBeforeRequest(handler: (details: { url: string }, answer: (response: { cancel: boolean }) => void) => void): void };
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, answer: (granted: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void;
};

/**
 * Sets the rules of every page of the session: a request is cancelled unless `allowed` says its
 * address may be asked for, and no permission is granted, whether a page asks for it or checks it.
 */
export function applySessionRules(session: SessionRules, allowed: (url: string) => boolean): void {
  session.webRequest.onBeforeRequest((details, answer) => answer({ cancel: !allowed(details.url) }));
  session.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  session.setPermissionCheckHandler(() => false);
}
