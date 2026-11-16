// @vitest-environment jsdom
/**
 * The persona panel of a recommendation on the Strategy page (persona panel design 2026-11-16 §8): per
 * persona the round, the seat, the concerns with their basis, the other side, another route, what it is
 * unsure about, its rulings and its earlier rounds; where the personas disagree, as a range; the
 * baseline on demand; unavailable personas and used-up rounds written out. With no panel served, the
 * feedback is shown as before.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRatingIndexes } from '../../web/src/logic/hooks.js';
import type { PanelBaseline, PersonaFeedback, RecommendationPanel, RecommendationView } from '../../web/src/logic/types.js';
import { Strategy } from '../../web/src/views/Strategy.js';

const T = '2026-11-16T00:00:00.000Z';
const SONNET = { provider: 'claude', model: 'sonnet' } as const;
const CODEX = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } as const;

const scores = (appeal: number, adoption: number, willingnessToPay: number, friction: number) => ({ appeal, adoption, willingnessToPay, friction });

/** A reaction as stored before the panel had seats and rounds. */
const LEGACY: PersonaFeedback = { personaId: 'ps_1', scores: scores(4, 3, 2, 2), concerns: ['price'], reasoning: 'r', wouldChangeMind: 'w', simulated: true };

/** Round 2 of a persona on seat 0: a ruling on one of its two earlier concerns, a grounded and an ungrounded concern, one of them about other people. */
const FIELD: PersonaFeedback = {
  personaId: 'per_field', scores: scores(4, 1, 2, 4), simulated: true, round: 2, seat: SONNET, textHash: 'now',
  concerns: ['Two weeks of pilot do not cover my route', 'It is slow. Most customers will refuse a new login.'],
  concernBasis: ['goals', ''], ungrounded: [1],
  aboutOthers: [{ field: 'concerns', index: 1, text: 'Most customers will refuse a new login.', reason: 'a claim about most, many or all of a group' }],
  reasoning: 'A pilot helps me if it lasts a full route', wouldChangeMind: 'A pilot of a month',
  otherSide: 'An offline mode would bring me back', instead: 'Send the report by text message', unsure: ['whether my employer pays for it'],
  earlierConcerns: ['I work offline in the field', 'The login takes <b>too</b> long'], rulings: [{ concern: 1, ruling: 'resolved', reason: 'The pilot runs offline' }], notRuled: [2],
  sameAsBaseline: false,
};
const FIELD_ROUND_1: PersonaFeedback = {
  personaId: 'per_field', scores: scores(2, 1, 1, 5), simulated: true, round: 1, seat: SONNET, textHash: 'earlier',
  concerns: ['I work offline in the field', 'The login takes <b>too</b> long'], concernBasis: ['constraints', 'pain_points'], ungrounded: [], aboutOthers: [],
  reasoning: 'My day is spent away from a desk', wouldChangeMind: 'An offline mode',
};
/** Round 2 on seat 1, with an effort: both rulings. */
const OPS: PersonaFeedback = {
  personaId: 'per_ops', scores: scores(4, 4, 2, 4), simulated: true, round: 2, seat: CODEX, textHash: 'now',
  concerns: ['The pilot ends before month end'], concernBasis: ['pain_points'], ungrounded: [], aboutOthers: [],
  reasoning: 'I cannot judge it before a close', wouldChangeMind: 'A pilot over a close',
  earlierConcerns: ['Reconciliation breaks at month end'], rulings: [{ concern: 1, ruling: 'stands', reason: 'Month end is still manual' }], notRuled: [],
  sameAsBaseline: false,
};
/** Says what the general reader says; its adoption of 5 is in no range. */
const SMB: PersonaFeedback = {
  personaId: 'per_smb', scores: scores(4, 5, 2, 4), simulated: true, round: 1, seat: SONNET, textHash: 'now',
  concerns: ['The price is not stated'], concernBasis: ['buying_behavior'], ungrounded: [], aboutOthers: [],
  reasoning: 'It reads well but the price is missing', wouldChangeMind: 'A price', sameAsBaseline: true,
};
/** Read an earlier text and has used up its rounds. */
const LATE: PersonaFeedback = {
  personaId: 'per_late', scores: scores(3, 3, 3, 3), simulated: true, round: 2, seat: CODEX, textHash: 'earlier',
  concerns: ['No invoice export'], concernBasis: ['needs'], ungrounded: [], aboutOthers: [], reasoning: 'I need the export', wouldChangeMind: 'An export',
};
/**
 * Round 3: its earlier concerns as carried, each with what was recorded of it when it was raised (a basis,
 * none, a basis about other people, nothing recorded), a ruling with a reason about other people, a
 * `resolved` ruling with no reason, and a new concern whose basis is about other people.
 */
