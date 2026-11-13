/**
 * KS-4 design-thread ruling "redact before cutting, at both points": a secret is never split by the
 * `maxTextChars` cap, a chunk boundary, the 300-char error cut or a snippet window — at ingest or at
 * serve time (identities created after ingest included).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import { ingestArtifact } from '../../../src/core/knowledge/ingest.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { artifactText, chunkSnippet, servedChunkText, servedTextState } from '../../../src/core/knowledge/texts.js';
import { redactRange, stripSecretTail } from '../../../src/core/knowledge/trust.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { REDACTED } from '../../../src/core/store/redact.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-13T10:00:00.000Z';
const SECRET = 'Zq9xK2mPw7Lr';

function cfg(extraction: Record<string, number> = {}): BifConfig {
  return { ...defaultConfig, knowledge: { ...(defaultConfig.knowledge ?? {}), extraction } };
}

function setup(config: BifConfig = cfg()) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-kcuts-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  store.workspaces.insert({ id: 'R', name: 'R', sector: 's', createdAt: T0 });
  const artifacts = new ArtifactStore(store, join(dir, 'data'));
  const addSecret = (password = SECRET) =>
    store.identities.insert({ id: `idn_${password}`, workspaceId: 'R', site: 'x.test', name: 'n', email: 'n@x.test', password, createdAt: T0 });
  return { store, artifacts, config, addSecret, deps: { store, artifacts, config } };
}

/** No 4+ character piece of SECRET (prefix or suffix) appears in `text`. */
function noPartOfSecret(text: string): void {
  for (let n = 4; n <= SECRET.length; n++) {
    expect(text).not.toContain(SECRET.slice(0, n));
    expect(text).not.toContain(SECRET.slice(SECRET.length - n));
  }
}

describe('trust helpers', () => {
  it('stripSecretTail drops a secret cut in half at the end, and nothing else', () => {
    expect(stripSecretTail(`abc ${SECRET.slice(0, 5)}`, [SECRET])).toBe('abc ');
    expect(stripSecretTail('abc def', [SECRET])).toBe('abc def');
  });

  it('redactRange masks a secret that straddles either edge of the range', () => {
    const full = `aaaa ${SECRET} bbbb`;
    const mid = 5 + 6; // inside the secret
    expect(redactRange(full, 0, mid, [SECRET])).toBe(`aaaa ${REDACTED}`);
    expect(redactRange(full, mid, full.length, [SECRET])).toBe(`${REDACTED} bbbb`);
    expect(redactRange(full, 0, 4, [SECRET])).toBe('aaaa');
  });
});

