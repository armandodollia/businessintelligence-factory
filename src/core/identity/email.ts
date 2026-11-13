import { randomBytes } from 'node:crypto';
import type { BifConfig } from '../config/schema.js';

/** Disposable inbox provider (spec §6.5, builder's choice behind an interface). */
export interface EmailProvider {
  createInbox(): Promise<{ address: string; password?: string }>;
  /** Latest messages of an inbox, newest first. */
  latest(address: string): Promise<Array<{ subject: string; body: string }>>;
}

const localPart = () => `bif${randomBytes(6).toString('hex')}`;
export const randomPassword = () => randomBytes(18).toString('base64url');

/**
 * Catch-all domain the user owns: any `<anything>@domain` reaches the user's mailbox. There is no
 * inbox API, so `latest` returns `[]`; agents ask the user (`request_user_action`) for codes.
 */
export class CatchallEmailProvider implements EmailProvider {
  constructor(private readonly domain: string) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error(`invalid catch-all domain '${domain}'`);
  }

  async createInbox(): Promise<{ address: string }> {
    return { address: `${localPart()}@${this.domain.toLowerCase()}` };
  }

  async latest(): Promise<Array<{ subject: string; body: string }>> {
    return [];
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `hydra:member` (JSON-LD, the default) or a plain array (`Accept: application/json`). */
function members(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  const m = (body as Record<string, unknown> | null)?.['hydra:member'];
  return Array.isArray(m) ? (m as Array<Record<string, unknown>>) : [];
}

/** mail.tm inbox API (https://docs.mail.tm). */
export class MailTmProvider implements EmailProvider {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly passwords = new Map<string, string>();
  private readonly passwordFor: ((address: string) => string | undefined) | undefined;

  constructor(
    opts: { fetch?: FetchLike; baseUrl?: string; passwordFor?: (address: string) => string | undefined } = {},
  ) {
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? 'https://api.mail.tm').replace(/\/+$/, '');
    this.passwordFor = opts.passwordFor;
  }

  private async request(method: string, path: string, body?: unknown, token?: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/ld+json, application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`mail.tm ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async createInbox(): Promise<{ address: string; password: string }> {
    const domain = members(await this.request('GET', '/domains')).find(
      (d) => typeof d.domain === 'string' && d.isActive !== false,
    )?.domain as string | undefined;
    if (!domain) throw new Error('mail.tm returned no active domain');
    const password = randomPassword();
    const account = (await this.request('POST', '/accounts', { address: `${localPart()}@${domain}`, password })) as {
      address?: string;
    };
    if (typeof account?.address !== 'string') throw new Error('mail.tm account response has no address');
    this.passwords.set(account.address, password);
    return { address: account.address, password };
  }

  async latest(address: string): Promise<Array<{ subject: string; body: string }>> {
    const password = this.passwords.get(address) ?? this.passwordFor?.(address);
    if (!password) throw new Error(`no password known for inbox ${address}`);
    const { token } = (await this.request('POST', '/token', { address, password })) as { token: string };
    const list = members(await this.request('GET', '/messages', undefined, token)).slice(0, 10);
    const out: Array<{ subject: string; body: string }> = [];
    for (const m of list) {
      const full = (await this.request('GET', `/messages/${String(m.id)}`, undefined, token)) as Record<string, unknown>;
      const body = typeof full.text === 'string' ? full.text : typeof m.intro === 'string' ? m.intro : '';
      out.push({ subject: String(full.subject ?? m.subject ?? ''), body });
    }
    return out;
  }
}

/** Provider from config (`identity.emailProvider`). */
export function createEmailProvider(
  config: Pick<BifConfig, 'identity'>,
  opts: { fetch?: FetchLike; passwordFor?: (address: string) => string | undefined } = {},
): EmailProvider {
  if (config.identity.emailProvider === 'catchall') {
    if (!config.identity.catchallDomain) throw new Error('identity.catchallDomain is required for the catchall provider');
    return new CatchallEmailProvider(config.identity.catchallDomain);
  }
  return new MailTmProvider(opts);
}
