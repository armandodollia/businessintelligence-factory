/** Query parameters that identify a campaign or referrer, not the page (design §8.1). */
function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || n.startsWith('mc_') || n === 'gclid' || n === 'fbclid' || n === 'ref';
}

/**
 * Normalized page key (design §8.1): lowercase host without `www.`, no fragment, no tracking
 * parameters, no trailing slash. Credentials and default ports are dropped. Only http(s) URLs
 * have a key; anything else (or unparseable input) returns `undefined`.
 */
export function urlKey(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const host = u.host.toLowerCase().replace(/^www\./, '');
  const kept: string[] = [];
  for (const part of u.search.slice(1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawName = eq < 0 ? part : part.slice(0, eq);
    let name = rawName;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch {
      // keep the raw name
    }
    if (!isTrackingParam(name)) kept.push(part);
  }
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${host}${path}${kept.length ? `?${kept.join('&')}` : ''}`;
}
