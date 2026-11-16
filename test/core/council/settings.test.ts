import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, configWarnings, deepMerge, loadConfig, parseConfig } from '../../../src/core/config/load.js';
import { COUNCIL_DEFAULTS, EFFORT_PROVIDERS, TASK_TYPES, defaultConfig, effortProblem, type BifConfig } from '../../../src/core/config/schema.js';
import type { SpawnSpec } from '../../../src/core/harness/adapter.js';
import { getAdapter } from '../../../src/core/harness/adapters/index.js';
import { councilRoundNote, councilSection } from '../../../src/core/council/lenses.js';
import { LENSES, councilFor, councilOverview, memberUnavailable, type CouncilMember } from '../../../src/core/council/settings.js';

const members = [
  { name: 'evidence', provider: 'claude', model: 'opus', lens: 'evidence' },
  { name: 'reasoning', provider: 'claude', model: 'sonnet', lens: 'reasoning' },
  { name: 'redo', provider: 'claude', model: 'opus', lens: 'rewrite', blocking: false },
];

/** The defaults with `council` (and other overrides) merged in, parsed. */
const withCouncil = (council: unknown, extra: Record<string, unknown> = {}): BifConfig =>
  parseConfig(deepMerge(defaultConfig, { council, ...extra }));

/** The issues of the ConfigError that parsing `council` throws, as `path: message` lines. */
function errorsOf(council: unknown, extra: Record<string, unknown> = {}): string[] {
  try {
    withCouncil(council, extra);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues.map((i) => `${i.path}: ${i.message}`);
  }
  throw new Error('expected a ConfigError');
}

