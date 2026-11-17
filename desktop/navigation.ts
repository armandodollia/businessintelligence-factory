/**
 * What the desktop window may show (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1,
 * §6). The window is a view on the local server and on nothing else:
 *
 * - it loads only `http://127.0.0.1:<port>`, the port the server chose at this start;
 * - a link to any other web address opens in the system browser, never in the window;
 * - a link that asks for a new window never gets an app window;
 * - no request leaves for another origin, so a page cannot pull in remote content;
 * - anything that is not a web address (a file, a script, another program's scheme) is refused.
 *
 * Addresses are parsed the way the browser parses them (`URL`), never matched as text, so an address
 * made to look like the local server (`http://127.0.0.1:1234@example.com/`) is seen for what it is.
 *
 * Nothing here imports Electron: these are the rules, `main.ts` applies them.
 */

/** The address of the local server on `port`. */
export function appOrigin(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  return `http://127.0.0.1:${port}`;
}

/** A page of the web app: `hash` is a route of its router (`#/settings`). */
export function pageUrl(origin: string, hash: string): string {
  return `${origin}/${hash}`;
}

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** True when `u` is a page of the local server: the scheme too, since a `blob:` address carries its page's origin. */
const isLocal = (u: URL, origin: string): boolean => u.protocol === 'http:' && u.origin === origin;

/** What the system browser (or mail program) may be handed. Never a file or another program's scheme. */
const forBrowser = (u: URL): boolean => u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';

/** `load`: show it in the window. `browser`: hand it to the system browser. `refuse`: do nothing. */
export type Verdict = 'load' | 'browser' | 'refuse';

/** Where a navigation of the window goes. */
export function navigationVerdict(url: string, origin: string): Verdict {
  const u = parse(url);
  if (!u) return 'refuse';
  if (isLocal(u, origin)) return 'load';
  return forBrowser(u) ? 'browser' : 'refuse';
}

/**
 * Where a link that asks for a new window goes (`target="_blank"`, `window.open`). The app has one
 * window: a web address opens in the system browser, the local server's own files (a screenshot, an
 * upload) among them, which the system browser can load like any local page.
 */
export function newWindowVerdict(url: string, origin: string): Exclude<Verdict, 'load'> {
  return navigationVerdict(url, origin) === 'refuse' ? 'refuse' : 'browser';
}

/**
 * Whether the window may make this request: the local server (pages, API, live events), and data the
 * page already holds (`blob:` of its own origin, `data:`). `devTools`: also the developer tools' own
 * pages, in a build that has them.
 */
export function requestAllowed(url: string, origin: string, opts: { devTools?: boolean } = {}): boolean {
  const u = parse(url);
  if (!u) return false;
  if (isLocal(u, origin)) return true;
  if (u.protocol === 'ws:') return `http://${u.host}` === origin;
  if (u.protocol === 'blob:') return u.origin === origin;
  if (u.protocol === 'data:') return true;
  return opts.devTools === true && u.protocol === 'devtools:';
}

/**
 * Whether the first-run setup has passed, from the answer of `GET /api/setup`: a configuration was
 * written and at least one agent CLI is ready. Undefined when the answer does not say (the check is
 * not available, or the request failed).
 */
export function setupPassed(answer: unknown): boolean | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  const a = answer as { available?: unknown; configExists?: unknown; report?: unknown };
  if (a.available !== true || typeof a.configExists !== 'boolean' || !a.report || typeof a.report !== 'object') return undefined;
  const canResearch = (a.report as { canResearch?: unknown }).canResearch;
  if (typeof canResearch !== 'boolean') return undefined;
  return a.configExists && canResearch;
}

/**
 * The page the window opens on (design §4.3): the home page only when the setup has passed. Until
 * then, and when the check could not be made or did not answer in time, it is the setup screen (the
 * "This computer" section of the Settings page), where the check can be run again.
 */
export function startUrl(origin: string, setup: unknown): string {
  return pageUrl(origin, setupPassed(setup) === true ? '#/' : '#/settings');
}