describe('ingest: the full text is redacted before the maxTextChars cap and before chunking', () => {
  it('a secret straddling the cap leaves no prefix in the stored text', async () => {
    const t = setup(cfg({ maxTextChars: 60 }));
    t.addSecret();
    const body = `${'word '.repeat(10)}xx ${SECRET} and then a lot more text after the secret to exceed the cap.`;
    expect(body.indexOf(SECRET)).toBeLessThan(60);
    expect(body.indexOf(SECRET) + SECRET.length).toBeGreaterThan(60);
    const a = t.artifacts.save({ workspaceId: 'R', kind: 'text', mime: 'text/plain', bytes: body });
    const r = await ingestArtifact(t.deps, a.id);
    expect(r).toMatchObject({ status: 'too_large', truncated: true });
    const text = artifactText(t.store, a.id)!;
    expect(text.length).toBeLessThanOrEqual(60);
    noPartOfSecret(text);
    expect(knowledgeRepos(t.store).artifactTexts.get(a.id)!.error).toMatch(/maxTextChars \(60\)/);
  });

  it('a secret straddling the extractor cut (cap + margin) is dropped, not half-indexed', async () => {
    const t = setup(cfg({ maxTextChars: 1000 }));
    t.addSecret();
    // A stub extractor that cut the text mid-secret, as KS-1a does at its cap.
    const extract = async () => ({
      status: 'too_large' as const, extractor: 'stub@1', blocks: [{ headingPath: '', text: `intro text ${SECRET.slice(0, 7)}` }],
      error: 'text exceeds maxTextChars',
    });
    const a = t.artifacts.save({ workspaceId: 'R', kind: 'text', mime: 'text/plain', bytes: 'x' });
    await ingestArtifact(t.deps, a.id, { extract });
    const text = artifactText(t.store, a.id)!;
    expect(text).toBe('intro text');
    expect(knowledgeRepos(t.store).artifactTexts.get(a.id)).toMatchObject({ status: 'too_large' });
  });

  it('a secret is never split across two chunks (redacted before chunking)', async () => {
    const t = setup(cfg({ chunkTokens: 12, maxChunkTokens: 16 }));
    t.addSecret();
    const body = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} holds ${i === 5 ? SECRET : 'plain'} words.`).join(' ');
    const a = t.artifacts.save({ workspaceId: 'R', kind: 'text', mime: 'text/plain', bytes: body });
    await ingestArtifact(t.deps, a.id);
    const chunks = knowledgeRepos(t.store).chunks.list({ artifactId: a.id });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) noPartOfSecret(c.text);
    expect(chunks.some((c) => c.text.includes(REDACTED))).toBe(true);
  });

  it('a secret straddling the 300-char error cut is dropped before storing', async () => {
    const t = setup();
    t.addSecret();
    const extract = async () => ({
      status: 'failed' as const, extractor: 'stub@1', blocks: [],
      error: `${'e'.repeat(290)} ${SECRET.slice(0, 8)}…`, // KS-1a cut its message at 300 before any redaction
    });
    const a = t.artifacts.save({ workspaceId: 'R', kind: 'text', mime: 'text/plain', bytes: 'x' });
    await ingestArtifact(t.deps, a.id, { extract });
    const stored = knowledgeRepos(t.store).artifactTexts.get(a.id)!.error!;
    noPartOfSecret(stored);
    expect(stored.endsWith('…')).toBe(true);
  });
});

describe('serve: identities created after ingest are redacted before every cut', () => {
  /** An artifact whose two chunks meet inside `secret` (hand-written chunk rows). */
  function twoChunks(t: ReturnType<typeof setup>, secret: string) {
    const [head, tail] = [secret.slice(0, 6), secret.slice(6)];
    const a = t.artifacts.save({ workspaceId: 'R', kind: 'text', mime: 'text/plain', bytes: 'y' });
    const k = knowledgeRepos(t.store);
    k.artifactTexts.update(a.id, { status: 'ok', charCount: 40, tokenEstimate: 10 });
    const one = `first chunk text ${head}`;
    const two = `${tail} second chunk text`;
    k.chunks.insert({ id: 'chk_1', artifactId: a.id, workspaceId: 'R', seq: 0, headingPath: '', text: one, charStart: 0, charEnd: one.length, tokenEstimate: 8 });
    k.chunks.insert({ id: 'chk_2', artifactId: a.id, workspaceId: 'R', seq: 1, headingPath: '', text: two, charStart: one.length, charEnd: one.length + two.length, tokenEstimate: 8 });
    return { a, k };
  }

  it('a secret straddling a chunk boundary is redacted in both chunks', () => {
    const t = setup();
    const { k } = twoChunks(t, SECRET);
    t.addSecret(); // created after ingest
    const c1 = servedChunkText(t.store, 'R', k.chunks.get('chk_1')!);
    const c2 = servedChunkText(t.store, 'R', k.chunks.get('chk_2')!);
    expect(c1).toBe(`first chunk text ${REDACTED}`);
    expect(c2).toBe(`${REDACTED} second chunk text`);
  });

  it('a secret straddling the snippet window is redacted before the window is cut', () => {
    const t = setup();
    const a = t.artifacts.save({ workspaceId: 'R', kind: 'text', mime: 'text/plain', bytes: 'z' });
    const text = `${'lead '.repeat(10)}target ${'pad '.repeat(30)}${SECRET} ${'tail '.repeat(40)}`;
    const k = knowledgeRepos(t.store);
    k.chunks.insert({ id: 'chk_s', artifactId: a.id, workspaceId: 'R', seq: 0, headingPath: '', text, charStart: 0, charEnd: text.length, tokenEstimate: 100 });
    t.addSecret();
    // Find a window size that cuts through the secret.
    const at = text.indexOf('target');
    const secretAt = text.indexOf(SECRET);
    const lead = 16;
    const max = secretAt + 5 - (at - lead); // the window ends 5 chars into the secret
    const snip = chunkSnippet(t.store, 'R', a.id, k.chunks.get('chk_s')!, ['target'], max);
    expect(snip.startsWith(`<<<EVIDENCE ${a.id}`)).toBe(true);
    noPartOfSecret(snip);
  });

  it('a secret straddling the served 300-char error cut is redacted whole first', async () => {
    const t = setup();
    const a = t.artifacts.save({ workspaceId: 'R', kind: 'text', mime: 'text/plain', bytes: 'x' });
    knowledgeRepos(t.store).artifactTexts.update(a.id, { status: 'failed', error: `${'e'.repeat(295)} ${SECRET}` });
    t.addSecret();
    const served = servedTextState(t.store, scopeFor(t.store, 'R'), a.id, 'node');
    noPartOfSecret(served.error!);
  });
});
