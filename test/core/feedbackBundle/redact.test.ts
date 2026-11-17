/**
 * Feedback bundle redaction (design §3.2): names → ids, the user id → `tester`, stored site passwords,
 * configuration without secrets or machine paths, file paths cut to their last segment.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LENSES, PROVIDER_IDS, ROLES, TASK_TYPES, defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { newCouncilRoundId } from '../../../src/core/council/store.js';
import { USER_ACTIONS } from '../../../src/core/feedback/actions.js';
import { FEEDBACK_KINDS } from '../../../src/core/feedback/events.js';
import {
  countLeaves, cutPaths, cutUrls, distinctiveWords, figures, idOrText, machineFolders, labelOrNumber, plainKeys, redactBundle, redactConfiguration, redactValue, redaction, shortReason,
  testerActor, TESTER,
} from '../../../src/core/feedbackBundle/redact.js';
import { ISSUE_CLASSES, TOOL_NAMES } from '../../../src/core/harness/tools/registry.js';
import { OUTCOME_LABELS, OUTCOME_SOURCES, REVIEW_ISSUE_STATUSES } from '../../../src/core/learning/types.js';
import { POLICY_EVENT_KINDS } from '../../../src/core/policy/policyEvents.js';
import { ALL_PHASES } from '../../../src/core/research/phases.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import { PERSISTED_BUS_EVENT_TYPES } from '../../../src/core/telemetry/busEvents.js';
import { REDACTED } from '../../../src/core/store/redact.js';
import { createWorkspace } from '../../../src/core/workspace/tree.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function world(user?: string) {
  const store = openStore(':memory:');
  opened.push(store);
  const config: BifConfig = structuredClone(defaultConfig);
  if (user) config.user = { id: user };
  const root = createWorkspace(store, { name: 'Northwind Traders', sector: 'retail' });
  const child = createWorkspace(store, { name: 'Northwind Traders Pay', sector: 'retail', parentWorkspaceId: root.id, scope: { level: 'division', name: 'Payments arm', description: 'd' } });
  store.identities.insert({ id: 'idn_1', workspaceId: root.id, site: 'example.com', name: 'n', email: 'e@example.com', password: 'hunter2-site', emailPassword: 'inbox-pass-9', createdAt: '2026-11-01T00:00:00.000Z' });
  return { store, config, root, child };
}

describe('cutPaths', () => {
  it('cuts POSIX, home and Windows paths to their last segment', () => {
    expect(cutPaths('ENOENT: open /Users/someone/project/data/run.log failed')).toBe('ENOENT: open run.log failed');
    expect(cutPaths('read ~/Library/x/y.json')).toBe('read y.json');
    expect(cutPaths('cannot open C:\\Users\\someone\\AppData\\Roaming\\app\\bif.db now')).toBe('cannot open bif.db now');
    expect(cutPaths('at file:///Users/someone/app/main.js:10:3')).not.toContain('someone');
  });

  it('cuts a quoted path that has spaces in it as one path', () => {
    const out = cutPaths("open '/Users/someone/Library/Application Support/Business Intelligence Factory/data/x.db'");
    expect(out).toBe("open 'x.db'");
  });

  it('leaves URLs, model keys, dates and single-segment paths alone', () => {
    for (const s of ['https://example.com/a/b/c', 'claude/opus', 'worker:ab12cd34', '2026-11-16T10:00:00.000Z', 'path /mcp', 'ratio 3/4', 'review:blocking:news_scan']) {
      expect(cutPaths(s), s).toBe(s);
    }
  });
});

describe('cutPaths with the folders of the machine', () => {
  const folders = machineFolders({ dataDir: '/Users/someone/Library/Application Support/Business Intelligence Factory/data', browser: { profileDir: 'data/browser-profile' } });

  it('cuts a path under a known folder as one path, whatever spaces the folder has', () => {
    expect(cutPaths('spawn failed: ENOENT /Users/someone/Library/Application Support/Business Intelligence Factory/data/ws_1/runs/run_2/cwd', folders)).toBe('spawn failed: ENOENT cwd');
    expect(cutPaths('data folder /Users/someone/Library/Application Support/Business Intelligence Factory/data is full', folders)).toBe('data folder data is full');
  });

  it('an unquoted path with spaces under no known folder loses its home folder, and keeps what follows the first space', () => {
    expect(cutPaths('open /Users/another/My Folder/notes.txt', folders)).toBe('open My Folder/notes.txt');
  });

  it('lists the configured folders as given and resolved, the home and the temp folder, longest first', () => {
    expect(folders).toContain('/Users/someone/Library/Application Support/Business Intelligence Factory/data');
    // Resolved on Windows, the relative folder ends in `data\browser-profile`.
    expect(folders.some((f) => /data[\\/]browser-profile$/.test(f))).toBe(true);
    expect([...folders].sort((a, b) => b.length - a.length)).toEqual(folders);
  });
});

describe('shortReason', () => {
  it('keeps the first line, cut to the limit', () => {
    expect(shortReason('spawn failed: ENOENT claude\nstack line 1\nstack line 2')).toBe('spawn failed: ENOENT claude');
    expect(shortReason('x'.repeat(500))).toHaveLength(201); // 200 + the ellipsis
    expect(shortReason(undefined)).toBeUndefined();
    expect(shortReason('   ')).toBeUndefined();
  });
});

describe('figures', () => {
  it('keeps numbers, booleans, ids, times and known labels; drops free text', () => {
    expect(
      figures({
        include: false, score: 7, status: 'verified', at: '2026-11-16T10:00:00.000Z', id: 'fnd_01JD0000000000000000000000',
        claim: 'Some long research claim', name: 'Acme', action: 'start_research', nested: { reason: 'free words here', n: 2 },
        list: ['verified', 'free words here', 3],
      }),
    ).toEqual({
      include: false, score: 7, status: 'verified', at: '2026-11-16T10:00:00.000Z', id: 'fnd_01JD0000000000000000000000',
      action: 'start_research', nested: { n: 2 }, list: ['verified', 3],
    });
  });

  it('keeps a label under a label key only when it is shaped like one', () => {
    expect(figures({ action: 'Tell the board about it', kind: 'x y' })).toEqual({});
    expect(figures({ action: 'start_research', scope: 'node:tree', kind: 'follow-up' })).toEqual({ action: 'start_research', scope: 'node:tree', kind: 'follow-up' });
  });

  it('a label has no dot: a host name under a label key is dropped', () => {
    expect(figures({ source: 'rival-site.example', site: 'rival-site.example', kind: 'shop.example', type: 'v1.2' })).toEqual({});
  });

  it('keeps a key only when it is a plain identifier; any other key becomes key_1, key_2, … per record', () => {
    // The council's probe: a profile whose keys are the agent's words.
    expect(figures({ 'Zephyrine Outfitters wholesale deal': 120000, pricing: { 'Quillfeather Pro plan': 49, seats: 3, 'per-seat': 7 } })).toEqual({
      key_1: 120000,
      pricing: { key_1: 49, seats: 3, key_2: 7 },
    });
    // In a list each record numbers its own keys; a key that is taken is not given out again.
    expect(figures([{ 'a b': 1 }, { 'c d': 2, key_1: 3 }])).toEqual([{ key_1: 1 }, { key_2: 2, key_1: 3 }]);
    // A key too long to be a field name, or starting with a digit, is no plain identifier either.
    expect(figures({ ['x'.repeat(41)]: 1, '9lives': 2 })).toEqual({ key_1: 1, key_2: 2 });
  });

  it('replaces a plain identifier too when the rules flag it (a business name of one word)', () => {
    const flagged = (k: string) => /acme/i.test(k);
    expect(figures({ Acme: 1, acme_revenue: 2, revenue: 3, nested: { AcmeDeal: true } }, undefined, flagged)).toEqual({ key_1: 1, key_2: 2, revenue: 3, nested: { key_1: true } });
  });
});

describe('plainKeys and countLeaves (an edited profile as the bundle carries it)', () => {
  it('names the keys that say nothing and numbers the others in order', () => {
    expect(plainKeys(['pricing', 'Our biggest customer', 'about', 'deal/2026'])).toEqual(['pricing', 'key_1', 'about', 'key_2']);
  });

  it('counts the values a part of a profile holds, whatever they are', () => {
    expect(countLeaves({ a: 1, b: { c: 'words', d: [1, 2, { e: null }] } })).toBe(4);
    expect(countLeaves('one')).toBe(1);
    expect(countLeaves(null)).toBe(0);
    expect(countLeaves(undefined)).toBe(0);
  });
});

describe('cutUrls', () => {
  it('writes a web address as <url> and keeps what stands around it', () => {
    expect(cutUrls('navigation failed at https://shop.example/pricing?plan=pro.')).toBe('navigation failed at <url>.');
    expect(cutUrls('see (http://127.0.0.1:4317/mcp/abc123) and www.shop.example/a, then wss://live.example/feed')).toBe('see (<url>) and <url>, then <url>');
  });

  it('leaves what is no web address: a model key, a time, a file name, a bare host name', () => {
    for (const s of ['claude/opus', '2026-11-16T10:00:00.000Z', 'run.log', 'ENOTFOUND shop.example', 'review:blocking:news_scan']) expect(cutUrls(s), s).toBe(s);
  });
});

describe('labelOrNumber', () => {
  it('keeps numbers, known labels and number-like strings; anything else is marked as text', () => {
    expect(labelOrNumber(4)).toBe(4);
    expect(labelOrNumber('excluded')).toBe('excluded');
    expect(labelOrNumber('$10k')).toBe('$10k');
    expect(labelOrNumber('↑')).toBe('↑');
    expect(labelOrNumber('Enterprise buyers in the north')).toBe('[text]');
    expect(labelOrNumber(null)).toBeNull();
    expect(labelOrNumber(undefined)).toBeUndefined();
  });
});

describe('idOrText', () => {
  it('keeps what is shaped like an id and marks anything else as text', () => {
    expect(idOrText('fnd_01JD0000000000000000000000')).toBe('fnd_01JD0000000000000000000000');
    expect(idOrText('rec_1:per_2')).toBe('rec_1:per_2');
    expect(idOrText('worker')).toBe('worker');
    expect(idOrText('A sentence in the place of an id')).toBe('[text]');
    expect(idOrText(undefined)).toBeUndefined();
  });
});

describe('testerActor', () => {
  it('writes every person as tester and keeps the names of the system actors', () => {
    expect(testerActor('someone@example.com')).toBe(TESTER);
    expect(testerActor('local-user')).toBe(TESTER);
    expect(testerActor(undefined)).toBe(TESTER);
    expect(testerActor('system')).toBe('system');
    expect(testerActor('scheduler')).toBe('scheduler');
  });
});

describe('redactConfiguration', () => {
  it('writes the configuration without secrets, the user id or machine paths', () => {
    const config: BifConfig = structuredClone(defaultConfig);
    config.dataDir = '/Users/someone/Library/Application Support/BIF/data';
    config.user = { id: 'someone@example.com' };
    config.providers.claude.command = '/opt/homebrew/bin/claude';
    config.browser.profileDir = '/Users/someone/profile';
    config.browser.mcpServers = { pw: { command: '/usr/local/bin/npx', env: { TOKEN: 'mcp-secret-1' } } };
    config.identity = { emailProvider: 'catchall', catchallDomain: 'mail.someone.example' };
    config.telemetry = { otlp: { enabled: true, endpoint: 'https://otlp.someone.example/v1', headers: { authorization: 'Bearer otlp-secret-2' } } };
    config.personaPanel = { personas: { 'enterprise-buyer': { seat: 0 } }, seats: [{ provider: 'claude', model: 'sonnet' }] };
    const out = redactConfiguration(config);
    const text = JSON.stringify(out);
    for (const gone of ['someone', 'mcp-secret-1', 'otlp-secret-2', '/opt/homebrew', '/usr/local', 'Application Support', 'enterprise-buyer', 'dataDir']) {
      expect(text, gone).not.toContain(gone);
    }
    expect(out).toMatchObject({
      providers: { claude: { enabled: true, command: 'claude', models: ['opus', 'sonnet', 'haiku'] } },
      browser: { backend: 'mcp', mode: 'shared' },
      identity: { emailProvider: 'catchall' },
      telemetry: { otlp: { enabled: true } },
      roles: config.roles,
      loop: config.loop,
      limits: config.limits,
      personaPanel: { pinnedPersonas: 1 },
    });
    expect(out).not.toHaveProperty('user');
    // The configuration that was passed is not changed.
    expect(config.dataDir).toContain('/Users/someone');
  });
});

describe('redaction (the rules applied to the whole bundle)', () => {
  it('replaces business and node names by their ids, longest name first, whatever the case', () => {
    const w = world();
    const out = redactValue(redaction(w), { a: 'run for Northwind Traders Pay failed', b: ['northwind traders did x'], c: { d: 'Payments arm' } });
    expect(out).toEqual({ a: `run for ${w.child.id} failed`, b: [`${w.root.id} did x`], c: { d: w.child.id } });
  });

  it('replaces a short name only as a whole word in its own case', () => {
    const w = world();
    const short = createWorkspace(w.store, { name: 'Sol', sector: 's' });
    const out = redactValue(redaction(w), { model: 'gpt-6.1-sol', text: 'Sol is a business', other: 'Solar' });
    expect(out).toEqual({ model: 'gpt-6.1-sol', text: `${short.id} is a business`, other: 'Solar' });
  });

  it('writes the configured user id, and every other person in the store, as tester', () => {
    const w = world('someone@example.com');
    w.store.ratings.insert({
      id: 'rat_1', workspaceId: w.root.id, targetType: 'finding', targetId: 'f', criterion: 'c', agentValue: 1, verdict: 'agree',
      createdAt: '2026-11-01T00:00:00.000Z', actor: 'earlier.person',
    });
    const out = redactValue(redaction(w), { a: 'decided by someone@example.com', b: 'earlier.person agreed', c: 'local-user', d: 'someone@example.community' });
    expect(out).toEqual({ a: `decided by ${TESTER}`, b: `${TESTER} agreed`, c: TESTER, d: 'someone@example.community' });
  });

  it('redacts stored site passwords of every workspace with the existing redaction, and cuts paths', () => {
    const w = world();
    const out = redactValue(redaction(w), { note: 'I logged in with hunter2-site and inbox-pass-9', reason: 'see /Users/someone/Desktop/notes.txt' });
    expect(out).toEqual({ note: `I logged in with ${REDACTED} and ${REDACTED}`, reason: 'see notes.txt' });
  });

  it('leaves numbers and booleans as they are, and redacts the keys as it redacts the values', () => {
    const w = world('someone@example.com');
    const out = redactValue(redaction(w), {
      runs: 3, ok: true, none: null, 'Northwind Traders': 1, 'notes of someone@example.com': 2, 'paid with hunter2-site': 3, '/Users/someone/Desktop/plan.txt': 4,
    });
    expect(out).toEqual({ runs: 3, ok: true, none: null, [w.root.id]: 1, [`notes of ${TESTER}`]: 2, [`paid with ${REDACTED}`]: 3, 'plan.txt': 4 });
  });

  it('two keys that become the same keep both values', () => {
    const w = world();
    expect(redactValue(redaction(w), { 'Northwind Traders': 1, 'northwind traders': 2, '/Users/a/x.txt': 3, '/Users/b/x.txt': 4 })).toEqual({
      [w.root.id]: 1, [`${w.root.id}_2`]: 2, 'x.txt': 3, 'x.txt_2': 4,
    });
  });

  it('a field name is not a name: a plain identifier is replaced only when the whole key is the name', () => {
    const w = world();
    const unit = createWorkspace(w.store, { name: 'Duration', sector: 's' });
    const r = redaction(w);
    // The bundle's own field names stay readable for a business unit called "Duration" ...
    expect(redactValue(r, { durationMs: 12, durationRuns: 2 })).toEqual({ durationMs: 12, durationRuns: 2 });
    // ... a key that is the name, in any case, does not ...
    expect(redactValue(r, { Duration: 1 })).toEqual({ [unit.id]: 1 });
    expect(redactValue(r, { duration: 1 })).toEqual({ [unit.id]: 1 });
    // ... and in a free-form record (the texts of the fuller level) a key is redacted as a text is.
    expect(redactValue(r, { durationBudget: 1 }, 'free')).toEqual({ [`${unit.id}Budget`]: 1 });
    // What is no plain identifier is always redacted as a text.
    expect(redactValue(r, { 'duration budget': 1 })).toEqual({ [`${unit.id} budget`]: 1 });
  });

  it("a business unit called by one of the tool's own words leaves every key as it is: the word is in the phase market_research", () => {
    const w = world();
    createWorkspace(w.store, { name: 'Research', sector: 's' });
    const r = redaction(w);
    const own = { researchRunId: 'rrun_1', researchRuns: 2, research: 1, Research: 3, 'research budget': 4 };
    expect(redactValue(r, own)).toEqual(own);
    expect(redactValue(r, { researchBudget: 1 }, 'free')).toEqual({ researchBudget: 1 });
  });

  it('says whether a rule would change a string, or a distinctive word of a name is inside it', () => {
    const w = world();
    const r = redaction(w);
    expect(r.flags('northwind traders deal')).toBe(true);
    expect(r.flags('Northwind')).toBe(true);
    expect(r.flags('NorthwindTradersDeal')).toBe(true); // not the name (it has a space), but its distinctive word
    expect(r.flags('northwindshare')).toBe(true);
    expect(r.flags('pricing')).toBe(false);
    expect(r.flags('tradersShare')).toBe(false); // a common word of the name says nothing
  });

  it('replaces a distinctive word of a name on its own, as a whole word in any case; a common or short word of a name stays', () => {
    const w = world();
    const hub = createWorkspace(w.store, { name: 'Quillfeather Logistics', sector: 's' });
    const r = redaction(w);
    expect(r.text('the report for Quillfeather was late')).toBe(`the report for ${hub.id} was late`);
    expect(r.text("QUILLFEATHER's costs: see quillfeather.example and (Quillfeather)")).toBe(`${hub.id}'s costs: see ${hub.id}.example and (${hub.id})`);
    // Joined by an underscore it is part of an identifier, as the tool's ids and labels are: it stays.
    expect(r.text('see quillfeather_share and total_quillfeather')).toBe('see quillfeather_share and total_quillfeather');
    expect(r.text('Northwind grew')).toBe(`${w.root.id} grew`);
    // "Logistics", "Traders" and "Payments" are words many businesses have; "Pay" and "arm" are short.
    const plain = 'logistics and payments by traders: pay the arm';
    expect(r.text(plain)).toBe(plain);
    // Inside a longer word it is not that word.
    expect(r.text('quillfeathers and Northwinds')).toBe('quillfeathers and Northwinds');
    expect(distinctiveWords('Quillfeather Logistics')).toEqual(['quillfeather']);
    expect(distinctiveWords('The House of Northwind & Sons 2026')).toEqual(['northwind']);
  });

  it("a word of a name that is one of the tool's own words or of a configured model is not replaced on its own", () => {
    const w = world();
    w.config.providers.claude.models = ['opus', 'sonnet'];
    createWorkspace(w.store, { name: 'News Review Sonnet Tester', sector: 's' });
    const r = redaction(w);
    for (const s of ['review:blocking:news_scan', 'claude/sonnet', 'decided by tester', 'news of the day']) expect(r.text(s), s).toBe(s);
    expect(r.flags('newsCount')).toBe(false);
  });

  it('the names of the phases and of the tool own things are its words too: a business named with them damages no figure', () => {
    const w = world();
    createWorkspace(w.store, { name: 'Deep Root Pipeline Discovery', sector: 's' });
    createWorkspace(w.store, { name: 'Workspace Synthesis & Scoring Tree', sector: 's' });
    const r = redaction(w);
    for (const s of ['deep_dives', 'competitor_discovery', 'flow_ranking', 'budget:workspace:ws_1', 'scope pipeline', 'synthesis', 'scoring', 'root node of the tree']) expect(r.text(s), s).toBe(s);
    expect(distinctiveWords('Deep Root Pipeline Discovery')).toEqual([]);
  });

  it('a free-form key with a distinctive word inside a longer identifier is flagged, and replaced where keys are redacted as texts', () => {
    const w = world();
    const hub = createWorkspace(w.store, { name: 'Quillfeather Logistics', sector: 's' });
    const r = redaction(w);
    expect(figures({ quillfeatherShare: 0.6, QUILLFEATHER_total: 2, share: 0.4, nested: { northwindDeal: true } }, undefined, r.flags)).toEqual({ key_1: 0.6, key_2: 2, share: 0.4, nested: { key_1: true } });
    expect(redactValue(r, { quillfeatherShare: 1 }, 'free')).toEqual({ [`${hub.id}Share`]: 1 });
    // A field name of the bundle is the tool's own word: a name inside it is not replaced.
    expect(redactValue(r, { northwindRuns: 1 })).toEqual({ northwindRuns: 1 });
  });

  it('writes a web address as <url>, unless the fuller level keeps them', () => {
    const w = world();
    const value = { failureReason: 'net::ERR_NAME_NOT_RESOLVED at https://shop.example/pricing', reason: 'I looked at http://shop.example myself' };
    expect(redactValue(redaction(w), value)).toEqual({ failureReason: 'net::ERR_NAME_NOT_RESOLVED at <url>', reason: 'I looked at <url> myself' });
    expect(redactValue(redaction(w, { keepUrls: true }), value)).toEqual(value);
  });

  it('leaves the tool own labels alone, whatever a business or a person is called', () => {
    const w = world('reviewer');
    createWorkspace(w.store, { name: 'Worker', sector: 's' });
    const guild = createWorkspace(w.store, { name: 'Worker Guild', sector: 's' });
    const out = redactValue(redaction(w), { role: 'worker', other: 'reviewer', version: 'worker:ab12cd34', text: 'Worker Ltd was reviewed', full: 'the worker guild was reviewed' });
    // A business named by a role alone is not replaced by that word; one named with more words is, by its full name.
    expect(out).toEqual({ role: 'worker', other: 'reviewer', version: 'worker:ab12cd34', text: 'Worker Ltd was reviewed', full: `the ${guild.id} was reviewed` });
  });
});

describe('redaction: a name rule changes no figure the tool wrote', () => {
  const ID = 'arun_01JD0000000000000000000000';

  it('a word of a name inside an id or a snake_case label is not that word', () => {
    const w = world();
    const pipe = createWorkspace(w.store, { name: 'Arun Pipe Works', sector: 's' });
    const r = redaction(w);
    for (const s of [ID, 'pipe_01JD0000000000000000000000', `run ${ID} of pipe_7 ended`, 'arun_1', 'works_council', 'the_arun', 'arun2', '2arun']) expect(r.text(s), s).toBe(s);
    // On its own it still is, and so is the full name.
    expect(r.text("Arun's run: the pipe burst (arun)")).toBe(`${pipe.id}'s run: the ${pipe.id} burst (${pipe.id})`);
    expect(r.text('we sold to ARUN PIPE WORKS twice')).toBe(`we sold to ${pipe.id} twice`);
  });

  it('a business named with words of the labels leaves the labels, the tool names and the messages that hold them', () => {
    const w = world();
    const named = createWorkspace(w.store, { name: 'Action Phase Synthetic Submit Prompt', sector: 's' });
    const r = redaction(w);
    for (const s of ['phase_skipped', 'synthetic_review', 'run ended without submit_result', 'prompt_patch_apply', 'prompt_version', 'submit_persona_feedback', 'start_research']) {
      expect(r.text(s), s).toBe(s);
    }
    expect(redactValue(r, { phase: 'synthesis', action: 'start_research', phases: 2, promptVersion: 'p' })).toEqual({ phase: 'synthesis', action: 'start_research', phases: 2, promptVersion: 'p' });
    // The key of a free-form record that is a word of the tool is kept, with its figure.
    expect(figures({ action: 'start_research', phases: 2, phase: 'synthesis' }, undefined, r.flags)).toEqual({ action: 'start_research', phases: 2, phase: 'synthesis' });
    expect(r.text('the action phase synthetic submit prompt deal')).toBe(`the ${named.id} deal`);
  });

  it("a business whose name is one of the tool's own words is not replaced by that word: a phase, a model, a provider, the tester", () => {
    const w = world();
    for (const name of ['Synthesis', 'Discovery', 'Opus', 'Sonnet', 'Haiku', 'Claude', 'Tester', 'Evidence', 'weak-review', 'submit_result', 'Fix']) createWorkspace(w.store, { name, sector: 's' });
    const r = redaction(w);
    const own = {
      phase: 'synthesis', other: 'competitor_discovery', models: ['opus', 'sonnet', 'haiku'], model: 'claude/opus', provider: 'claude', actor: 'tester', lens: 'evidence',
      label: 'weak-review', tool: 'submit_result', action: 'fix', reason: 'decided by tester: Synthesis used Opus, and the run ended without submit_result',
    };
    expect(redactValue(r, own)).toEqual(own);
    expect(redactValue(r, { synthesis: 1, opus: 2, tester: 3, Evidence: 4 })).toEqual({ synthesis: 1, opus: 2, tester: 3, Evidence: 4 });
  });

  it('the other words of such a business are replaced, and so is its full name of several words', () => {
    const w = world();
    const works = createWorkspace(w.store, { name: 'Opus Fabrication', sector: 's' });
    const r = redaction(w);
    expect(r.text('opus fabrication ran on claude/opus; Fabrication paid, opus did not')).toBe(`${works.id} ran on claude/opus; ${works.id} paid, opus did not`);
  });

  it('a model or a provider named anywhere in the configuration is a word of the tool, listed for its provider or not', () => {
    const w = world();
    w.config.roles.reviewer = { provider: 'codex', model: 'gpt-9-turbo' };
    w.config.providers.claude.models = ['opus', 'mythos-preview'];
    for (const name of ['Turbo', 'Mythos', 'Preview', 'Codex']) createWorkspace(w.store, { name, sector: 's' });
    const r = redaction(w);
    for (const s of ['gpt-9-turbo', 'codex/gpt-9-turbo', 'mythos-preview', 'claude/mythos-preview', 'codex']) expect(r.text(s), s).toBe(s);
  });

  it('a string that is an id as a whole stays: a stored id, a council round id, an id behind labels', () => {
    const w = world();
    const ledger = createWorkspace(w.store, { name: 'Ledger', sector: 's' });
    createWorkspace(w.store, { name: 'cnl', sector: 's' });
    const r = redaction(w);
    const round = newCouncilRoundId(newId('tsk'));
    expect(round).toMatch(/^cnl:tsk_[0-9A-Z]{26}:r_[0-9A-Z]{26}$/);
    for (const s of [w.root.id, newId('arun'), round, `ledger:workspace:${w.root.id}`, `${newId('rec')}:${newId('per')}`]) expect(r.text(s), s).toBe(s);
    // What only looks like one in part is a text, and the name in it is replaced.
    expect(r.text(`the ledger of ${w.root.id}`)).toBe(`the ${ledger.id} of ${w.root.id}`);
    expect(r.text('ledger:workspace')).toBe(`${ledger.id}:workspace`);
  });

  it('a whole name is replaced as a whole word: not inside a longer word, an identifier or a number', () => {
    const w = world();
    const acme = createWorkspace(w.store, { name: 'Acme', sector: 's' });
    const r = redaction(w);
    expect(r.text("Acme's plan, (acme), acme.example and ACME-West")).toBe(`${acme.id}'s plan, (${acme.id}), ${acme.id}.example and ${acme.id}-West`);
    for (const s of ['acmeology', 'pacme', 'acme_total', 'total_acme', 'acme2', '2acme']) expect(r.text(s), s).toBe(s);
    // A name of several words too: as typed, in any case, bounded the same way.
    expect(r.text('for northwind traders, not for northwind traders_x or xnorthwind traders')).toBe(`for ${w.root.id}, not for ${w.root.id} traders_x or xnorthwind traders`);
  });

  it('a short name is replaced as a whole word in its own case, and not next to an underscore', () => {
    const w = world();
    const short = createWorkspace(w.store, { name: 'Sol', sector: 's' });
    const r = redaction(w);
    expect(r.text('Sol and Sol_1 and r_Sol')).toBe(`${short.id} and Sol_1 and r_Sol`);
  });

  it('every label the code defines stays, whatever word of one a business is named with', () => {
    const w = world();
    const labels = [
      ...ALL_PHASES, 'mapping', ...TASK_TYPES, ...ROLES, ...PROVIDER_IDS, ...LENSES, ...TOOL_NAMES, ...ISSUE_CLASSES, ...FEEDBACK_KINDS, ...USER_ACTIONS, ...OUTCOME_LABELS,
      ...OUTCOME_SOURCES, ...REVIEW_ISSUE_STATUSES, ...POLICY_EVENT_KINDS, ...PERSISTED_BUS_EVENT_TYPES, TESTER, '[text]', '<url>', REDACTED,
      ...Object.values(w.config.providers).flatMap((p) => p.models),
    ];
    // A business for each label, and one for each word of each label.
    const names = new Set(labels.flatMap((l) => [l, ...l.split(/[^a-z0-9]+/).filter(Boolean)]));
    for (const name of names) createWorkspace(w.store, { name: name[0]!.toUpperCase() + name.slice(1), sector: 's' });
    const r = redaction(w);
    for (const s of [...labels, ...labels.map((l) => `claude/${l}`), ...labels.map((l) => `review:${l}:x`), ...labels.map((l) => `the run ended with ${l}.`)]) expect(r.text(s), s).toBe(s);
  });
});

describe('redactBundle', () => {
  it('redacts the manifest and every section, keys as well as values', () => {
    const w = world();
    const out = redactBundle(w, {
      id: 'ab12cd34',
      manifest: { format: 1, note: 'Northwind Traders went well' },
      sections: {
        runs: [{ tree: w.root.id, tables: { runs: [{ failureReason: 'about Northwind Traders', 'Northwind Traders': 1 }] } }],
        feedback: [{ tree: w.root.id, tables: { events: [{ after: { 'paid with hunter2-site': 2, 'see https://shop.example/x': 3 } }] } }],
        texts: [{ tree: w.root.id, tables: { decisionLines: [{ comparison: { 'Northwind Traders': 'we are Northwind Traders' } }] } }],
      },
    });
    expect(out).toEqual({
      id: 'ab12cd34',
      manifest: { format: 1, note: `${w.root.id} went well` },
      sections: {
        runs: [{ tree: w.root.id, tables: { runs: [{ failureReason: `about ${w.root.id}`, [w.root.id]: 1 }] } }],
        feedback: [{ tree: w.root.id, tables: { events: [{ after: { [`paid with ${REDACTED}`]: 2, 'see <url>': 3 } }] } }],
        texts: [{ tree: w.root.id, tables: { decisionLines: [{ comparison: { [w.root.id]: `we are ${w.root.id}` } }] } }],
      },
    });
  });

  it('of the manifest only the note is searched for names: the platform, the level and the versions are figures', () => {
    const w = world('someone@example.com');
    const darwin = createWorkspace(w.store, { name: 'Darwin', sector: 's' });
    for (const name of ['Arm64', 'Linux Works']) createWorkspace(w.store, { name, sector: 's' });
    const manifest = {
      format: 1, platform: { os: 'darwin', arch: 'arm64', node: '25.0.0' }, level: 'standard', clis: [{ name: 'claude', version: '2.1.0 (linux)' }],
      note: 'Darwin was the hardest, says someone@example.com',
    };
    const out = redactBundle(w, { id: 'ab12cd34', manifest: { ...manifest, appVersion: '0.1.0 of someone@example.com' }, sections: {} });
    // The other rules still apply to every value: a person is written as tester wherever they stand.
    expect(out.manifest).toEqual({ ...manifest, note: `${darwin.id} was the hardest, says ${TESTER}`, appVersion: `0.1.0 of ${TESTER}` });
    expect(Object.keys(out.manifest)).toEqual([...Object.keys(manifest), 'appVersion']);
  });

  it('leaves the keys of the manifest as they are: a reader finds the format version by one', () => {
    const w = world();
    createWorkspace(w.store, { name: 'Format', sector: 's' });
    const out = redactBundle(w, { id: 'ab12cd34', manifest: { format: 1, level: 'standard' }, sections: {} });
    expect(out.manifest).toEqual({ format: 1, level: 'standard' });
  });
});
