/**
 * The desktop shell (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4): an Electron
 * window around the local server. This file only wires Electron to the rules that live beside it:
 *
 * - `environment.ts`: the environment of the server, with the `PATH` a terminal would have;
 * - `server.ts`: starting the server, reading its port line, stopping it by asking;
 * - `navigation.ts`: what the window may show, and the page it opens on;
 * - `window.ts`: the window's options and the rules of its session (no Node, no permissions);
 * - `log.ts`: the log file.
 *
 * What the shell does:
 *
 * - One instance: a second launch brings the first window forward and starts no second server.
 * - It starts the server shipped in the app's resources as a child process, run by the app's own
 *   program as Node, with the application folder for data, configuration and logs.
 * - It opens one window on `http://127.0.0.1:<port>`: on the setup screen until the setup has passed.
 *   The window has no access to Node or to the shell: context isolation, a sandbox, no preload
 *   script, no `webview`, no permissions, no request to any other origin.
 * - A file the web app offers for download (the feedback bundle) gets a save dialog: it is written
 *   only where the person chose.
 * - Closing the window quits the app. Quitting asks the server to shut down and waits for it; the
 *   server stops the running agents and the research browser. Nothing is left running.
 *
 * `BIF_APP_DIR` names another application folder (a check with a throwaway folder).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { APP_DIR_ENV, APP_NAME, defaultAppDir } from '../src/core/runtime/paths.js';
import { serverEnv, terminalPath } from './environment.js';
import { LOG_FILE, openLog } from './log.js';
import { appOrigin, navigationVerdict, newWindowVerdict, pageUrl, requestAllowed, startUrl } from './navigation.js';
import { startServer, type RunningServer } from './server.js';
import { applySessionRules, windowOptions } from './window.js';

/** The application folder: data, configuration, logs, and (in `shell/`) what the window itself stores. */
const appDir = resolve(process.env[APP_DIR_ENV] || defaultAppDir());
const logsDir = join(appDir, 'logs');
/** The server shipped with the app; next to the shell when it is started from a checkout (`npm run desktop:dev`). */
const serverEntry = app.isPackaged ? join(process.resourcesPath, 'server', 'main.js') : resolve(app.getAppPath(), '..', 'server', 'main.js');
/** How long the setup check may take before the window opens without its answer. */
const SETUP_TIMEOUT_MS = 20_000;

let log: (text: string) => void = () => {};
let server: RunningServer | undefined;
let origin: string | undefined;
let mainWindow: BrowserWindow | undefined;
/** Set once the person quits: the server exiting is then expected. */
let quitting = false;
/** Set once the server has exited: the quit goes through. */
let serverStopped = false;
/** Set while the server is being stopped for a quit. */
let stopping = false;
let failed = false;

const say = (line: string) => log(`[shell] ${new Date().toISOString()} ${line}\n`);

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Shows a page of the web app in the window. */
function showPage(hash: string): void {
  if (!mainWindow || !origin) return;
  void mainWindow.loadURL(pageUrl(origin, hash));
  focusMainWindow();
}

/** Tells the person the app cannot go on, and ends it. Once: the first reason is the one shown. */
function fail(title: string, detail: string): void {
  if (failed) return;
  failed = true;
  say(`${title}: ${detail}`);
  dialog.showErrorBox(title, `${detail}\n\nThe log is in:\n${join(logsDir, LOG_FILE)}`);
  app.quit();
}

/** The navigation rule on one page (`navigation.ts`): every page the app ever creates gets it. */
function guard(contents: WebContents): void {
  const toBrowser = (url: string) => {
    say(`opened in the system browser: ${new URL(url).origin}`);
    void shell.openExternal(url);
  };
  // A link that asks for a new window never gets an app window.
  contents.setWindowOpenHandler(({ url }) => {
    if (origin && newWindowVerdict(url, origin) === 'browser') toBrowser(url);
    return { action: 'deny' };
  });
  const onNavigate = (event: { preventDefault(): void; url: string; isMainFrame: boolean }) => {
    const verdict = origin ? navigationVerdict(event.url, origin) : 'refuse';
    if (verdict === 'load') return;
    event.preventDefault();
    // Only a navigation of the page itself is a link the person followed; a frame is just refused.
    if (verdict === 'browser' && event.isMainFrame) toBrowser(event.url);
  };
  contents.on('will-frame-navigate', onNavigate);
  contents.on('will-redirect', onNavigate);
  // Some navigations are not announced before they happen (`about:blank` is one). Whatever the
  // window ends up on that is not the local server is replaced by the app's first page.
  contents.on('did-navigate', (_event, url) => {
    if (!origin || navigationVerdict(url, origin) === 'load') return;
    say(`the window left the app (${new URL(url).protocol}): back to the first page`);
    void contents.loadURL(pageUrl(origin, '#/'));
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function createWindow(url: string): void {
  // Isolated from Node and the shell (`window.ts`); nothing is added to these options here.
  const win = new BrowserWindow(windowOptions({ title: APP_NAME, devTools: !app.isPackaged }));
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = undefined;
    app.quit();
  });
  win.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    // -3 is a load the app itself replaced with another (a menu item clicked twice).
    if (isMainFrame && code !== -3 && !quitting) fail('The app could not show its page', `${description} (${code}) for ${failedUrl}`);
  });
  void win.loadURL(url);
}

function applicationMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const own: MenuItemConstructorOptions[] = [
    { label: 'Send feedback', click: () => showPage('#/feedback') },
    { label: 'Open data folder', click: () => void shell.openPath(appDir) },
    { label: 'Settings', click: () => showPage('#/settings') },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { label: 'File', submenu: [...own, { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions])] },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

/** The answer of the server's setup check, or undefined when it did not come in time. */
async function readSetup(base: string): Promise<unknown> {
  try {
    const res = await fetch(`${base}/api/setup`, { signal: AbortSignal.timeout(SETUP_TIMEOUT_MS) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

async function start(): Promise<void> {
  mkdirSync(appDir, { recursive: true });
  log = openLog(logsDir);
  say(`${APP_NAME} ${app.getVersion()} starting (Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform} ${process.arch})`);
  if (!existsSync(serverEntry)) return fail('The app is incomplete', `The server was not found at ${serverEntry}. Install the app again.`);

  // Nothing but the local server, for every page of the session; no permission is ever granted.
  const ses = session.defaultSession;
  applySessionRules(ses, (url) => origin !== undefined && requestAllowed(url, origin, { devTools: !app.isPackaged }));
  // A download (the feedback bundle) is written only where the person chooses. The shell asks here,
  // before a byte is written, and cancels the download when no place was chosen. Electron's own
  // dialog is not used: in a check it wrote the file to the Downloads folder when the app quit while
  // the dialog was still open. While this dialog is open the app waits for the answer.
  ses.on('will-download', (event, item) => {
    const name = item.getFilename();
    say(`a file is offered for saving (${name}): the person is asked where`);
    const options = { defaultPath: join(app.getPath('downloads'), name) };
    const chosen = mainWindow ? dialog.showSaveDialogSync(mainWindow, options) : dialog.showSaveDialogSync(options);
    if (!chosen) {
      event.preventDefault();
      say(`saving ${name}: no place was chosen, nothing was written`);
      return;
    }
    item.setSavePath(chosen);
    item.once('done', (_e, state) => say(`saving ${name}: ${state}`));
  });

  const found = await terminalPath();
  // The person quit while the PATH was read: no server is started for an app that is ending.
  if (quitting) return;
  say(`PATH for the server and the agent CLIs: from the ${found.source}`);
  const running = startServer({
    command: process.execPath,
    args: [serverEntry],
    env: serverEnv(process.env, { appDir, version: app.getVersion(), path: found.path }),
    cwd: appDir,
    log: (text) => log(text),
  });
  server = running;
  void running.exited.then(({ code, signal }) => {
    serverStopped = true;
    say(`the server exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    // Before it said its port, the failed start below says why.
    if (!quitting && origin) fail('The app stopped working', 'Its server ended unexpectedly. Start the app again.');
  });

  let port: number;
  try {
    port = await running.port;
  } catch (e) {
    if (!quitting) fail('The app could not start', (e as Error).message);
    return;
  }
  origin = appOrigin(port);
  say(`the server listens on ${origin}`);
  Menu.setApplicationMenu(applicationMenu());
  const setup = await readSetup(origin);
  if (quitting) return;
  const url = startUrl(origin, setup);
  say(`the window opens on ${url}`);
  createWindow(url);
}

// What the window itself stores (its cache, its settings) goes inside the application folder too, in
// its own folder beside the data. Set before anything else: the single-instance lock lives there.
app.setName(APP_NAME);
app.setPath('userData', join(appDir, 'shell'));

if (!app.requestSingleInstanceLock()) {
  // A second launch: the first instance is told (`second-instance`) and this one ends. No second server.
  app.quit();
} else {
  app.on('second-instance', () => {
    say('a second launch: the window of this one is brought forward');
    focusMainWindow();
  });
  app.on('web-contents-created', (_event, contents) => guard(contents));
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    quitting = true;
    if (!server || serverStopped) return;
    // Hold the quit until the server has shut down (it stops the running agents and the research browser), then quit for real.
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    mainWindow?.hide();
    void server.stop().then((how) => {
      say(`the server was stopped (${how})`);
      serverStopped = true;
      app.quit();
    });
  });
  void app.whenReady().then(start).catch((e: unknown) => fail('The app could not start', e instanceof Error ? e.message : String(e)));
}
