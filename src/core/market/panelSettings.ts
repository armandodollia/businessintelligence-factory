import { PERSONA_PANEL_DEFAULTS, modelUnavailable, type BifConfig, type ProviderId } from '../config/schema.js';
import type { Persona } from '../types.js';

/**
 * Persona panel settings (design 2026-11-16-persona-panel-design.md §3): the seats personas run on, the
 * baseline, the rounds and what an unavailable persona does. Everything that runs a persona reads them
 * through `panelSettings` (which applies the defaults) and `seatOf`, so a persona has the same seat in the
 * segment panel and in flow verdict runs.
 */

/** The CLI, model and effort the personas on a seat run with. */
export type PanelSeat = { provider: ProviderId; model: string; effort?: string };

export type PanelSettings = {
  /** Most reads of one recommendation by one persona. */
  rounds: number;
  /** One run with no persona per recommendation. */
  baseline: boolean;
  onUnavailable: 'fail' | 'report';
  /** At least one seat. */
  seats: PanelSeat[];
  /** Persona slug → index into `seats`. May name slugs no persona has. */
  pins: Record<string, number>;
};

/** The configured panel with the defaults applied; `undefined` with no `personaPanel` block (the panel runs as before). */
export function panelSettings(config: Pick<BifConfig, 'personaPanel' | 'roles'>): PanelSettings | undefined {
  const panel = config.personaPanel;
  if (!panel) return undefined;
  const seats: PanelSeat[] = panel.seats ?? [config.roles.persona];
  return {
    rounds: panel.rounds ?? PERSONA_PANEL_DEFAULTS.rounds,
    baseline: panel.baseline ?? PERSONA_PANEL_DEFAULTS.baseline,
    onUnavailable: panel.onUnavailable ?? PERSONA_PANEL_DEFAULTS.onUnavailable,
    seats: seats.map(({ provider, model, effort }) => ({ provider, model, ...(effort !== undefined ? { effort } : {}) })),
    pins: Object.fromEntries(Object.entries(panel.personas ?? {}).map(([slug, pin]) => [slug, pin.seat])),
  };
}

/**
 * The seat of `persona` among `personas` (the node's usable personas, in any order): its pinned seat, else
 * the personas sorted by slug take the seats in turn (the first the first seat, …, starting over after the
 * last). A pinned persona keeps its place in that order, so a pin moves nobody else. The answer depends
 * only on the settings and the slugs: it is the same on every run and for every recommendation. A new
 * persona moves the unpinned personas that sort after it one seat on.
 */
export function seatOf(settings: PanelSettings, personas: Pick<Persona, 'slug'>[], persona: Pick<Persona, 'slug'>): { index: number; seat: PanelSeat } {
  const pinned = Object.hasOwn(settings.pins, persona.slug) ? settings.pins[persona.slug] : undefined;
  // By code unit, not by locale: the order must not depend on the machine.
  const turn = [...new Set([...personas.map((p) => p.slug), persona.slug])].sort().indexOf(persona.slug);
  const index = pinned ?? turn % settings.seats.length;
  const seat = settings.seats[index];
  if (!seat) throw new Error(`persona '${persona.slug}' is pinned to seat ${index}, which does not exist`);
  return { index, seat };
}

/**
 * Why no run can be started on `seat` with this configuration (its provider is disabled, or its model is
 * not one of the provider's `models`); `undefined` when one can. The personas on such a seat are
 * unavailable: they are never run on another seat or model (design §4).
 */
export function seatUnavailable(config: Pick<BifConfig, 'providers'>, seat: PanelSeat): string | undefined {
  return modelUnavailable(config.providers, seat);
}
