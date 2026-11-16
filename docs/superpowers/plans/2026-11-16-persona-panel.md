# Persona Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `personaPanel` is configured, the segment persona panel seats personas across CLIs and models, runs a no-persona baseline, asks for grounded answers, and re-reads a recommendation only when it changed, with the persona ruling on its own earlier concerns.

**Architecture:** Settings and seat assignment in `src/core/market/panelSettings.ts`; baseline, rounds and the answer checks in `src/core/market/panel.ts` (split a `panelRounds.ts` out if the file grows past what one read holds). The tool schema gains optional fields. Flow verdict runs take the persona's seat. The page reads the richer `PersonaFeedback`.

**Tech Stack:** Node 25, TypeScript ESM, node:sqlite, zod, Hono, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-persona-panel-design.md` (read it first). The skill it implements: `.claude/skills/persona-panel/SKILL.md`.

## Global Constraints

- `src/core` never imports from `src/api` or `web`.
- With no `personaPanel` block: same prompt text, same runs, same stored feedback as today. Existing tests pass without changes to their expectations (except tests pinning the tool schema, config defaults or the migration list).
- One run per persona per recommendation; a run's prompt never holds another persona's reaction or concerns, nor the baseline.
- A persona is never run on a seat or model other than its own.
- The baseline is never stored or counted as a persona's feedback.
- Persona output stays marked simulated and never changes a recommendation's scores or priority.
- Stakeholder reads are not changed.
- Tests never spawn a real CLI.
- Run `npm test`, `npm run typecheck` before each commit; `npm run build:web` when `web/` changed.

## Review Focus

1. Byte-identical behaviour without the block (prompt version included: the prompt store must not get a new version).
2. Seat assignment is stable: adding a recommendation, or re-running, never moves a persona to another seat; adding a persona may move others only as the turn-taking rule says, and the test documents it.
3. Round 2 prompt: only that persona's own earlier concerns; nothing of the baseline or of other personas (test with marker strings).
4. Unchanged text → no run, for personas and for the baseline. Round limit → no run, reported.
5. `onUnavailable: "fail"` keeps reactions already stored and names the persona and seat.
6. The export and the knowledge store treat the new fields and the baseline as simulated persona output, as feedback is treated today.

## File Structure

- `src/core/config/schema.ts`, `load.ts` — `personaPanel`. `src/core/market/panelSettings.ts` — `panelSettings`, `seatOf`.
- `src/core/market/panel.ts` (and `panelRounds.ts` if split) — seats, baseline, rounds, checks.
- `src/core/prompts/persona_panel_rules.md`, `persona_panel_round.md` — the added prompt parts.
- `src/core/harness/tools/registry.ts` — `submit_persona_feedback` fields. `src/core/types.ts` — `PersonaFeedback`.
- `src/core/flows/round.ts` — the persona's seat.
- `web/src/views/Strategy.tsx` and its panel components; `web/src/logic/types.ts`.
- Tests: `test/core/market/{panelSettings,panelSeats,panelBaseline,panelRounds}.test.ts`, `test/web/personaPanel.test.tsx`.

---

### Task 1: Settings, seats, unavailable personas, the answer fields

**Files:** modify `src/core/config/{schema,load}.ts`, `src/core/harness/tools/registry.ts`, `src/core/types.ts`, `src/core/market/panel.ts`, `src/core/flows/round.ts`; create `src/core/market/panelSettings.ts`, `src/core/prompts/persona_panel_rules.md`; tests `test/core/market/{panelSettings,panelSeats}.test.ts`.

**Interfaces — Produces:**

```ts
// market/panelSettings.ts
export type PanelSeat = { provider: ProviderId; model: string; effort?: string };
export type PanelSettings = { rounds: number; baseline: boolean; onUnavailable: 'fail' | 'report'; seats: PanelSeat[]; pins: Record<string, number> };
export function panelSettings(config: Pick<BifConfig, 'personaPanel' | 'roles'>): PanelSettings | undefined;   // undefined: today's behaviour
export function seatOf(settings: PanelSettings, personas: Pick<Persona, 'slug'>[], persona: Pick<Persona, 'slug'>): { index: number; seat: PanelSeat };
export function seatUnavailable(config: Pick<BifConfig, 'providers'>, seat: PanelSeat): string | undefined;
```

Rules: spec §3, §4, §6.

- [ ] `personaPanel` in the config schema with the errors, defaults and start-up warnings of spec §3. Reuse the council's handling of `cli`/`provider` and `effort` (see `src/core/council/settings.ts` and the adapters) instead of writing it again.
- [ ] `segmentPanel`: each persona runs on its seat (`model`, `effort`); an unavailable seat or a run without an answer after the existing retry is recorded as unavailable (spec §4), under both settings. `PanelReport` gains what the page and the phase need to say so.
- [ ] Flow verdict runs (`flows/round.ts`) use the persona's seat when the panel is configured.
- [ ] `submit_persona_feedback` gains the optional fields of spec §6 (not `rulings` semantics yet: accept and store them; Task 2 uses them). `PersonaFeedback` gains the fields of spec §9. The prompt gets `persona_panel_rules.md` appended only when the panel is configured.
- [ ] Ungrounded concerns and the `aboutOthers` flag (spec §6): a small, documented pattern list (percentages, "most|many|all (people|customers|users|buyers)", market size words with a number); tests for hits and for near misses (the persona's own scores, "I would pay 20% more").
- [ ] Tests incl. Review Focus 1, 2, 5.

---

### Task 2: The baseline and the rounds

**Files:** modify `src/core/market/panel.ts` (or create `panelRounds.ts`), `src/core/store/{migrations,repos}.ts`, `src/core/types.ts`; create `src/core/prompts/persona_panel_round.md`; modify the export and knowledge read paths only as far as Review Focus 6 needs; tests `test/core/market/{panelBaseline,panelRounds}.test.ts`.

Rules: spec §5, §7, §9.

- [ ] Storage for earlier rounds and the baseline per recommendation (migration; existing rows read as round 1 with no hash).
- [ ] The baseline run (neutral system prompt, seat 0, same tool), stored apart; `sameAsBaseline` with `issueSimilarity` at its repeat threshold over concerns plus reasoning; a failed baseline is reported and marks nothing.
- [ ] Rounds: the three cases and the limit of spec §7, for personas and for the baseline; the round-2 prompt part with the persona's own earlier concerns and the changed text; `rulings` checked against the concerns that were listed (a ruling on an unknown concern is refused with a message; a missing ruling is recorded as not ruled).
- [ ] Tests incl. Review Focus 3, 4, 6.

---

### Task 3: The page, docs, smoke

**Files:** modify `web/src/views/Strategy.tsx` and its panel components, `web/src/logic/types.ts`, the route that serves recommendations with their panel if it shapes the feedback, `README.md`, the example configuration, `scripts/smoke.ts` (mode `persona-panel`); tests `test/web/personaPanel.test.tsx`, `test/core/market/panelEndToEnd.test.ts`.

Rules: spec §8, §10.

- [ ] The panel on the page per spec §8. Disagreement shown as a range per scale; no average of persona scores anywhere on the page.
- [ ] README: what the panel is and is not (from the skill), the configuration with every key, the cost note (a baseline adds one run per recommendation per round), unavailable personas.
- [ ] End-to-end test with fake agents: two seats, three personas, baseline, a changed recommendation, round 2, the limit.
- [ ] Smoke mode `persona-panel`: three personas on two Claude models with a baseline on one recommendation; then the recommendation's summary is changed and the panel runs again. Checks: one run per persona on its own seat with its own prompt; the baseline stored apart; round 2 prompts hold only the persona's own concerns; rulings stored; a third run on unchanged text starts no run. Do not run it; the controller does.