const MOST = 'a claim about most, many or all of a group';
const CARRIED: PersonaFeedback = {
  personaId: 'per_carry', scores: scores(3, 3, 2, 4), simulated: true, round: 3, seat: SONNET, textHash: 'now',
  concerns: ['The pilot is short'], concernBasis: ['Most buyers I know want a quarter'], ungrounded: [],
  reasoning: 'Two months is not a quarter', wouldChangeMind: 'A pilot over a quarter',
  earlierConcerns: ['Most customers will refuse a new login', 'No pilot', 'The price', 'An old worry'],
  earlierConcernBasis: ['what I did last time', '', '40% of the buyers I talk to say so', null],
  rulings: [{ concern: 2, ruling: 'resolved' }, { concern: 1, ruling: 'stands', reason: 'It is still there. Most users need the login.' }],
  notRuled: [3, 4],
  aboutOthers: [
    { field: 'concernBasis', index: 0, text: 'Most buyers I know want a quarter', reason: MOST },
    { field: 'rulings', index: 1, text: 'Most users need the login.', reason: MOST },
    { field: 'earlierConcerns', index: 0, text: 'Most customers will refuse a new login', reason: MOST },
    { field: 'earlierConcernBasis', index: 2, text: '40% of the buyers I talk to say so', reason: 'a share of other people' },
  ],
};
const GENERAL: PanelBaseline = {
  scores: scores(3, 3, 3, 3), simulated: true, round: 2, seat: SONNET, textHash: 'now',
  concerns: ['The price is not stated', 'The length of the pilot is not given'], concernBasis: ['the summary', ''], ungrounded: [1], aboutOthers: [],
  reasoning: 'A reader cannot tell what it costs', wouldChangeMind: 'A price list',
};
const GENERAL_ROUND_1: PanelBaseline = {
  scores: scores(2, 2, 2, 2), simulated: true, round: 1, seat: SONNET, textHash: 'earlier',
  concerns: ['There is no pilot before the contract'], concernBasis: [''], ungrounded: [0], aboutOthers: [], reasoning: 'Nothing can be tried first', wouldChangeMind: 'A pilot',
};

const PANEL: RecommendationPanel = {
  simulated: true,
  disagreement: [{ scale: 'adoption', min: 1, max: 4 }],
  leftOut: 1,
  earlierRounds: [{ personaId: 'per_field', round: 1, reaction: FIELD_ROUND_1 }],
  baseline: { current: true, reaction: GENERAL, earlier: [GENERAL_ROUND_1] },
  unavailable: [{ personaId: 'per_ghost', round: 1, seat: { index: 1, provider: 'opencode', model: 'big-pickle' }, reason: "provider 'opencode' is not enabled" }],
  limitReached: [{ personaId: 'per_late', round: 2 }],
};

const rec = (extra: Partial<RecommendationView>): RecommendationView => ({
  id: 'rec_1', workspaceId: 'ws_1', title: 'Raise prices', summary: 's', criteria: {}, findingIds: [], personaFeedback: [], priority: 3, createdAt: T, status: 'verified', ...extra,
});

