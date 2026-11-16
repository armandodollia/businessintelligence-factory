import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, configWarnings, deepMerge, loadConfig, parseConfig } from '../../../src/core/config/load.js';
import { PERSONA_PANEL_DEFAULTS, defaultConfig, effortProblem, type BifConfig } from '../../../src/core/config/schema.js';
import { panelSettings, seatOf, seatUnavailable, type PanelSettings } from '../../../src/core/market/panelSettings.js';

/** The defaults with `personaPanel` (and other overrides) merged in, parsed. */
const withPanel = (personaPanel: unknown, extra: Record<string, unknown> = {}): BifConfig =>
  parseConfig(deepMerge(defaultConfig, { personaPanel, ...extra }));

/** The issues of the ConfigError that parsing `personaPanel` throws, as `path: message` lines. */
function errorsOf(personaPanel: unknown, extra: Record<string, unknown> = {}): string[] {
  try {
    withPanel(personaPanel, extra);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues.map((i) => `${i.path}: ${i.message}`);
  }
  throw new Error('expected a ConfigError');
}

const twoSeats = [
  { provider: 'claude', model: 'sonnet' },
  { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
];

describe('personaPanel configuration', () => {
  it('a config without personaPanel parses to the same object as before, and has no panel settings', () => {
    const cfg = parseConfig(structuredClone(defaultConfig));
    expect(cfg).toEqual(defaultConfig);
    expect('personaPanel' in cfg).toBe(false);
    expect(panelSettings(cfg)).toBeUndefined();
    expect(configWarnings(cfg)).toEqual([]);
  });

  it('defaults when the block is present: rounds 3, baseline on, onUnavailable report, one seat with roles.persona', () => {
    expect(PERSONA_PANEL_DEFAULTS).toEqual({ rounds: 3, baseline: true, onUnavailable: 'report' });
    expect(panelSettings(withPanel({}))).toEqual({
      rounds: 3, baseline: true, onUnavailable: 'report', seats: [{ provider: 'claude', model: 'sonnet' }], pins: {},
    });
    // The one default seat follows roles.persona.
    const opus = withPanel({}, { roles: { persona: { provider: 'claude', model: 'opus' } } });
    expect(panelSettings(opus)!.seats).toEqual([{ provider: 'claude', model: 'opus' }]);
  });

  it('every key can be set; pins are read as slug → seat', () => {
    const cfg = withPanel({ rounds: 1, baseline: false, onUnavailable: 'fail', seats: twoSeats, personas: { 'field-user': { seat: 1 } } });
    expect(panelSettings(cfg)).toEqual({
      rounds: 1, baseline: false, onUnavailable: 'fail',
      seats: [{ provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }],
      pins: { 'field-user': 1 },
    });
  });

  it('cli is another spelling of provider; giving both is an error', () => {
    const cfg = withPanel({ seats: [{ cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] });
    expect(cfg.personaPanel!.seats).toEqual([{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
    expect(errorsOf({ seats: [{ provider: 'claude', cli: 'claude', model: 'sonnet' }] })).toEqual([
      'personaPanel.seats.0.cli: give provider or cli, not both',
    ]);
  });

  it('an unsupported or missing provider is an error that lists the supported ones', () => {
    expect(errorsOf({ seats: [{ cli: 'gemini', model: 'pro' }] })).toEqual([
      "personaPanel.seats.0.provider: unsupported provider 'gemini': supported are claude, codex, opencode",
    ]);
    expect(errorsOf({ seats: [{ model: 'sonnet' }] })).toEqual(['personaPanel.seats.0.provider: required: one of claude, codex, opencode']);
  });

  it('strict objects, ranges and an empty seat list are errors', () => {
    expect(errorsOf({ round: 2 })[0]).toMatch(/^personaPanel: /);
    expect(errorsOf({ seats: [{ provider: 'claude', model: 'sonnet', lens: 'evidence' }] })[0]).toMatch(/^personaPanel\.seats\.0: /);
    expect(errorsOf({ rounds: 0 })[0]).toMatch(/^personaPanel\.rounds: /);
    expect(errorsOf({ onUnavailable: 'substitute' })[0]).toMatch(/^personaPanel\.onUnavailable: /);
    expect(errorsOf({ baseline: 'yes' })[0]).toMatch(/^personaPanel\.baseline: /);
    expect(errorsOf({ seats: [] })[0]).toMatch(/^personaPanel\.seats: /);
  });

  it('effort follows the council rule: a level name, passed where the CLI has the setting, an error where it has none', () => {
    expect(errorsOf({ seats: [{ provider: 'claude', model: 'sonnet', effort: '--model' }] })[0]).toMatch(/^personaPanel\.seats\.0\.effort: /);
    // Every supported CLI has the setting today; for one without, the message names the provider and the seat.
    expect(effortProblem('opencode', new Set(['claude', 'codex']), 'seat')).toBe(
      "provider 'opencode' has no reasoning-effort setting: remove effort from this seat",
    );
  });

  it('a pin to a seat that does not exist is an error; a pin for a slug no persona has is not', () => {
    expect(errorsOf({ seats: twoSeats, personas: { 'field-user': { seat: 2 } } })).toEqual([
      'personaPanel.personas.field-user.seat: seat 2 does not exist (seats: 0 to 1)',
    ]);
    // With no seats given there is the one default seat.
    expect(errorsOf({ personas: { 'field-user': { seat: 1 } } })).toEqual([
      'personaPanel.personas.field-user.seat: seat 1 does not exist (the only seat is 0)',
    ]);
    expect(errorsOf({ seats: twoSeats, personas: { 'field-user': { seat: -1 } } })[0]).toMatch(/^personaPanel\.personas\.field-user\.seat: /);
    expect(errorsOf({ seats: twoSeats, personas: { 'field-user': { seat: 0.5 } } })[0]).toMatch(/^personaPanel\.personas\.field-user\.seat: /);
    expect(errorsOf({ seats: twoSeats, personas: { 'field-user': { seat: 1, model: 'opus' } } })[0]).toMatch(/^personaPanel\.personas\.field-user: /);
    // Personas come and go: the configuration cannot know the slugs, so any slug may be pinned.
    expect(panelSettings(withPanel({ seats: twoSeats, personas: { 'nobody-has-this-slug': { seat: 1 } } }))!.pins).toEqual({ 'nobody-has-this-slug': 1 });
  });
});

describe('unavailable seats', () => {
  const seats = [
    { provider: 'claude', model: 'sonnet' },
    { provider: 'opencode', model: 'big-pickle' },
    { provider: 'codex', model: 'not-configured' },
  ];

  it('a disabled provider or an unconfigured model is not a configuration error', () => {
    const cfg = withPanel({ seats });
    const [first, second, third] = panelSettings(cfg)!.seats;
    expect(seatUnavailable(cfg, first!)).toBeUndefined();
    expect(seatUnavailable(cfg, second!)).toBe("provider 'opencode' is not enabled");
    expect(seatUnavailable(cfg, third!)).toBe("model 'not-configured' is not in providers.codex.models");
  });

  it('start-up warnings name each seat that cannot run, why, and what happens to the personas on it', () => {
    expect(configWarnings(withPanel({ seats }))).toEqual([
      "personaPanel: seat 1 (opencode/big-pickle) cannot run: provider 'opencode' is not enabled. " +
        'Personas on it are unavailable: the panel goes on without them (personaPanel.onUnavailable: report)',
      "personaPanel: seat 2 (codex/not-configured) cannot run: model 'not-configured' is not in providers.codex.models. " +
        'Personas on it are unavailable: the panel goes on without them (personaPanel.onUnavailable: report)',
    ]);
    expect(configWarnings(withPanel({ seats, onUnavailable: 'fail' }))[0]).toBe(
      "personaPanel: seat 1 (opencode/big-pickle) cannot run: provider 'opencode' is not enabled. " +
        'Personas on it are unavailable: the panel phase ends as failed (personaPanel.onUnavailable: fail)',
    );
  });

  it('no warning once the provider is enabled with the model', () => {
    const cfg = withPanel(
      { seats: seats.slice(0, 2) },
      { providers: { opencode: { enabled: true, command: 'opencode', models: ['big-pickle'] } } },
    );
    expect(configWarnings(cfg)).toEqual([]);
  });
});

describe('seatOf', () => {
  const settings = (seats: number, pins: Record<string, number> = {}): PanelSettings => ({
    rounds: 3, baseline: true, onUnavailable: 'report', pins,
    seats: Array.from({ length: seats }, (_, i) => ({ provider: 'claude' as const, model: `model-${i}` })),
  });
  const slugs = (...names: string[]) => names.map((slug) => ({ slug }));
  /** slug → seat index for every persona of `personas`. */
  const seating = (s: PanelSettings, personas: Array<{ slug: string }>) =>
    Object.fromEntries(personas.map((p) => [p.slug, seatOf(s, personas, p).index]));

  it('personas sorted by slug take seats in turn', () => {
    const personas = slugs('finance-approver', 'field-user', 'operations-lead', 'analyst', 'buyer');
    expect(seating(settings(2), personas)).toEqual({ analyst: 0, buyer: 1, 'field-user': 0, 'finance-approver': 1, 'operations-lead': 0 });
    expect(seating(settings(3), personas)).toEqual({ analyst: 0, buyer: 1, 'field-user': 2, 'finance-approver': 0, 'operations-lead': 1 });
    // The seat itself comes back with its index.
    expect(seatOf(settings(2), personas, { slug: 'buyer' })).toEqual({ index: 1, seat: { provider: 'claude', model: 'model-1' } });
  });

  it('is stable: it depends only on the settings and the slugs, not on the order the personas are listed in', () => {
    const personas = slugs('c', 'a', 'b');
    const first = seating(settings(2), personas);
    expect(first).toEqual({ a: 0, b: 1, c: 0 });
    expect(seating(settings(2), personas)).toEqual(first); // a second run
    expect(seating(settings(2), slugs('b', 'c', 'a'))).toEqual(first); // another listing order
    expect(seating(settings(1), personas)).toEqual({ a: 0, b: 0, c: 0 });
  });

  it('a pinned persona sits on its pinned seat, and its pin moves nobody else', () => {
    const personas = slugs('a', 'b', 'c', 'd');
    expect(seating(settings(2), personas)).toEqual({ a: 0, b: 1, c: 0, d: 1 });
    // A pinned persona keeps its place in the turn order: the others sit where they sat without the pin.
    expect(seating(settings(2, { b: 0 }), personas)).toEqual({ a: 0, b: 0, c: 0, d: 1 });
    expect(seating(settings(2, { a: 1, 'not-a-persona': 1 }), personas)).toEqual({ a: 1, b: 1, c: 0, d: 1 });
  });

  it('a new persona moves only the unpinned personas that sort after it, each by one turn', () => {
    const before = seating(settings(3, { d: 0 }), slugs('a', 'c', 'd', 'e'));
    expect(before).toEqual({ a: 0, c: 1, d: 0, e: 0 });
    // 'b' sorts between 'a' and 'c': 'a' stays, 'c' and 'e' move one seat on, the pinned 'd' stays.
    expect(seating(settings(3, { d: 0 }), slugs('a', 'b', 'c', 'd', 'e'))).toEqual({ a: 0, b: 1, c: 2, d: 0, e: 1 });
    // A persona that sorts last moves nobody.
    expect(seating(settings(3, { d: 0 }), slugs('a', 'c', 'd', 'e', 'z'))).toEqual({ ...before, z: 1 });
  });
});

describe('the documented configurations', () => {
  const ROOT = join(import.meta.dirname, '../../..');

  it('the example file has no personaPanel block: copying it leaves the panel as it was, with no baseline run', () => {
    const path = join(ROOT, 'bif.config.example.json');
    expect('personaPanel' in (JSON.parse(readFileSync(path, 'utf8')) as object)).toBe(false);
    expect(panelSettings(loadConfig(path))).toBeUndefined();
  });

  it("the personaPanel block in docs/persona-panel.md is a valid configuration that shows every key", () => {
    const doc = readFileSync(join(ROOT, 'docs', 'persona-panel.md'), 'utf8');
    const block = /```jsonc\n(\s*"personaPanel": \{[\s\S]*?)```/.exec(doc)?.[1];
    expect(block).toBeDefined();
    const { personaPanel } = JSON.parse(`{${block!.replace(/\/\/[^\n]*/g, '')}}`) as { personaPanel: Record<string, unknown> };
    expect(Object.keys(personaPanel).sort()).toEqual(['baseline', 'onUnavailable', 'personas', 'rounds', 'seats']);
    expect(panelSettings(withPanel(personaPanel))).toBeDefined();
  });
});