describe('council configuration', () => {
  it('a config without council parses to the same object as before, and has no council stage', () => {
    const cfg = parseConfig(structuredClone(defaultConfig));
    expect(cfg).toEqual(defaultConfig);
    expect('council' in cfg).toBe(false);
    expect(councilFor(cfg, 'synthesize_recommendations')).toBeUndefined();
    expect(configWarnings(cfg)).toEqual([]);
  });

  it('defaults: rounds 3, pass score 9, blockOn any, onUnavailable fail, blocking true', () => {
    expect(COUNCIL_DEFAULTS).toEqual({ rounds: 3, passScore: 9, blockOn: 'any', onUnavailable: 'fail' });
    const cfg = withCouncil({ members, stages: { synthesize_recommendations: {} } });
    expect(councilFor(cfg, 'synthesize_recommendations')).toEqual({
      rounds: 3,
      passScore: 9,
      blockOn: 'any',
      onUnavailable: 'fail',
      members: [
        { name: 'evidence', provider: 'claude', model: 'opus', lens: 'evidence', blocking: true },
        { name: 'reasoning', provider: 'claude', model: 'sonnet', lens: 'reasoning', blocking: true },
        { name: 'redo', provider: 'claude', model: 'opus', lens: 'rewrite', blocking: false },
      ],
    });
  });

  it('a task type that is not a council stage keeps its single reviewer', () => {
    const cfg = withCouncil({ members, stages: { synthesize_recommendations: {} } });
    expect(councilFor(cfg, 'news_scan')).toBeUndefined();
    expect(councilFor(withCouncil({ members }), 'synthesize_recommendations')).toBeUndefined();
  });

  it('council-wide settings apply to every stage; a stage overrides rounds and passScore and names its members', () => {
    const cfg = withCouncil({
      rounds: 2,
      passScore: 8,
      blockOn: 'majority',
      onUnavailable: 'report',
      members,
      stages: {
        synthesize_recommendations: { members: ['reasoning', 'evidence'], rounds: 4 },
        symptom_hypotheses: { passScore: 9.5 },
      },
    });
    const synth = councilFor(cfg, 'synthesize_recommendations')!;
    expect(synth).toMatchObject({ rounds: 4, passScore: 8, blockOn: 'majority', onUnavailable: 'report' });
    expect(synth.members.map((m) => m.name)).toEqual(['reasoning', 'evidence']); // the stage's order
    const hyp = councilFor(cfg, 'symptom_hypotheses')!;
    expect(hyp).toMatchObject({ rounds: 2, passScore: 9.5 });
    expect(hyp.members.map((m) => m.name)).toEqual(['evidence', 'reasoning', 'redo']); // no members: the whole council
  });

  it('cli is another spelling of provider; effort is kept', () => {
    const cfg = withCouncil({
      members: [{ name: 'second', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', lens: 'evidence' }],
      stages: { symptom_hypotheses: {} },
    });
    expect(cfg.council!.members).toEqual([{ name: 'second', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', lens: 'evidence' }]);
    expect(councilFor(cfg, 'symptom_hypotheses')!.members).toEqual([
      { name: 'second', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', lens: 'evidence', blocking: true },
    ]);
  });

  it('a member with both provider and cli is an error', () => {
    const errors = errorsOf({ members: [{ name: 'a', provider: 'claude', cli: 'codex', model: 'opus', lens: 'brief' }] });
    expect(errors).toEqual([expect.stringMatching(/^council\.members\.0\.cli: .*provider.*cli/)]);
  });

  it('an unsupported provider is an error that lists the supported ones', () => {
    for (const key of ['provider', 'cli']) {
      const errors = errorsOf({ members: [{ name: 'a', [key]: 'gemini', model: 'pro', lens: 'brief' }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^council\.members\.0\.provider: /);
      expect(errors[0]).toContain("'gemini'");
      expect(errors[0]).toContain('claude, codex, opencode');
    }
    expect(errorsOf({ members: [{ name: 'a', model: 'opus', lens: 'brief' }] })[0]).toContain('claude, codex, opencode');
  });

  it('strict objects: unknown keys and unknown lenses are errors', () => {
    expect(errorsOf({ members, chair: 'opus' }).join('\n')).toMatch(/chair/);
    expect(errorsOf({ members: [{ ...members[0], weight: 2 }] }).join('\n')).toMatch(/weight/);
    expect(errorsOf({ members, stages: { synthesize_recommendations: { blockOn: 'all' } } }).join('\n')).toMatch(/blockOn/);
    expect(errorsOf({ members, stages: { not_a_task_type: {} } }).join('\n')).toMatch(/not_a_task_type/);
    expect(errorsOf({ members: [{ ...members[0], lens: 'style' }] })[0]).toMatch(/^council\.members\.0\.lens: /);
    expect(LENSES).toEqual(['evidence', 'brief', 'reasoning', 'privacy', 'value', 'rewrite']);
  });

  it('out-of-range rounds, pass score, blockOn and onUnavailable are errors', () => {
    expect(errorsOf({ members, rounds: 0 })[0]).toMatch(/^council\.rounds: /);
    expect(errorsOf({ members, passScore: 11 })[0]).toMatch(/^council\.passScore: /);
    expect(errorsOf({ members, blockOn: 'most' })[0]).toMatch(/^council\.blockOn: /);
    expect(errorsOf({ members, onUnavailable: 'replace' })[0]).toMatch(/^council\.onUnavailable: /);
    expect(errorsOf({ members, stages: { news_scan: { rounds: 1.5 } } })[0]).toMatch(/^council\.stages\.news_scan\.rounds: /);
  });

  it('member names are unique', () => {
    const errors = errorsOf({ members: [...members, { ...members[1], lens: 'brief' }] });
    expect(errors).toEqual(["council.members.3.name: duplicate member name 'reasoning'"]);
  });

  it('a stage naming an unknown member, or one member twice, is an error', () => {
    expect(errorsOf({ members, stages: { news_scan: { members: ['evidence', 'chair'] } } })).toEqual([
      "council.stages.news_scan.members.1: unknown member 'chair' (members: evidence, reasoning, redo)",
    ]);
    expect(errorsOf({ members, stages: { news_scan: { members: ['evidence', 'evidence'] } } })).toEqual([
      "council.stages.news_scan.members.1: member 'evidence' is named twice",
    ]);
  });

  it('a stage must seat at least one blocking member', () => {
    const message = 'council.stages.news_scan: a stage must seat at least one blocking member';
    expect(errorsOf({ members, stages: { news_scan: { members: ['redo'] } } })).toEqual([message]);
    expect(errorsOf({ members, stages: { news_scan: { members: [] } } })).toEqual([message]);
    expect(errorsOf({ members: [members[2]], stages: { news_scan: {} } })).toEqual([message]);
    expect(errorsOf({ members: [], stages: { news_scan: {} } })).toEqual([message]);
  });

  it('effort: every supported CLI has a setting today; for a provider without one it is an error naming the provider', () => {
    for (const provider of ['claude', 'codex', 'opencode'] as const) expect(effortProblem(provider)).toBeUndefined();
    expect(effortProblem('opencode', new Set(['claude', 'codex']))).toBe(
      "provider 'opencode' has no reasoning-effort setting: remove effort from this member",
    );
    // Each of them really passes it: the command with an effort is the command without, plus the setting.
    const spec: SpawnSpec = { prompt: 'p', systemPrompt: 's', model: 'm', mcpUrl: 'http://127.0.0.1:1/mcp/t', extraMcpServers: {}, cwd: '/tmp/bif-run' };
    for (const provider of EFFORT_PROVIDERS) {
      const plain = getAdapter(provider).buildCommand(spec).args;
      const args = getAdapter(provider).buildCommand({ ...spec, effort: 'high' }).args;
      expect(args.length, provider).toBe(plain.length + 2);
      expect(args.filter((a) => a.includes('high')), provider).toHaveLength(1);
    }
    // An effort that could be read as a flag or break out of a value is refused.
    expect(errorsOf({ members: [{ ...members[0], effort: '--model' }] })[0]).toMatch(/^council\.members\.0\.effort: /);
    expect(errorsOf({ members: [{ ...members[0], effort: 'high"' }] })[0]).toMatch(/^council\.members\.0\.effort: /);
  });
});

describe('unavailable members', () => {
  const council = {
    members: [
      { name: 'evidence', provider: 'claude', model: 'opus', lens: 'evidence' },
      { name: 'second', provider: 'opencode', model: 'big-pickle', lens: 'evidence' },
      { name: 'third', provider: 'codex', model: 'not-configured', lens: 'reasoning' },
      { name: 'unseated', provider: 'opencode', model: 'big-pickle', lens: 'privacy' },
    ],
    stages: { synthesize_recommendations: { members: ['evidence', 'second', 'third'] }, symptom_hypotheses: { members: ['evidence', 'second'] } },
  };

  it('a disabled provider or an unconfigured model is not a configuration error', () => {
    const cfg = withCouncil(council);
    const [evidence, second, third] = councilFor(cfg, 'synthesize_recommendations')!.members;
    expect(memberUnavailable(cfg, evidence!)).toBeUndefined();
    expect(memberUnavailable(cfg, second!)).toBe("provider 'opencode' is not enabled");
    expect(memberUnavailable(cfg, third!)).toBe("model 'not-configured' is not in providers.codex.models");
  });

  it('start-up warnings name each seated member that cannot run, why, and its stages', () => {
    expect(configWarnings(withCouncil(council))).toEqual([
      "council: member 'second' (opencode/big-pickle) cannot run: provider 'opencode' is not enabled. " +
        "Stages symptom_hypotheses, synthesize_recommendations end unverified while it is seated (council.onUnavailable: fail)",
      "council: member 'third' (codex/not-configured) cannot run: model 'not-configured' is not in providers.codex.models. " +
        "Stages synthesize_recommendations end unverified while it is seated (council.onUnavailable: fail)",
    ]);
    expect(configWarnings(withCouncil({ ...council, onUnavailable: 'report' }))[0]).toBe(
      "council: member 'second' (opencode/big-pickle) cannot run: provider 'opencode' is not enabled. " +
        "Stages symptom_hypotheses, synthesize_recommendations run without it (council.onUnavailable: report)",
    );
  });

  it('the warning of a non-blocking member says the stages run without it, whatever onUnavailable says', () => {
    const nonBlocking = { ...council, members: council.members.map((m) => (m.name === 'second' ? { ...m, blocking: false } : m)) };
    for (const onUnavailable of ['fail', 'report'] as const) {
      expect(configWarnings(withCouncil({ ...nonBlocking, onUnavailable }))[0]).toBe(
        "council: member 'second' (opencode/big-pickle) cannot run: provider 'opencode' is not enabled. " +
          'Stages symptom_hypotheses, synthesize_recommendations run without it (a non-blocking member never ends a task)',
      );
    }
  });

  it('no warning once the provider is enabled with the model', () => {
    const cfg = withCouncil(
      { ...council, members: council.members.filter((m) => m.name !== 'third'), stages: { symptom_hypotheses: { members: ['evidence', 'second'] } } },
      { providers: { opencode: { enabled: true, command: 'opencode', models: ['big-pickle'] } } },
    );
    expect(configWarnings(cfg)).toEqual([]);
  });
});

describe('the documented configurations', () => {
  const ROOT = join(import.meta.dirname, '../../..');

  it('the example file defines a council and seats it in no stage: every task type keeps its single reviewer', () => {
    const example = loadConfig(join(ROOT, 'bif.config.example.json'));
    expect(example.council!.members.map((m) => m.name)).toEqual(['evidence', 'second', 'reasoning', 'redo']);
    expect(TASK_TYPES.filter((t) => councilFor(example, t) !== undefined)).toEqual([]);
    expect(configWarnings(example).filter((w) => w.startsWith('council:'))).toEqual([]);
    // Its members can be started with the example's own providers, so naming a stage is all it takes.
    const overview = councilOverview(example)!;
    expect(overview.members.map((m) => [m.name, m.available, m.stages])).toEqual([
      ['evidence', true, []],
      ['second', true, []],
      ['reasoning', true, []],
      ['redo', true, []],
    ]);
    expect(overview.stages).toEqual([]);
  });

  it("the README's council block is a valid configuration that seats the two recommended stages", () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const block = /```jsonc\n(\s*"council": \{[\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    const { council } = JSON.parse(`{${block!.replace(/\/\/[^\n]*/g, '')}}`) as { council: unknown };
    const cfg = withCouncil(council, { providers: { codex: { enabled: true, command: 'codex', models: ['gpt-6.1-sol'] } } });
    expect(TASK_TYPES.filter((t) => councilFor(cfg, t) !== undefined)).toEqual(['symptom_hypotheses', 'synthesize_recommendations']);
    expect(councilFor(cfg, 'synthesize_recommendations')).toMatchObject({ rounds: 4, passScore: 9, blockOn: 'any', onUnavailable: 'fail' });
    expect(councilFor(cfg, 'synthesize_recommendations')!.members.map((m) => [m.name, m.blocking])).toEqual([['evidence', true], ['second', true], ['reasoning', true]]);
    expect(councilFor(cfg, 'symptom_hypotheses')!.members.map((m) => [m.name, m.blocking])).toEqual([['evidence', true], ['second', true], ['reasoning', true], ['redo', false]]);
    expect(configWarnings(cfg).filter((w) => w.startsWith('council:'))).toEqual([]);
  });
});

describe('councilSection', () => {
  const member = (lens: CouncilMember['lens']): CouncilMember => ({ name: 'm', provider: 'claude', model: 'opus', lens, blocking: true });
  const section = (lens: CouncilMember['lens'], passScore = 9) => councilSection(member(lens), { passScore });
  /** What only the member of that lens is told to look for. */
  const LOOK_FOR: Record<CouncilMember['lens'], RegExp> = {
    evidence: /each claim against the copy it cites/,
    brief: /each acceptance criterion and each thing the brief asks/,
    reasoning: /step from evidence to conclusion/,
    privacy: /data of another business tree/,
    value: /Hunt for useless findings/,
    rewrite: /Look for a better way to do the same task/,
  };

  it('every member gets the member rules, the pass score and the optional fields of submit_review', () => {
    for (const lens of LENSES) {
      const text = section(lens, 8.5);
      expect(text).not.toMatch(/\{\{|\}\}/); // every placeholder filled
      for (const rule of [/Nothing here is precious/, /No nits/, /No scope creep/, /Evidence or nothing/, /A score below 8\.5 needs a reason/, /Work alone/]) {
        expect(text, lens).toMatch(rule);
      }
      expect(text, lens).toContain('The pass score is 8.5 out of 10');
      // Rule 5 says when a low score counts at all: only with an upheld issue of the member's own.
      expect(text, lens).toMatch(/A score below\s+8\.5 counts only when one of your issues is upheld in the merge/);
      expect(text, lens).toMatch(/Otherwise it is counted as 8\.5/);
      for (const field of ['`where`', '`evidence`', '`action`', '`questions`', '`follow_ups`', '`scope_expansion`', '`nit`']) expect(text, lens).toContain(field);
    }
  });

  it('every member is told how to give no score: `score: null` with the reason in `summary`, and that it then counts as not having reviewed', () => {
    for (const lens of LENSES) {
      const text = section(lens);
      expect(text, lens).toContain('`score: null`');
      expect(text, lens).toMatch(/say why in `summary`/);
      expect(text, lens).toMatch(/count as a member\s+that did not review/);
    }
  });

  it('a member has exactly one lens', () => {
    for (const lens of LENSES) {
      const text = section(lens);
      expect(text).toContain(`Your lens: \`${lens}\``);
      for (const other of LENSES) expect(LOOK_FOR[other].test(text), `${lens} / ${other}`).toBe(other === lens);
    }
  });

  it('every member can report a useless finding and a rewrite; the value and rewrite lenses hunt for them', () => {
    for (const lens of LENSES) {
      const text = section(lens);
      expect(text, lens).toContain('`action: "delete"`');
      expect(text, lens).toMatch(/removing it would change no recommendation, no hypothesis and no answer to the brief/);
      expect(text, lens).toMatch(/Never propose deleting a finding that is the only support of an acceptance criterion/);
      expect(text, lens).toContain('`action: "rewrite"`');
      expect(text, lens).toMatch(/five lines or fewer/);
      expect(text, lens).toMatch(/the same task and nothing more/);
      // Each of the two is explained once.
      expect(text.split('`action: "delete"`'), lens).toHaveLength(2);
      expect(text.split('`action: "rewrite"`'), lens).toHaveLength(2);
    }
  });

  it('from round 2 the round note (for the review prompt) says that new substantive issues no longer block', () => {
    expect(councilRoundNote(1, 1)).toBe('');
    // The first review of work that was done again in a later round is no late review either.
    expect(councilRoundNote(2, 1)).toBe('');
    const second = councilRoundNote(2, 2);
    expect(second.startsWith('## Review round 2\n')).toBe(true);
    expect(second).toMatch(/`substantive` issue that no member raised in an earlier round/);
    expect(second).toMatch(/new `blocking` issue still blocks/);
    expect(councilRoundNote(3, 2)).toContain('## Review round 3');
    expect(second).not.toMatch(/\n{3,}/);
  });
});