let recs: RecommendationView[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const body = path === '/api/workspaces/ws_1/recommendations' ? recs : path === '/api/config' ? { scoring: { personaWeight: 0, weights: {} } } : path.endsWith('/calibration') ? { byCriterion: [] } : [];
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => {
  cleanup();
  resetRatingIndexes();
  vi.unstubAllGlobals();
});

/** A feedback block without its rating controls (they load on their own), as HTML. */
function markupOf(block: Element): string {
  const copy = block.cloneNode(true) as Element;
  for (const crits of copy.querySelectorAll('.crits')) crits.remove();
  return copy.innerHTML;
}
const NEW_WORDS = /Round \d|Runs on|Rests on|No basis|About other people|The other side|Another route|Unsure|Still stands|Resolved|Adds nothing|Unavailable|Round limit|General reader|Where they disagree|Earlier rounds/;

describe('Strategy: persona feedback with no panel', () => {
  it('is shown exactly as before: the persona, its scores to rate, its concerns and its reasoning', async () => {
    recs = [rec({ personaFeedback: [LEGACY] })];
    const { container } = render(<Strategy wsId="ws_1" />);
    await screen.findByText('Raise prices');
    const cell = container.querySelector('td.simulated')!;
    expect(cell.querySelector('section')).toBeNull();
    const blocks = cell.querySelectorAll('.feedback');
    expect(blocks).toHaveLength(1);
    expect(markupOf(blocks[0]!)).toBe(
      '<div><span class="tag">simulated</span> <b>ps_1</b></div>' +
        '<ul class="small"><li>price</li></ul>' +
        '<details><summary>reasoning</summary><p class="small">r</p><p class="small muted">Would change mind: w</p></details>',
    );
    expect(within(blocks[0] as HTMLElement).getAllByRole('button', { name: 'Agree' })).toHaveLength(4);
    expect(cell.textContent).not.toMatch(NEW_WORDS);
  });

  it('says so when there is no feedback', async () => {
    recs = [rec({})];
    const { container } = render(<Strategy wsId="ws_1" />);
    await screen.findByText('Raise prices');
    const cell = container.querySelector('td.simulated')!;
    expect(cell.textContent).toBe('no persona feedback');
  });
});

describe('Strategy: the persona panel of a recommendation', () => {
  const panelOf = async () => {
    render(<Strategy wsId="ws_1" />);
    return (await screen.findByRole('region', { name: 'persona panel of rec_1' })) as HTMLElement;
  };
  /** The block of one persona: its current reaction, or the line that says why it has none. */
  const blockOf = (region: HTMLElement, personaId: string) => within(region).getByText(personaId).closest('.feedback') as HTMLElement;

  it('shows each persona with its round, its seat, its concerns with their basis, the other side, another route and what it is unsure about', async () => {
    recs = [rec({ personaFeedback: [FIELD, OPS, SMB, LATE], panel: PANEL })];
    const region = await panelOf();
    const field = within(blockOf(region, 'per_field'));
    expect(field.getAllByText('simulated').length).toBeGreaterThan(0);
    expect(field.getAllByText('Round 2')).toHaveLength(1);
    expect(field.getAllByText('Runs on claude sonnet').length).toBeGreaterThan(0);
    // A grounded concern names what it rests on; one without a basis says so.
    const grounded = field.getByText('Two weeks of pilot do not cover my route').closest('li')!;
    expect(grounded.textContent).toContain('Rests on: goals');
    const flagged = blockOf(region, 'per_field').querySelector('s')!.closest('li')!;
    expect(flagged.textContent).toContain('No basis in the profile');
    // The sentence about other people is struck out, with the reason; the rest of the concern is not.
    expect([...flagged.querySelectorAll('s')].map((s) => s.textContent)).toEqual(['Most customers will refuse a new login.']);
    expect(flagged.textContent).toContain('It is slow.');
    expect(flagged.textContent).toContain('About other people: not counted (a claim about most, many or all of a group)');
    expect(field.getByText('The other side: An offline mode would bring me back')).toBeTruthy();
    expect(field.getByText('Another route: Send the report by text message')).toBeTruthy();
    expect(field.getByText('Unsure:').textContent).toBe('Unsure:whether my employer pays for it');
    expect(field.getByText('A pilot helps me if it lasts a full route')).toBeTruthy();
    // The seat's effort is shown where the seat has one.
    expect(within(blockOf(region, 'per_ops')).getByText('Runs on codex gpt-6.1-sol (effort medium)')).toBeTruthy();
    // The current reaction of each persona is what can be rated: four scores each.
    expect(within(region).getAllByRole('button', { name: 'Agree' })).toHaveLength(4 * 4);
  });

  it('shows the rulings on its earlier concerns, and its earlier rounds on demand', async () => {
    recs = [rec({ personaFeedback: [FIELD, OPS, SMB, LATE], panel: PANEL })];
    const region = await panelOf();
    const rulings = within(blockOf(region, 'per_field')).getByText('Rulings on its earlier concerns:');
    const [first, second, ...more] = [...rulings.querySelectorAll('li')].map((li) => li.textContent);
    expect(more).toEqual([]);
    expect(first).toBe('I work offline in the field Resolved: The pilot runs offline');
    // No ruling was given on the second; what the persona wrote is shown as text, never as markup.
    expect(second).toBe('The login takes <b>too</b> long No ruling');
    expect(within(blockOf(region, 'per_ops')).getByText('Rulings on its earlier concerns:').textContent).toContain(
      'Reconciliation breaks at month end Still stands: Month end is still manual',
    );
    // Earlier rounds sit in a closed <details> inside the persona's block.
    const earlier = within(blockOf(region, 'per_field')).getByText('Earlier rounds (1)').closest('details')!;
    expect(earlier.open).toBe(false);
    expect(within(earlier).getByText('Round 1')).toBeTruthy();
    expect(within(earlier).getByText('My day is spent away from a desk')).toBeTruthy();
    expect(earlier.textContent).toContain('appeal 2 · adoption 1 · willingnessToPay 1 · friction 5');
    // An earlier round is not rated: only the current reaction has rating controls.
    expect(within(earlier).queryByRole('button', { name: 'Agree' })).toBeNull();
    expect(within(blockOf(region, 'per_ops')).queryByText(/Earlier rounds/)).toBeNull();
  });

  it('shows an earlier concern with the marks it was raised with, and strikes out a basis or a ruling\'s reason about other people', async () => {
    recs = [rec({ personaFeedback: [CARRIED], panel: { ...PANEL, disagreement: [], leftOut: 0, earlierRounds: [], limitReached: [], unavailable: [] } })];
    const region = await panelOf();
    const block = blockOf(region, 'per_carry');
    const [flagged, ungrounded, flaggedBasis, unknown, ...more] = [...within(block).getByText('Rulings on its earlier concerns:').querySelectorAll('li')];
    expect(more).toEqual([]);
    const struck = (li: Element) => [...li.querySelectorAll('s')].map((x) => x.textContent);
    // Flagged when it was raised: struck out here too, with its basis; the sentence about other people in the ruling's reason is struck out.
    expect(struck(flagged!)).toEqual(['Most customers will refuse a new login', 'Most users need the login.']);
    expect(flagged!.textContent).toBe(
      `Most customers will refuse a new login About other people: not counted (${MOST}) Rests on: what I did last time Still stands: It is still there. Most users need the login. About other people: not counted (${MOST})`,
    );
    // Ungrounded when it was raised: it says so here; a `resolved` ruling with no reason ends at the word.
    expect(ungrounded!.textContent).toBe('No pilot No basis in the profile Resolved');
    // A basis that is itself about other people is struck out, wherever the basis is shown.
    expect(struck(flaggedBasis!)).toEqual(['40% of the buyers I talk to say so']);
    expect(flaggedBasis!.textContent).toBe('The price Rests on: 40% of the buyers I talk to say so About other people: not counted (a share of other people) No ruling');
    // Nothing was recorded of it (raised before a basis was asked for): no mark, which is not "no basis".
    expect(unknown!.textContent).toBe('An old worry No ruling');
    const fresh = within(block).getByText('The pilot is short').closest('li')!;
    expect(struck(fresh)).toEqual(['Most buyers I know want a quarter']);
    expect(fresh.textContent).toBe(`The pilot is short Rests on: Most buyers I know want a quarter About other people: not counted (${MOST})`);
  });

  it('marks everything simulated that the panel shows: the line of disagreement, every reaction and earlier round, and the baseline', async () => {
    recs = [rec({ personaFeedback: [FIELD, OPS, SMB, LATE], panel: PANEL })];
    const region = await panelOf();
    const labelled = (el: Element) => [...el.querySelectorAll(':scope > div > .tag, :scope > .tag')].some((tag) => tag.textContent === 'simulated');
    // The range of disagreement is made of simulated scores: it says so itself.
    expect(labelled(within(region).getByText('Where they disagree').closest('.small')!)).toBe(true);
    // Every block that shows a reaction: the four current ones, the earlier round, the baseline and its earlier round.
    const blocks = [...region.querySelectorAll('.feedback')];
    const reactions = blocks.filter((b) => b !== blockOf(region, 'per_ghost'));
    expect(blocks).toHaveLength(8);
    expect(reactions).toHaveLength(7);
    for (const block of reactions) expect(labelled(block), block.textContent!.slice(0, 60)).toBe(true);
    // The baseline: each of its reads, the current one and the earlier one, under the general reader's heading.
    const baseline = within(region).getByText('General reader (no persona)').closest('details')!;
    const reads = [...baseline.querySelectorAll('.feedback')];
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(labelled(read)).toBe(true);
    // What is not a reaction is not labelled as one: a persona that could not be had said nothing.
    expect(labelled(blockOf(region, 'per_ghost'))).toBe(false);
  });

  it('shows where the personas disagree as a range, and no average of their scores anywhere', async () => {
    recs = [rec({ personaFeedback: [FIELD, OPS, SMB, LATE], panel: PANEL })];
    const region = await panelOf();
    const spread = within(region).getByText('Where they disagree').parentElement!;
    expect(spread.textContent).toBe('simulated Where they disagree: adoption 1 to 4');
    // Above the personas.
    expect(spread.compareDocumentPosition(blockOf(region, 'per_field')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(region).getByText('1 reaction is not counted here: it adds nothing beyond a general reader.')).toBeTruthy();
    expect(within(blockOf(region, 'per_smb')).getByText('Adds nothing beyond a general reader')).toBeTruthy();
    expect(within(blockOf(region, 'per_field')).queryByText('Adds nothing beyond a general reader')).toBeNull();
    // The adoption scores are 1, 4, 5 and 3: no mean of all of them (3.25), of the counted ones (2.67) or of the range (2.5).
    const page = document.body.textContent!;
    for (const average of ['3.25', '2.67', '2.5', '2.50', '3.3']) expect(page, average).not.toContain(average);
    expect(page).not.toMatch(/\b(mean|average|avg)\b/i);
  });

  it('writes out an unavailable persona and a used-up round limit', async () => {
    recs = [rec({ personaFeedback: [FIELD, OPS, SMB, LATE], panel: PANEL })];
    const region = await panelOf();
    // A persona with no reaction has a block of its own that says why.
    const ghost = blockOf(region, 'per_ghost');
    expect(ghost.textContent).toContain("Unavailable (round 1): provider 'opencode' is not enabled. Runs on opencode big-pickle; no other model was tried.");
    expect(within(ghost).queryByRole('button', { name: 'Agree' })).toBeNull();
    expect(within(ghost).queryByText('simulated')).toBeNull();
    // A persona whose rounds are used up keeps its reaction to the earlier text, and says so.
    const late = blockOf(region, 'per_late');
    expect(late.textContent).toContain('Round limit reached: it has not read the text as it is now (its last read was round 2).');
    expect(within(late).getByText('No invoice export')).toBeTruthy();
    expect(within(blockOf(region, 'per_field')).queryByText(/Round limit reached|Unavailable/)).toBeNull();
  });

  it('a persona that was unavailable for the text as it is now keeps its earlier reaction, and says so', async () => {
    recs = [rec({
      personaFeedback: [LATE],
      panel: { ...PANEL, disagreement: [], leftOut: 0, earlierRounds: [], limitReached: [], unavailable: [{ personaId: 'per_late', round: 3, seat: { index: 1, ...CODEX }, reason: 'no submit_persona_feedback call' }] },
    })];
    const region = await panelOf();
    expect(within(region).getAllByText('per_late')).toHaveLength(1);
    const late = blockOf(region, 'per_late');
    expect(late.textContent).toContain('Unavailable (round 3): no submit_persona_feedback call. Runs on codex gpt-6.1-sol (effort medium); no other model was tried.');
    expect(within(late).getByText('Round 2')).toBeTruthy();
    expect(within(region).queryByText('Where they disagree')).toBeNull();
    expect(within(region).queryByText(/not counted here/)).toBeNull();
  });

  it('shows the baseline on demand, marked simulated, apart from the personas and not to be rated', async () => {
    recs = [rec({ personaFeedback: [FIELD, OPS, SMB, LATE], panel: PANEL })];
    const region = await panelOf();
    const baseline = within(region).getByText('General reader (no persona)').closest('details')!;
    expect(baseline.open).toBe(false);
    expect(baseline.closest('.feedback')).toBeNull();
    const b = within(baseline);
    expect(b.getAllByText('simulated').length).toBeGreaterThan(0);
    expect(b.getByText('Round 2')).toBeTruthy();
    expect(b.getAllByText('Runs on claude sonnet').length).toBeGreaterThan(0);
    expect(baseline.textContent).toContain('appeal 3 · adoption 3 · willingnessToPay 3 · friction 3');
    expect(b.getAllByText('The price is not stated')[0]!.closest('li')!.textContent).toContain('Rests on: the summary');
    // A general reader has no profile: a concern of its own without a basis rests on nothing in the text.
    expect(b.getByText('The length of the pilot is not given').closest('li')!.textContent).toContain('No basis in the text');
    expect(b.queryByRole('button', { name: 'Agree' })).toBeNull();
    const earlier = b.getByText('Earlier rounds (1)').closest('details')!;
    expect(within(earlier).getByText('There is no pilot before the contract')).toBeTruthy();
    expect(b.queryByText(/Unavailable|Round limit reached|earlier text/)).toBeNull();
  });

  it('says when the baseline could not be had, or has used up its rounds', async () => {
    const { baseline: _stored, ...noBaseline } = PANEL;
    recs = [
      rec({ personaFeedback: [OPS], panel: { ...noBaseline, baselineUnavailable: { round: 1, seat: { index: 0, ...SONNET }, reason: 'run failed: exit 1' } } }),
      rec({ id: 'rec_2', title: 'Second', personaFeedback: [OPS], panel: { ...PANEL, baseline: { current: false, reaction: GENERAL, earlier: [] }, baselineLimitReached: true } }),
    ];
    const first = within(await panelOf()).getByText('General reader (no persona)').closest('details')!;
    expect(first.textContent).toContain('Unavailable (round 1): run failed: exit 1. Runs on claude sonnet; no other model was tried.');
    expect(within(first).queryByText('simulated')).toBeNull();
    const second = within(screen.getByRole('region', { name: 'persona panel of rec_2' })).getByText('General reader (no persona)').closest('details')!;
    expect(second.textContent).toContain('Round limit reached: it has not read the text as it is now (its last read was round 2).');
    expect(within(second).getByText('The length of the pilot is not given')).toBeTruthy();
  });

  it('a configured panel with nothing read yet shows no feedback and no baseline', async () => {
    recs = [rec({ panel: { simulated: true, disagreement: [], leftOut: 0, earlierRounds: [], unavailable: [], limitReached: [] } })];
    const region = await panelOf();
    expect(region.textContent).toBe('no persona feedback');
  });
});
