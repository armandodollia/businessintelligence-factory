import { describe, expect, it } from 'vitest';
import { mergeCouncil, type CouncilIssueIn, type MemberReview, type MergeInput } from '../../../src/core/council/merge.js';
import type { CouncilMember, CouncilStage } from '../../../src/core/council/settings.js';
import { issueSimilarity as issueSimilarityOf } from '../../../src/core/learning/reviewIssues.js';

const member = (name: string, over: Partial<CouncilMember> = {}): CouncilMember => ({
  name, provider: 'claude', model: 'opus', lens: 'evidence', blocking: true, ...over,
});
const A = member('a');
const B = member('b', { lens: 'reasoning' });
const C = member('c', { lens: 'brief' });
const N = member('n', { lens: 'rewrite', blocking: false });

const reviewed = (m: CouncilMember, score: number, issues: CouncilIssueIn[] = [], extra: Partial<MemberReview> = {}): MemberReview => ({
  member: m, state: 'reviewed', score, issues, questions: [], followUps: [], ...extra,
});
const absent = (m: CouncilMember, state: MemberReview['state'], reason?: string): MemberReview => ({
  member: m, state, issues: [], questions: [], followUps: [], ...(reason ? { reason } : {}),
});

/** A substantive issue about `fnd_1` unless overridden. Members number their own issues, so ids collide across members. */
const issue = (description: string, over: Partial<CouncilIssueIn> = {}): CouncilIssueIn => ({
  id: 'I1', class: 'substantive', description, where: ['fnd_1'], ...over,
});

const merge = (reviews: MemberReview[], over: Partial<Omit<MergeInput, 'stage'>> & { stage?: Partial<CouncilStage> } = {}) => {
  const { stage, ...rest } = over;
  return mergeCouncil({
    stage: { rounds: 3, passScore: 9, blockOn: 'any', onUnavailable: 'fail', members: reviews.map((r) => r.member), ...stage },
    round: 1,
    reviews,
    earlier: [],
    disputed: new Set(),
    ...rest,
  });
};

const REVENUE = 'The revenue figure in the finding does not match the cited filing';
const STALE = 'The pricing claim rests on a page captured two years ago';
const CAUSE = 'The hypothesis ignores the churn data that points the other way';

describe('mergeCouncil: same defect (step 3.1)', () => {
  it('issues of different members about the same thing become one, keeping every name and all evidence', () => {
    const r = merge([
      reviewed(A, 6, [issue(REVENUE, { evidence: ['art_1'] })]),
      reviewed(B, 5, [issue(`${REVENUE} page`, { class: 'blocking', evidence: ['art_2', 'art_1'] })]),
    ]);
    expect(r.issues).toEqual([
      {
        id: 'I1', class: 'blocking', description: `${REVENUE} page`, evidence: ['art_1', 'art_2'], where: ['fnd_1'],
        raisedBy: ['a', 'b'], standing: 'upheld',
      },
    ]);
  });

  it('an issue with no where joins one about an output when the text is similar', () => {
    const r = merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(REVENUE, { where: undefined, evidence: ['art_9'] })])]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ where: ['fnd_1'], evidence: ['art_9'], raisedBy: ['a', 'b'] });
  });

  it('issues with disjoint non-empty where are never merged, however similar the text', () => {
    const r = merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(REVENUE, { where: ['fnd_2'] })])]);
    expect(r.issues.map((i) => [i.id, i.where, i.raisedBy])).toEqual([['I1', ['fnd_1'], ['a']], ['I2', ['fnd_2'], ['b']]]);
  });

  it('different texts, different actions, and two issues of one member stay apart', () => {
    expect(merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(STALE)])]).issues).toHaveLength(2);
    expect(merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(REVENUE, { action: 'delete' })])]).issues).toHaveLength(2);
    const twice = merge([reviewed(A, 6, [issue(REVENUE), issue(REVENUE, { id: 'I2' })]), reviewed(B, 6, [issue(REVENUE)])]);
    expect(twice.issues.map((i) => i.raisedBy)).toEqual([['a', 'b'], ['a']]);
  });

  it('merged issues get ids that are unique in the round, whatever ids the members used', () => {
    const r = merge([
      reviewed(A, 6, [issue(REVENUE), issue(STALE, { id: 'I2', class: 'nit' })]),
      reviewed(B, 6, [issue(CAUSE), issue('Add a section on the Asian market', { id: 'I2', class: 'scope_expansion' })]),
    ]);
    const ids = [...r.issues.map((i) => i.id), ...r.dropped.map((d) => d.issue.id)];
    expect(ids).toEqual(['I1', 'I2', 'I3', 'I4']);
  });
});

describe('mergeCouncil: the same defect in each member\'s own words (step 3.1, ruling of 2026-11-16)', () => {
  const earlier = [{ id: 'I1', description: REVENUE, where: ['fnd_1'] }];
  // Members are new runs each round: asked whether I1 still stands, each says so in its own words.
  const OWN_WORDS = [
    'Finding one still gives 12 million where the filing says 10',
    'The corrected claim repeats the wrong total from the draft',
    'Nothing changed: page 3 of the annual report contradicts this number',
  ] as const;
  // The same defect on the same output, paraphrased: alike at the looser measure only.
  const PARAPHRASES = [
    'The revenue figure is still wrong against the filing',
    'The revenue figure still does not agree with the filing',
    'Revenue in the finding is not the figure the filing gives',
  ] as const;
  const pairs = <T>(xs: readonly T[]): Array<[T, T]> => xs.flatMap((a, i) => xs.slice(i + 1).map((b): [T, T] => [a, b]));

  it.each(['any', 'majority', 'all'] as const)(
    'round 2, %s: three blocking members relist I1, each in its own words and scoring 5: one upheld issue raised by all three, and the round fails',
    (blockOn) => {
      for (const [a, b] of pairs(OWN_WORDS)) expect(issueSimilarityOf(a, b)).toBeLessThan(0.25);
      const r = merge(
        [
          reviewed(A, 5, [issue(OWN_WORDS[0], { where: ['fnd_9'] })]),
          // Another output (the corrected finding was saved anew), and one that cites evidence only.
          reviewed(B, 5, [issue(OWN_WORDS[1], { where: ['fnd_8'] })]),
          reviewed(C, 5, [issue(OWN_WORDS[2], { where: undefined, evidence: ['art_1'] })]),
        ],
        { round: 2, earlier, stage: { blockOn } },
      );
      expect(r.issues).toEqual([
        {
          // Each member's own words reach the worker (council review C6).
          id: 'I1', class: 'substantive', description: `${OWN_WORDS[0]}\nAlso raised by b: ${OWN_WORDS[1]}\nAlso raised by c: ${OWN_WORDS[2]}`, wordings: [...OWN_WORDS],
          where: ['fnd_9', 'fnd_8'], evidence: ['art_1'], raisedBy: ['a', 'b', 'c'], standing: 'upheld',
        },
      ]);
      expect(r).toMatchObject({ pass: false, score: 5 });
      for (const m of r.members) expect(m).toMatchObject({ score: 5, countedScore: 5 });
      for (const m of r.members) expect(m).not.toHaveProperty('unsupportedScore');
    },
  );

  it('majority: two members paraphrase a round-1 defect on the same output, without its id: one issue, upheld under the earlier id', () => {
    for (const [a, b] of pairs(PARAPHRASES)) {
      expect(issueSimilarityOf(a, b)).toBeGreaterThanOrEqual(0.25);
      expect(issueSimilarityOf(a, b)).toBeLessThan(0.6);
    }
    const r = merge(
      [reviewed(A, 6, [issue(PARAPHRASES[0], { id: 'I7' })]), reviewed(B, 6, [issue(PARAPHRASES[1], { id: 'I8' })]), reviewed(C, 9)],
      { round: 2, earlier, stage: { blockOn: 'majority' } },
    );
    expect(r.issues.map((i) => [i.id, i.raisedBy, i.standing])).toEqual([['I1', ['a', 'b'], 'upheld']]);
    expect(r).toMatchObject({ pass: false, score: 6 });
    // In round 1 too: the same output and loosely alike is one defect.
    const first = merge([reviewed(A, 6, [issue(PARAPHRASES[0])]), reviewed(B, 6, [issue(PARAPHRASES[2])]), reviewed(C, 9)], { stage: { blockOn: 'majority' } });
    expect(first.issues.map((i) => [i.raisedBy, i.standing])).toEqual([[['a', 'b'], 'upheld']]);
  });

  it('loosely alike is not enough without a shared output: about no output, or about different ones, the issues stay apart', () => {
    const nowhere = merge([reviewed(A, 6, [issue(PARAPHRASES[0])]), reviewed(B, 6, [issue(PARAPHRASES[1], { where: undefined, evidence: ['art_1'] })])]);
    expect(nowhere.issues.map((i) => i.raisedBy)).toEqual([['a'], ['b']]);
    const elsewhere = merge([reviewed(A, 6, [issue(PARAPHRASES[0])]), reviewed(B, 6, [issue(PARAPHRASES[1], { where: ['fnd_2'] })])]);
    expect(elsewhere.issues.map((i) => i.raisedBy)).toEqual([['a'], ['b']]);
  });

  it('issues that reuse different earlier ids are different defects, however alike; an unlisted id joins nothing by itself', () => {
    const two = [...earlier, { id: 'I2', description: `${REVENUE} either`, where: ['fnd_1'] }];
    const r = merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(REVENUE, { id: 'I2' })])], { round: 2, earlier: two });
    expect(r.issues.map((i) => [i.id, i.raisedBy])).toEqual([['I1', ['a']], ['I2', ['b']]]);
    // I1 was never shown to the members (an advisory issue): both carry the id by chance.
    const unlisted = merge(
      [reviewed(A, 9, [issue(OWN_WORDS[0], { where: ['fnd_9'] })]), reviewed(B, 9, [issue(OWN_WORDS[1], { where: ['fnd_8'] })])],
      { round: 2, earlier: [{ ...earlier[0]!, unlisted: true }] },
    );
    expect(unlisted.issues.map((i) => i.raisedBy)).toEqual([['a'], ['b']]);
  });

  it('the id decides before the words do: an issue under the earlier id joins the other issue under that id, not a similar one without it', () => {
    const r = merge(
      [reviewed(A, 6, [issue(PARAPHRASES[0], { id: 'I7' })]), reviewed(B, 6, [issue(OWN_WORDS[0], { where: ['fnd_9'] })]), reviewed(C, 6, [issue(PARAPHRASES[1])])],
      { round: 2, earlier, stage: { blockOn: 'majority' } },
    );
    // c's words are close to a's and about the same output, but c says "I1" as b does.
    expect(r.issues.find((i) => i.id === 'I1')).toMatchObject({ raisedBy: ['b', 'c'], standing: 'upheld' });
  });

  it('a member that lists the earlier id twice is counted once', () => {
    const r = merge(
      [reviewed(A, 6, [issue(OWN_WORDS[0], { where: ['fnd_9'] }), issue(OWN_WORDS[1], { where: ['fnd_8'] })]), reviewed(B, 6, [issue(OWN_WORDS[2], { where: ['fnd_9'] })]), reviewed(C, 9)],
      { round: 2, earlier, stage: { blockOn: 'majority' } },
    );
    expect(r.issues.map((i) => [i.id, i.raisedBy])).toEqual([['I1', ['a', 'b']], ['I2', ['a']]]);
  });
});

describe('mergeCouncil: nits and scope (step 3.2, rules 3 and 4)', () => {
  it('a nit is dropped with rule nit: it blocks nothing and lowers no score', () => {
    const r = merge([reviewed(A, 4, [issue('The summary uses passive voice', { class: 'nit' })]), reviewed(B, 9)]);
    expect(r.issues).toEqual([]);
    expect(r.dropped).toEqual([
      { issue: { id: 'I1', class: 'nit', description: 'The summary uses passive voice', where: ['fnd_1'] }, raisedBy: ['a'], rule: 'nit' },
    ]);
    expect(r.followUps).toEqual([]);
    expect(r).toMatchObject({ pass: true, score: 9 });
    expect(r.members[0]).toMatchObject({ score: 4, countedScore: 9, unsupportedScore: true });
  });

  it('a scope issue is dropped with rule scope and kept as a follow-up, next to the follow-ups members sent', () => {
    const r = merge([
      reviewed(A, 5, [issue('Add a section on the Asian market', { class: 'scope_expansion', where: undefined })], {
        followUps: ['The competitor list is from last year'],
      }),
      reviewed(B, 9, [issue('Add a section on the Asian market too', { class: 'scope_expansion', where: undefined })], {
        followUps: ['The competitor list is from last year'],
      }),
    ]);
    expect(r.issues).toEqual([]);
    expect(r.dropped).toEqual([
      { issue: { id: 'I1', class: 'scope_expansion', description: 'Add a section on the Asian market' }, raisedBy: ['a', 'b'], rule: 'scope' },
    ]);
    expect(r.followUps).toEqual([
      { text: 'The competitor list is from last year', raisedBy: ['a', 'b'] },
      { text: 'Add a section on the Asian market', raisedBy: ['a', 'b'] },
    ]);
    expect(r).toMatchObject({ pass: true, score: 9 });
  });

  it("one member's nit is not merged into another member's substantive issue about the same thing", () => {
    const r = merge([reviewed(A, 9, [issue(REVENUE, { class: 'nit' })]), reviewed(B, 6, [issue(REVENUE)])]);
    expect(r.issues.map((i) => i.raisedBy)).toEqual([['b']]);
    expect(r.dropped.map((d) => [d.raisedBy, d.rule])).toEqual([[['a'], 'nit']]);
  });
});

describe('mergeCouncil: evidence or nothing (step 3.3, rule 7)', () => {
  it('a blocking or substantive issue with neither where nor evidence becomes a question', () => {
    const r = merge([
      reviewed(A, 3, [issue('I suspect the market size is made up', { class: 'blocking', where: undefined })], {
        questions: ['Is the 2024 figure audited?'],
      }),
      reviewed(B, 9, [issue('I suspect the market size is made up', { where: [], evidence: [] })], { questions: ['Is the 2024 figure audited?'] }),
    ]);
    expect(r.issues).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.questions).toEqual([
      { text: 'Is the 2024 figure audited?', raisedBy: ['a', 'b'] },
      { text: 'I suspect the market size is made up', raisedBy: ['a', 'b'] },
    ]);
    // The low score rested on nothing shown: it is an unsupported score.
    expect(r).toMatchObject({ pass: true, score: 9 });
    expect(r.members[0]).toMatchObject({ score: 3, countedScore: 9, unsupportedScore: true });
  });

  it('where alone, or evidence alone, keeps it an issue', () => {
    expect(merge([reviewed(A, 6, [issue(REVENUE)])]).issues).toHaveLength(1);
    expect(merge([reviewed(A, 6, [issue(REVENUE, { where: undefined, evidence: ['art_1'] })])]).issues).toHaveLength(1);
  });
});

describe('mergeCouncil: disputes (step 3.4)', () => {
  const earlier = [{ id: 'I1', description: REVENUE, where: ['fnd_1'] }, { id: 'I2', description: STALE, where: ['fnd_2'] }];
  const disputed = new Set(['I1']);
  // Says why the worker's reason does not hold: other words than the issue the worker pushed back on.
  const NEW = 'The reason given does not hold: page 3 of the filing says 10 million';

  it('an issue the worker pushed back on, raised again in the earlier words, does not block: it says nothing new', () => {
    const byText = merge([reviewed(A, 9, [issue(REVENUE, { id: 'I7' })])], { round: 2, earlier, disputed });
    expect(byText.issues).toEqual([
      { id: 'I1', class: 'substantive', description: REVENUE, where: ['fnd_1'], raisedBy: ['a'], standing: 'advisory' },
    ]);
    expect(byText.pass).toBe(true);
    // Under its id, as `blocking`, with a word changed: still a repeat.
    const almost = `${REVENUE} still`;
    expect(issueSimilarityOf(almost, REVENUE)).toBeGreaterThanOrEqual(0.9);
    const byId = merge([reviewed(A, 9, [issue(almost, { class: 'blocking' })])], { round: 2, earlier, disputed });
    expect(byId.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'advisory']]);
  });

  it('the earlier words with other evidence under them are still a repeat', () => {
    const r = merge([reviewed(A, 9, [issue(REVENUE, { evidence: ['art_1'] })])], { round: 2, earlier, disputed });
    expect(r.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'advisory']]);
    expect(r.pass).toBe(true);
  });

  it('raised again with something new to say, it blocks: about an output with no evidence cited, or on evidence alone', () => {
    expect(issueSimilarityOf(NEW, REVENUE)).toBeLessThan(0.9);
    // The case the earlier rule lost: `where` and no `evidence`, reasserted by every member.
    for (const blockOn of ['any', 'majority', 'all'] as const) {
      const all = merge(
        [A, B, C].map((m) => reviewed(m, 6, [issue(NEW, { class: 'blocking' })])),
        { round: 2, earlier, disputed, stage: { blockOn } },
      );
      expect(all.issues.map((i) => [i.id, i.raisedBy, i.standing])).toEqual([['I1', ['a', 'b', 'c'], 'upheld']]);
      expect(all).toMatchObject({ pass: false, score: 6 });
    }
    const cited = merge([reviewed(A, 9, [issue(NEW, { where: undefined, evidence: ['art_1'] })])], { round: 2, earlier, disputed });
    expect(cited.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'upheld']]);
    // In other words and under another id: the same output and loosely alike makes it the disputed issue.
    const loose = 'The revenue figure is still wrong against the filing';
    const byWords = merge([reviewed(A, 6, [issue(loose, { id: 'I7' })])], { round: 2, earlier, disputed });
    expect(byWords.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'upheld']]);
  });

  it('one member that says something new is enough for the issue it raised with others', () => {
    const r = merge([reviewed(A, 9, [issue(REVENUE)]), reviewed(B, 9, [issue(NEW)])], { round: 2, earlier, disputed });
    expect(r.issues.map((i) => [i.raisedBy, i.standing])).toEqual([[['a', 'b'], 'upheld']]);
    const repeats = merge([reviewed(A, 9, [issue(REVENUE)]), reviewed(B, 9, [issue(REVENUE)])], { round: 2, earlier, disputed });
    expect(repeats.issues.map((i) => [i.raisedBy, i.standing])).toEqual([[['a', 'b'], 'advisory']]);
  });

  it('an earlier issue that is not disputed may be repeated word for word; an unrelated new issue is not a reassertion', () => {
    const repeat = merge([reviewed(A, 6, [issue(STALE, { id: 'I5', where: ['fnd_2'] })])], { round: 2, earlier, disputed });
    expect(repeat.issues.map((i) => [i.id, i.standing])).toEqual([['I2', 'upheld']]);
    const other = merge([reviewed(A, 6, [issue(CAUSE, { id: 'I5', class: 'blocking', where: ['fnd_3'] })])], { round: 2, earlier, disputed });
    expect(other.issues.map((i) => [i.id, i.standing])).toEqual([['I3', 'upheld']]);
  });

  it('a reassertion that names neither an output nor evidence is a question (rule 7) before it can block', () => {
    const r = merge([reviewed(A, 9, [issue(NEW, { class: 'blocking', where: undefined })])], { round: 2, earlier, disputed });
    expect(r.issues).toEqual([]);
    expect(r.questions).toEqual([{ text: NEW, raisedBy: ['a'] }]);
    expect(r.pass).toBe(true);
  });
});

describe('mergeCouncil: scope across rounds (step 3.5)', () => {
  const earlier = [{ id: 'I1', description: REVENUE, where: ['fnd_1'] }];

  it('in round 1 a new substantive issue is upheld', () => {
    expect(merge([reviewed(A, 6, [issue(STALE)])]).issues.map((i) => i.standing)).toEqual(['upheld']);
  });

  it('from round 2 a substantive issue no member raised before is advisory; one raised before is upheld', () => {
    const r = merge([reviewed(A, 9, [issue(STALE, { id: 'I7', where: ['fnd_2'] }), issue(REVENUE, { id: 'I8' })])], { round: 2, earlier });
    expect(r.issues.map((i) => [i.id, i.description, i.standing])).toEqual([['I1', REVENUE, 'upheld'], ['I2', STALE, 'advisory']]);
    const onlyNew = merge([reviewed(A, 9, [issue(STALE, { id: 'I7' })])], { round: 3, earlier });
    expect(onlyNew.issues.map((i) => i.standing)).toEqual(['advisory']);
    expect(onlyNew.pass).toBe(true);
  });

  it('a new blocking issue still blocks in round 2', () => {
    const r = merge([reviewed(A, 9, [issue(STALE, { class: 'blocking' })])], { round: 2, earlier });
    expect(r.issues.map((i) => i.standing)).toEqual(['upheld']);
    expect(r.pass).toBe(false);
  });

  // Ruling on "raised in an earlier round": members are new runs each round, so the words alone are too weak.
  const STILL = 'Finding one still gives 12 million where the filing says 10';

  it('an issue that reuses the id of an earlier issue it was shown is that issue, in whatever words and about whatever output', () => {
    expect(issueSimilarityOf(STILL, REVENUE)).toBeLessThan(0.25);
    // The corrected finding was saved anew, so the output it is about has another id now.
    const r = merge([reviewed(A, 6, [issue(STILL, { where: ['fnd_9'] })])], { round: 2, earlier });
    expect(r.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'upheld']]);
    const cited = merge([reviewed(A, 6, [issue(STILL, { where: undefined, evidence: ['art_1'] })])], { round: 2, earlier });
    expect(cited.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'upheld']]);
  });

  it('the id of an earlier issue the members were not shown (an advisory one) is carried by chance: only words and outputs count', () => {
    const unlisted = [{ id: 'I1', description: REVENUE, where: ['fnd_1'], unlisted: true }];
    const byChance = merge([reviewed(A, 9, [issue(STILL, { where: ['fnd_9'] })])], { round: 2, earlier: unlisted });
    expect(byChance.issues.map((i) => [i.id, i.standing])).toEqual([['I2', 'advisory']]);
    const sameWords = merge([reviewed(A, 6, [issue(REVENUE, { id: 'I4' })])], { round: 2, earlier: unlisted });
    expect(sameWords.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'upheld']]);
  });

  it('without the id: the same output and loosely similar text is the earlier issue; the same output alone is not', () => {
    const loose = 'The revenue figure is still wrong against the filing';
    const sim = issueSimilarityOf(loose, REVENUE);
    expect(sim).toBeGreaterThanOrEqual(0.25);
    expect(sim).toBeLessThan(0.6);
    const r = merge([reviewed(A, 6, [issue(loose, { id: 'I9' })])], { round: 2, earlier });
    expect(r.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'upheld']]);
    const other = merge([reviewed(A, 9, [issue(STALE, { id: 'I9' })])], { round: 2, earlier });
    expect(other.issues.map((i) => [i.id, i.standing])).toEqual([['I2', 'advisory']]);
  });

  it('without the id: loosely similar text about another output, or about none, is a new issue; the same text alone is the earlier issue', () => {
    const loose = 'The revenue figure is still wrong against the filing';
    const elsewhere = merge([reviewed(A, 9, [issue(loose, { id: 'I9', where: ['fnd_8'] })])], { round: 2, earlier });
    expect(elsewhere.issues.map((i) => [i.id, i.standing])).toEqual([['I2', 'advisory']]);
    const nowhere = merge([reviewed(A, 9, [issue(loose, { id: 'I9', where: undefined, evidence: ['art_1'] })])], { round: 2, earlier });
    expect(nowhere.issues.map((i) => [i.id, i.standing])).toEqual([['I2', 'advisory']]);
    const sameText = merge([reviewed(A, 6, [issue(REVENUE, { id: 'I9', where: ['fnd_8'] })])], { round: 2, earlier });
    expect(sameText.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'upheld']]);
  });
});

describe('mergeCouncil: blockOn (step 3.6)', () => {
  const one = [reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 9), reviewed(C, 9)];
  const two = [reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(REVENUE)]), reviewed(C, 9)];
  const three = [reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(REVENUE)]), reviewed(C, 6, [issue(REVENUE)])];
  const standing = (reviews: MemberReview[], blockOn: CouncilStage['blockOn']) => merge(reviews, { stage: { blockOn } }).issues.map((i) => i.standing);

  it('any: one blocking member upholds', () => {
    expect(standing(one, 'any')).toEqual(['upheld']);
  });

  it('majority: more than half of the blocking members with a score', () => {
    expect(standing(one, 'majority')).toEqual(['advisory']);
    expect(standing(two, 'majority')).toEqual(['upheld']);
    // Exactly half is not a majority.
    expect(standing([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 9)], 'majority')).toEqual(['advisory']);
    // Members without a score are not in the count: 1 of the 1 that scored.
    expect(standing([reviewed(A, 6, [issue(REVENUE)]), absent(B, 'unavailable', 'provider off'), absent(C, 'no_score')], 'majority')).toEqual(['upheld']);
  });

  it('all: every blocking member with a score', () => {
    expect(standing(two, 'all')).toEqual(['advisory']);
    expect(standing(three, 'all')).toEqual(['upheld']);
    expect(standing([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(REVENUE)]), absent(C, 'unavailable')], 'all')).toEqual(['upheld']);
  });

  it('upheld issues come first', () => {
    const r = merge([reviewed(A, 6, [issue(STALE, { where: ['fnd_2'] }), issue(REVENUE)]), reviewed(B, 6, [issue(REVENUE)]), reviewed(C, 9)], {
      stage: { blockOn: 'majority' },
    });
    expect(r.issues.map((i) => [i.description, i.standing])).toEqual([[REVENUE, 'upheld'], [STALE, 'advisory']]);
  });
});

describe('mergeCouncil: non-blocking members', () => {
  it("a non-blocking member's issue is shown as advisory and its score is never counted", () => {
    const r = merge([reviewed(A, 9), reviewed(N, 2, [issue(REVENUE, { class: 'blocking', evidence: ['art_1'] })])]);
    expect(r.issues.map((i) => [i.raisedBy, i.standing])).toEqual([[['n'], 'advisory']]);
    expect(r).toMatchObject({ pass: true, score: 9 });
    expect(r.members[1]).toEqual({ name: 'n', provider: 'claude', model: 'opus', lens: 'rewrite', blocking: false, state: 'reviewed', score: 2 });
  });

  it('it is named on an issue a blocking member raised too, without adding to the count', () => {
    const r = merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 9), reviewed(C, 9), reviewed(N, 2, [issue(REVENUE)])], { stage: { blockOn: 'majority' } });
    expect(r.issues.map((i) => [i.raisedBy, i.standing])).toEqual([[['a', 'n'], 'advisory']]);
  });

  it('one that was not waited for leaves the round as it is', () => {
    const r = merge([reviewed(A, 9.5), absent(N, 'not_waited')]);
    expect(r).toMatchObject({ pass: true, score: 9.5 });
    expect(r.members[1]).toEqual({ name: 'n', provider: 'claude', model: 'opus', lens: 'rewrite', blocking: false, state: 'not_waited' });
  });
});

describe('mergeCouncil: a non-blocking member never decides a round (council review C1)', () => {
  const earlier = [{ id: 'I1', description: REVENUE, where: ['fnd_1'] }];
  const NEW = 'The reason given does not hold: page 3 of the filing says 10 million';
  /** The round with and without its non-blocking members: the standing of every issue must be the same. */
  const both = (blocking: MemberReview[], others: MemberReview[], over: Parameters<typeof merge>[1] = {}) => ({
    alone: merge(blocking, over),
    together: merge([...blocking, ...others], over),
  });

  it('round 2: a new substantive issue stays advice when a non-blocking member classes the same defect `blocking`', () => {
    const { alone, together } = both([reviewed(A, 9, [issue(STALE, { id: 'I7' })])], [reviewed(N, 2, [issue(STALE, { id: 'I8', class: 'blocking' })])], { round: 2, earlier });
    expect(alone).toMatchObject({ pass: true, score: 9 });
    expect(together).toMatchObject({ pass: true, score: 9 });
    expect(together.issues.map((i) => [i.class, i.raisedBy, i.standing])).toEqual([['substantive', ['a', 'n'], 'advisory']]);
  });

  it("a blocking member's issue with neither an output nor evidence stays its question when a non-blocking member cites evidence for the same defect", () => {
    const { alone, together } = both(
      [reviewed(A, 5, [issue(REVENUE, { where: undefined })])],
      [reviewed(N, 2, [issue(REVENUE, { where: undefined, evidence: ['art_1'] })])],
    );
    expect(alone).toMatchObject({ pass: true, score: 9, issues: [] });
    expect(together).toMatchObject({ pass: true, score: 9 });
    expect(together.issues.map((i) => [i.raisedBy, i.evidence, i.standing])).toEqual([[['n'], ['art_1'], 'advisory']]);
    expect(together.questions).toEqual([{ text: REVENUE, raisedBy: ['a'] }]);
    expect(together.members[0]).toMatchObject({ score: 5, countedScore: 9, unsupportedScore: true });
  });

  it("a blocking member's mere repeat of a disputed issue does not block because a non-blocking member says something new under it", () => {
    const { alone, together } = both([reviewed(A, 6, [issue(REVENUE)])], [reviewed(N, 2, [issue(NEW)])], { round: 2, earlier, disputed: new Set(['I1']) });
    expect(alone).toMatchObject({ pass: true, score: 9 });
    expect(together).toMatchObject({ pass: true, score: 9 });
    expect(together.issues.map((i) => [i.id, i.raisedBy, i.standing])).toEqual([['I1', ['a', 'n'], 'advisory']]);
  });

  it("round 2: a blocking member's new issue is not an earlier one because a non-blocking member files the same defect under a listed earlier id", () => {
    const { alone, together } = both([reviewed(A, 6, [issue(STALE, { id: 'I7' })])], [reviewed(N, 2, [issue(STALE)])], { round: 2, earlier });
    expect(alone).toMatchObject({ pass: true, score: 9 });
    expect(together).toMatchObject({ pass: true, score: 9 });
    expect(together.issues.map((i) => [i.id, i.raisedBy, i.standing])).toEqual([['I2', ['a', 'n'], 'advisory']]);
  });

  it('the outputs an upheld rewrite discards are those its blocking members named: a non-blocking member cannot widen it over another upheld issue', () => {
    const rewrite = issue('Discard the finding and rebuild it from the annual report', { action: 'rewrite', class: 'blocking' });
    const { alone, together } = both(
      [reviewed(A, 5, [rewrite]), reviewed(B, 6, [issue(STALE, { where: ['fnd_2'] })])],
      [reviewed(N, 2, [{ ...rewrite, where: ['fnd_1', 'fnd_2'] }])],
    );
    const upheld = (r: typeof alone) => r.issues.filter((i) => i.standing === 'upheld').map((i) => [i.description, i.where, i.raisedBy.filter((name) => name !== 'n')]);
    expect(upheld(alone)).toEqual([[rewrite.description, ['fnd_1'], ['a']], [STALE, ['fnd_2'], ['b']]]);
    expect(upheld(together)).toEqual(upheld(alone));
    expect(together.dropped).toEqual([]);
    expect(together.issues[0]!.raisedBy).toEqual(['a', 'n']);
  });

  it('what a non-blocking member adds is attached: its name, its evidence and its words, with the standing as it was', () => {
    const own = 'Page 3 of the annual report gives 10 million, not 12';
    const { alone, together } = both([reviewed(A, 6, [issue(REVENUE, { evidence: ['art_1'] })])], [reviewed(N, 2, [issue(own, { id: 'I4', evidence: ['art_2'] })])], {
      round: 2, earlier,
    });
    expect(alone.issues).toEqual([{ id: 'I1', class: 'substantive', description: REVENUE, where: ['fnd_1'], evidence: ['art_1'], raisedBy: ['a'], standing: 'upheld' }]);
    // N says "I1" by the id only here: the words are not alike.
    const byId = merge([reviewed(A, 6, [issue(REVENUE, { evidence: ['art_1'] })]), reviewed(N, 2, [issue(own, { evidence: ['art_2'] })])], { round: 2, earlier });
    expect(byId.issues).toEqual([
      {
        id: 'I1', class: 'substantive', description: `${REVENUE}\nAlso raised by n: ${own}`, wordings: [REVENUE, own], where: ['fnd_1'], evidence: ['art_1', 'art_2'],
        raisedBy: ['a', 'n'], standing: 'upheld',
      },
    ]);
    // Under another id and in other words it is a separate issue, and only advice.
    expect(together.issues.map((i) => [i.raisedBy, i.standing])).toEqual([[['a'], 'upheld'], [['n'], 'advisory']]);
  });

  /** Small seeded generator (mulberry32), so a failure can be replayed. */
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('property: removing every non-blocking member never changes pass, the score, the counted scores or which issues are upheld', () => {
    const N2 = member('n2', { lens: 'value', blocking: false });
    // Few texts, outputs and ids, so that issues of different members meet: the same defect, a paraphrase
    // of it (alike at the looser measure only), a reassertion in new words, and unrelated ones.
    const texts = [REVENUE, `${REVENUE} still`, 'The revenue figure is still wrong against the filing', NEW, STALE, CAUSE, 'Discard the finding and rebuild it from the annual report'];
    const earlierPool = [
      { id: 'I1', description: REVENUE, where: ['fnd_1'] },
      { id: 'I2', description: STALE, where: ['fnd_2'] },
      { id: 'I3', description: CAUSE, unlisted: true },
    ];
    const blockingNames = new Set(['a', 'b', 'c']);
    /** What the round decided: everything a non-blocking member must not be able to change. */
    const decided = (r: ReturnType<typeof merge>) => ({
      pass: r.pass,
      score: r.score,
      upheld: r.issues
        .filter((i) => i.standing === 'upheld')
        .map((i) => ({ id: i.id, class: i.class, action: i.action ?? 'fix', where: i.where ?? [], lead: i.description.split('\nAlso raised by ')[0], raisedBy: i.raisedBy.filter((name) => blockingNames.has(name)) })),
      replaced: r.dropped
        .filter((d) => d.rule === 'rewrite' && d.raisedBy.some((name) => blockingNames.has(name)))
        .map((d) => ({ id: d.issue.id, replacedBy: d.replacedBy, raisedBy: d.raisedBy.filter((name) => blockingNames.has(name)) })),
      members: r.members.filter((m) => m.blocking).map((m) => [m.name, m.state, m.score, m.countedScore, m.unsupportedScore]),
    });
    let withOthers = 0;
    let failing = 0;
    let shared = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
      const issuesOf = (): CouncilIssueIn[] =>
        texts
          .filter(() => next() < 0.35)
          .map((description, i): CouncilIssueIn => {
            const out: CouncilIssueIn = { id: next() < 0.4 ? pick(['I1', 'I2', 'I3']) : `I${7 + i}`, class: pick(['blocking', 'substantive', 'substantive', 'nit', 'scope_expansion'] as const), description };
            if (next() < 0.7) out.where = next() < 0.2 ? ['fnd_1', 'fnd_2'] : [pick(['fnd_1', 'fnd_2'])];
            if (next() < 0.4) out.evidence = [pick(['art_1', 'art_2'])];
            if (next() < 0.25) out.action = pick(['delete', 'rewrite'] as const);
            return out;
          });
      const seat = (m: CouncilMember, k: number): MemberReview =>
        k > 0 && next() < 0.15
          ? absent(m, pick(m.blocking ? (['unavailable', 'no_score'] as const) : (['unavailable', 'no_score', 'not_waited'] as const)))
          : reviewed(m, Math.round(next() * 100) / 10, issuesOf(), { questions: next() < 0.2 ? ['Is this audited?'] : [], followUps: [] });
      const blocking = [A, B, C].slice(0, 1 + Math.floor(next() * 3)).map(seat);
      const others = [N, N2].slice(0, 1 + Math.floor(next() * 2)).map((m) => seat(m, 0));
      // Seated in any order: a non-blocking member may come before the blocking ones.
      const seats = next() < 0.5 ? [...blocking, ...others] : next() < 0.5 ? [...others, ...blocking] : [others[0]!, ...blocking, ...others.slice(1)];
      const over = {
        round: 1 + Math.floor(next() * 3),
        stage: { blockOn: pick(['any', 'majority', 'all'] as const), passScore: pick([7, 8, 9, 10]) },
        earlier: earlierPool.filter(() => next() < 0.7),
        disputed: new Set(next() < 0.5 ? ['I1'] : next() < 0.3 ? ['I1', 'I2'] : []),
      };
      const together = merge(seats, over);
      const alone = merge(seats.filter((r) => r.member.blocking), over);
      expect(decided(together), `seed ${seed}`).toEqual(decided(alone));
      // The others are on record all the same.
      expect(together.members.map((m) => m.name), `seed ${seed}`).toEqual(seats.map((r) => r.member.name));
      withOthers++;
      if (!alone.pass) failing++;
      if (together.issues.some((i) => i.raisedBy.some((name) => blockingNames.has(name)) && i.raisedBy.some((name) => !blockingNames.has(name)))) shared++;
    }
    // The generator does produce what the property is about: failing rounds, and issues raised by both kinds of member.
    expect(withOthers).toBe(3000);
    expect(failing).toBeGreaterThan(500);
    expect(shared).toBeGreaterThan(500);
  });
});

describe('mergeCouncil: evidence or nothing is checked per member, before issues are merged (council review C2)', () => {
  it('majority of three: an issue one member shows and another only asserts has one vote, so it is not upheld', () => {
    const r = merge(
      [reviewed(A, 6, [issue(REVENUE, { where: undefined, evidence: ['art_1'] })]), reviewed(B, 6, [issue(REVENUE, { where: undefined })]), reviewed(C, 9)],
      { stage: { blockOn: 'majority' } },
    );
    expect(r.issues).toEqual([{ id: 'I1', class: 'substantive', description: REVENUE, evidence: ['art_1'], raisedBy: ['a'], standing: 'advisory' }]);
    expect(r.questions).toEqual([{ text: REVENUE, raisedBy: ['b'] }]);
    expect(r).toMatchObject({ pass: true, score: 9 });
    for (const m of r.members.slice(0, 2)) expect(m).toMatchObject({ score: 6, countedScore: 9, unsupportedScore: true });
  });

  it('all: the member that shows nothing does not make the issue unanimous either; with its own evidence it does', () => {
    const shown = issue(REVENUE);
    const asserted = issue(REVENUE, { where: [] });
    expect(merge([reviewed(A, 6, [shown]), reviewed(B, 6, [asserted])], { stage: { blockOn: 'all' } }).issues.map((i) => [i.raisedBy, i.standing])).toEqual([[['a'], 'advisory']]);
    expect(merge([reviewed(A, 6, [shown]), reviewed(B, 6, [shown])], { stage: { blockOn: 'all' } }).issues.map((i) => [i.raisedBy, i.standing])).toEqual([[['a', 'b'], 'upheld']]);
  });
});

describe('mergeCouncil: a merged issue carries every member\'s wording (council review C6)', () => {
  // Two different points about one output, alike enough at the looser measure to be taken as one defect.
  const FIGURE = 'The revenue figure in the finding is 12 million but the filing says 10';
  const YEAR = 'The revenue figure in the finding is for 2023 but the brief asks for 2024';

  it('the lead text, then what each other member said in its own words', () => {
    const sim = issueSimilarityOf(FIGURE, YEAR);
    expect(sim).toBeGreaterThanOrEqual(0.25);
    expect(sim).toBeLessThan(0.6);
    const r = merge([reviewed(A, 6, [issue(FIGURE)]), reviewed(B, 6, [issue(YEAR, { evidence: ['art_1'] })]), reviewed(C, 6, [issue(`${FIGURE} million`)])]);
    expect(r.issues).toEqual([
      {
        id: 'I1', class: 'substantive', description: `${FIGURE}\nAlso raised by b: ${YEAR}`, wordings: [FIGURE, YEAR], where: ['fnd_1'], evidence: ['art_1'],
        raisedBy: ['a', 'b', 'c'], standing: 'upheld',
      },
    ]);
  });

  it('a near-repeat of a wording already there is left out; one member alone has no wordings', () => {
    expect(issueSimilarityOf(REVENUE, `${REVENUE} page`)).toBeGreaterThanOrEqual(0.9);
    const r = merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 6, [issue(`${REVENUE} page`)])]);
    expect(r.issues[0]).toMatchObject({ description: REVENUE, raisedBy: ['a', 'b'] });
    expect(r.issues[0]).not.toHaveProperty('wordings');
  });

  it('the lead is the wording of the most severe class', () => {
    const r = merge([reviewed(A, 6, [issue(FIGURE)]), reviewed(B, 6, [issue(YEAR, { class: 'blocking' })])]);
    expect(r.issues[0]).toMatchObject({ class: 'blocking', description: `${YEAR}\nAlso raised by a: ${FIGURE}`, wordings: [YEAR, FIGURE] });
  });

  it('an issue a rewrite replaced keeps every wording on record', () => {
    const rewrite = issue('Discard the finding and rebuild it from the annual report', { action: 'rewrite', class: 'blocking' });
    const r = merge([reviewed(A, 6, [issue(FIGURE)]), reviewed(B, 6, [issue(YEAR)]), reviewed(C, 4, [rewrite])]);
    expect(r.dropped).toMatchObject([{ issue: { description: `${FIGURE}\nAlso raised by b: ${YEAR}`, wordings: [FIGURE, YEAR] }, raisedBy: ['a', 'b'], rule: 'rewrite' }]);
  });

  it('in a later round each wording of the earlier issue is the earlier text: repeating one of them says nothing new, and is that issue', () => {
    const earlier = [{ id: 'I1', description: `${FIGURE}\nAlso raised by b: ${YEAR}`, wordings: [FIGURE, YEAR], where: ['fnd_1'] }];
    const disputed = new Set(['I1']);
    for (const text of [FIGURE, YEAR, earlier[0]!.description]) {
      const repeat = merge([reviewed(A, 6, [issue(text)])], { round: 2, earlier, disputed });
      expect(repeat.issues.map((i) => [i.id, i.standing]), text).toEqual([['I1', 'advisory']]);
      // Without its id and about no output: the words alone make it the earlier issue.
      const byWords = merge([reviewed(A, 6, [issue(text, { id: 'I9', where: undefined, evidence: ['art_1'] })])], { round: 2, earlier });
      expect(byWords.issues.map((i) => [i.id, i.standing]), text).toEqual([['I1', 'upheld']]);
    }
  });
});

describe('mergeCouncil: what a rewrite replaced keeps its standing (council review C4)', () => {
  it('an issue the council upheld and one it did not are both replaced, each recorded with the standing it had', () => {
    const rewrite = issue('Discard both findings and rebuild them from the annual report', { action: 'rewrite', where: ['fnd_1', 'fnd_2'], class: 'blocking' });
    const r = merge(
      [reviewed(A, 5, [rewrite, issue(REVENUE, { id: 'I2' })]), reviewed(B, 4, [rewrite, issue(REVENUE)]), reviewed(C, 6, [rewrite, issue(STALE, { id: 'I2', where: ['fnd_2'] })])],
      { stage: { blockOn: 'majority' } },
    );
    expect(r.issues.map((i) => [i.action, i.standing])).toEqual([['rewrite', 'upheld']]);
    expect(r.dropped.map((d) => [d.issue.description, d.raisedBy, d.rule, d.standing])).toEqual([
      [REVENUE, ['a', 'b'], 'rewrite', 'upheld'],
      [STALE, ['c'], 'rewrite', 'advisory'],
    ]);
    // Nits and scope issues have no standing: they were never for the worker.
    const nit = merge([reviewed(A, 9, [issue('The title is long', { class: 'nit' })])]);
    expect(nit.dropped[0]).not.toHaveProperty('standing');
  });
});

describe('mergeCouncil: rewrite (step 3.7)', () => {
  const rewrite = issue('Discard both findings and rebuild them from the annual report', { action: 'rewrite', where: ['fnd_1', 'fnd_2'], class: 'blocking' });

  it('an upheld rewrite replaces every other issue about the outputs it discards', () => {
    const r = merge([
      reviewed(A, 5, [issue(REVENUE), issue(STALE, { id: 'I2', where: ['fnd_2', 'fnd_3'] }), issue(CAUSE, { id: 'I3', where: undefined, evidence: ['art_1'] })]),
      reviewed(B, 4, [rewrite]),
    ]);
    // Kept: the issue that is also about fnd_3, and the one that names no output.
    expect(r.issues.map((i) => i.description)).toEqual([STALE, CAUSE, rewrite.description]);
    expect(r.issues.at(-1)).toMatchObject({ action: 'rewrite', where: ['fnd_1', 'fnd_2'], raisedBy: ['b'], standing: 'upheld' });
    // The member whose issue was replaced still had a reason for its score.
    expect(r.members[0]).toMatchObject({ score: 5, countedScore: 5 });
    expect(r.members[0]).not.toHaveProperty('unsupportedScore');
    // What the rewrite replaced is on record, with the rewrite's id.
    const rewriteId = r.issues.at(-1)!.id;
    expect(r.dropped).toEqual([{ issue: { id: 'I4', class: 'substantive', description: REVENUE, where: ['fnd_1'] }, raisedBy: ['a'], rule: 'rewrite', replacedBy: rewriteId, standing: 'upheld' }]);
    expect(new Set([...r.issues.map((i) => i.id), ...r.dropped.map((d) => d.issue.id)]).size).toBe(4);
  });

  it('a rewrite that is not upheld replaces nothing', () => {
    const r = merge([reviewed(A, 5, [issue(REVENUE)]), reviewed(N, 4, [rewrite])]);
    expect(r.issues.map((i) => [i.description, i.standing])).toEqual([[REVENUE, 'upheld'], [rewrite.description, 'advisory']]);
    expect(r.dropped).toEqual([]);
  });

  it('of two upheld rewrites of the same outputs, the first stands', () => {
    const other = issue('Throw the findings away and interview three customers instead', { action: 'rewrite', where: ['fnd_2', 'fnd_1'], class: 'blocking' });
    const r = merge([reviewed(A, 5, [rewrite]), reviewed(B, 4, [other])]);
    expect(r.issues.map((i) => i.raisedBy)).toEqual([['a']]);
    expect(r.dropped.map((d) => [d.raisedBy, d.rule, d.replacedBy])).toEqual([[['b'], 'rewrite', r.issues[0]!.id]]);
  });
});

describe('mergeCouncil: a wider rewrite replaces a rewrite (step 3.7)', () => {
  it('what the first rewrite replaced is recorded as replaced by the rewrite that stands', () => {
    const narrow = issue('Discard the finding and rebuild it from the annual report', { action: 'rewrite', where: ['fnd_1'], class: 'blocking' });
    const wide = issue('Throw both away: interview three customers instead', { action: 'rewrite', where: ['fnd_1', 'fnd_2'], class: 'blocking' });
    expect(issueSimilarityOf(narrow.description, wide.description)).toBeLessThan(0.25);
    // Raised in this order: the narrow rewrite takes the issue about fnd_1, then the wider one takes the narrow one.
    const r = merge([reviewed(A, 5, [narrow]), reviewed(B, 4, [wide]), reviewed(C, 6, [issue(REVENUE)])]);
    expect(r.issues.map((i) => [i.description, i.raisedBy, i.standing])).toEqual([[wide.description, ['b'], 'upheld']]);
    const standing = r.issues[0]!.id;
    expect(r.dropped.map((d) => [d.issue.description, d.raisedBy, d.rule, d.replacedBy])).toEqual([
      [narrow.description, ['a'], 'rewrite', standing],
      [REVENUE, ['c'], 'rewrite', standing],
    ]);
    // Every replaced issue points at an issue of the round, and each member still has a reason for its score.
    for (const d of r.dropped) expect(r.issues.map((i) => i.id)).toContain(d.replacedBy);
    for (const m of r.members) expect(m).not.toHaveProperty('unsupportedScore');
  });
});

describe('mergeCouncil: scores and pass (steps 4 and 5)', () => {
  it('passes when every counted score is at or above the pass score and no upheld issue stands; the score is the lowest counted', () => {
    const r = merge([reviewed(A, 9), reviewed(B, 10), reviewed(N, 1)]);
    expect(r).toMatchObject({ pass: true, score: 9, issues: [] });
    expect(r.members.map((m) => m.countedScore)).toEqual([9, 10, undefined]);
  });

  it('one blocking member below the pass score with a reason fails the round', () => {
    const r = merge([reviewed(A, 9.5), reviewed(B, 8, [issue(REVENUE)])]);
    expect(r).toMatchObject({ pass: false, score: 8 });
    expect(r.members[1]).toMatchObject({ score: 8, countedScore: 8 });
  });

  it('an upheld issue fails the round even when every score is at the pass score', () => {
    expect(merge([reviewed(A, 9, [issue(REVENUE)]), reviewed(B, 10)])).toMatchObject({ pass: false, score: 9 });
  });

  it('a score below the pass score with no blocking or substantive issue is unsupported: recorded and treated as the pass score', () => {
    const r = merge([reviewed(A, 2), reviewed(B, 9.5)], { stage: { passScore: 8 } });
    expect(r).toMatchObject({ pass: true, score: 8 });
    expect(r.members[0]).toMatchObject({ score: 2, countedScore: 8, unsupportedScore: true });
    expect(r.members[1]).toEqual({ name: 'b', provider: 'claude', model: 'opus', lens: 'reasoning', blocking: true, state: 'reviewed', score: 9.5, countedScore: 9.5 });
  });

  // Ruling: a round never fails with nothing the worker has to answer, so only an upheld issue backs a low score.
  it("a low score whose member's issues are all advisory is unsupported: `blockOn` alone decides which findings block", () => {
    const r = merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 9), reviewed(C, 9)], { stage: { blockOn: 'all' } });
    expect(r.issues.map((i) => i.standing)).toEqual(['advisory']);
    expect(r).toMatchObject({ pass: true, score: 9 });
    expect(r.members[0]).toMatchObject({ score: 6, countedScore: 9, unsupportedScore: true });
  });

  it('a low score backed only by a late issue (advisory from round 2) or by a dispute raised again without evidence is unsupported', () => {
    const earlier = [{ id: 'I1', description: REVENUE, where: ['fnd_1'] }];
    const late = merge([reviewed(A, 5, [issue(STALE, { id: 'I7', where: ['fnd_2'] })])], { round: 2, earlier });
    expect(late).toMatchObject({ pass: true, score: 9 });
    expect(late.members[0]).toMatchObject({ score: 5, countedScore: 9, unsupportedScore: true });
    const reasserted = merge([reviewed(A, 5, [issue(REVENUE)])], { round: 2, earlier, disputed: new Set(['I1']) });
    expect(reasserted.issues.map((i) => i.standing)).toEqual(['advisory']);
    expect(reasserted.members[0]).toMatchObject({ countedScore: 9, unsupportedScore: true });
    expect(reasserted.pass).toBe(true);
  });

  it('a low score backed by an upheld issue of the member stands', () => {
    const r = merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 9), reviewed(C, 9)], { stage: { blockOn: 'any' } });
    expect(r).toMatchObject({ pass: false, score: 6 });
    expect(r.members[0]).not.toHaveProperty('unsupportedScore');
  });

  it("another member's issue does not support a score", () => {
    const r = merge([reviewed(A, 6, [issue(REVENUE)]), reviewed(B, 3)]);
    expect(r.members[1]).toMatchObject({ score: 3, countedScore: 9, unsupportedScore: true });
    expect(r).toMatchObject({ pass: false, score: 6 });
  });

  it('members without a valid review have no score; with no counted score the round does not pass', () => {
    const r = merge([absent(A, 'unavailable', "provider 'codex' is not enabled"), absent(B, 'no_score', 'run failed'), reviewed(N, 10)]);
    expect(r).toMatchObject({ pass: false, score: 0, issues: [] });
    expect(r.members).toEqual([
      { name: 'a', provider: 'claude', model: 'opus', lens: 'evidence', blocking: true, state: 'unavailable', reason: "provider 'codex' is not enabled" },
      { name: 'b', provider: 'claude', model: 'opus', lens: 'reasoning', blocking: true, state: 'no_score', reason: 'run failed' },
      { name: 'n', provider: 'claude', model: 'opus', lens: 'rewrite', blocking: false, state: 'reviewed', score: 10 },
    ]);
  });
});

describe('mergeCouncil: fixed rules', () => {
  /** Small seeded generator (mulberry32), so a failure can be replayed. */
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('reviews made only of nits, scope issues, questions and follow-ups never make pass false', () => {
    const texts = [REVENUE, STALE, CAUSE, 'The title is long', 'Add the Asian market', 'Is this audited?', 'Reorder the sections'];
    for (let seed = 1; seed <= 300; seed++) {
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
      const some = (): string[] => texts.filter(() => next() < 0.3);
      const reviews: MemberReview[] = [A, B, C, N].slice(0, 1 + Math.floor(next() * 4)).map((m, k) => {
        if (k > 0 && next() < 0.2) return absent(m, pick(['unavailable', 'no_score', 'not_waited'] as const));
        const issues = some().map((description, i): CouncilIssueIn => {
          const kind = pick(['nit', 'scope_expansion', 'question'] as const);
          // A blocking or substantive issue with neither where nor evidence is a question by rule 7.
          if (kind === 'question') return { id: `I${i + 1}`, class: pick(['blocking', 'substantive'] as const), description };
          const out: CouncilIssueIn = { id: `I${i + 1}`, class: kind, description };
          if (next() < 0.5) out.where = [pick(['fnd_1', 'fnd_2'])];
          if (next() < 0.5) out.evidence = [pick(['art_1', 'art_2'])];
          if (next() < 0.3) out.action = pick(['fix', 'delete', 'rewrite'] as const);
          return out;
        });
        return reviewed(m, Math.round(next() * 100) / 10, issues, { questions: some(), followUps: some() });
      });
      const r = merge(reviews, {
        round: 1 + Math.floor(next() * 3),
        stage: { blockOn: pick(['any', 'majority', 'all'] as const), passScore: pick([7, 8, 9, 10]) },
        earlier: texts.filter(() => next() < 0.3).map((description, i) => ({ id: `I${i + 1}`, description })),
        disputed: new Set(next() < 0.5 ? ['I1'] : []),
      });
      expect(r.pass, `seed ${seed}`).toBe(true);
      expect(r.issues, `seed ${seed}`).toEqual([]);
    }
  });

  it('a round in which a blocking member reviewed never fails with nothing upheld, whatever the reviews', () => {
    const texts = [REVENUE, STALE, CAUSE, 'The title is long', 'Add the Asian market', 'Is this audited?', 'Reorder the sections'];
    let failed = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
      const some = (): string[] => texts.filter(() => next() < 0.3);
      const reviews: MemberReview[] = [A, B, C, N].slice(0, 1 + Math.floor(next() * 4)).map((m, k) => {
        if (k > 0 && next() < 0.2) return absent(m, pick(['unavailable', 'no_score', 'not_waited'] as const));
        const issues = some().map((description, i): CouncilIssueIn => {
          const out: CouncilIssueIn = { id: `I${i + 1}`, class: pick(['blocking', 'substantive', 'substantive', 'nit', 'scope_expansion'] as const), description };
          if (next() < 0.6) out.where = [pick(['fnd_1', 'fnd_2'])];
          if (next() < 0.4) out.evidence = [pick(['art_1', 'art_2'])];
          if (next() < 0.3) out.action = pick(['fix', 'delete', 'rewrite'] as const);
          return out;
        });
        return reviewed(m, Math.round(next() * 100) / 10, issues, { questions: some(), followUps: some() });
      });
      const passScore = pick([7, 8, 9, 10]);
      const r = merge(reviews, {
        round: 1 + Math.floor(next() * 3),
        stage: { blockOn: pick(['any', 'majority', 'all'] as const), passScore },
        earlier: texts.filter(() => next() < 0.3).map((description, i) => ({ id: `I${i + 1}`, description })),
        disputed: new Set(next() < 0.5 ? ['I1'] : []),
      });
      if (r.pass || !r.members.some((m) => m.countedScore !== undefined)) continue;
      failed++;
      expect(r.issues.some((i) => i.standing === 'upheld'), `seed ${seed}`).toBe(true);
      // Every score counted below the pass score belongs to a member behind an upheld issue (or one an upheld rewrite replaced).
      const behind = new Set([...r.issues.filter((i) => i.standing === 'upheld'), ...r.dropped.filter((d) => d.rule === 'rewrite')].flatMap((x) => x.raisedBy));
      for (const m of r.members) {
        if (m.countedScore !== undefined && m.countedScore < passScore) expect(behind.has(m.name), `seed ${seed} member ${m.name}`).toBe(true);
      }
    }
    expect(failed).toBeGreaterThan(50); // the generator does produce failing rounds
  });

  it('majority and all: a defect every blocking member raised (under the same earlier id, or on the same output in similar words) is upheld, whatever else is raised', () => {
    // Each pair is alike at the looser measure only (checked below), so only the shared output makes them one defect.
    const paraphrases = [
      'The revenue figure is still wrong against the filing',
      'The revenue figure still does not agree with the filing',
      'Revenue in the finding is not the figure the filing gives',
    ];
    for (const a of paraphrases) for (const b of paraphrases) expect(issueSimilarityOf(a, b)).toBeGreaterThanOrEqual(0.25);
    const ownWords = [
      'Finding one still gives 12 million where the filing says 10',
      'The corrected claim repeats the wrong total from the draft',
      'Nothing changed: page 3 of the annual report contradicts this number',
      REVENUE,
    ];
    const noise = [STALE, CAUSE, 'The title is long', 'Add the Asian market', 'Reorder the sections'];
    const earlier = [{ id: 'I1', description: REVENUE, where: ['fnd_1'] }];
    for (let seed = 1; seed <= 400; seed++) {
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
      const byId = next() < 0.5;
      const round = byId ? 2 + Math.floor(next() * 2) : 1 + Math.floor(next() * 3);
      const blockOn = pick(['majority', 'all'] as const);
      // The defect: relisted under the id members were shown, in any words and about any output; or raised
      // on the same output in similar words (from round 2 as `blocking`: a new substantive issue is advice).
      const defect = (): CouncilIssueIn =>
        byId
          ? { id: 'I1', class: pick(['blocking', 'substantive'] as const), description: pick(ownWords), ...(next() < 0.7 ? { where: [pick(['fnd_1', 'fnd_8', 'fnd_9'])] } : { evidence: ['art_1'] }) }
          : { id: `I${1 + Math.floor(next() * 3)}`, class: round === 1 ? pick(['blocking', 'substantive'] as const) : 'blocking', description: pick(paraphrases), where: next() < 0.5 ? ['fnd_1'] : ['fnd_1', 'fnd_2'] };
      // Other issues are about other outputs, under ids no earlier issue has.
      const others = (): CouncilIssueIn[] =>
        noise
          .filter(() => next() < 0.3)
          .map((description, i) => ({ id: `I${5 + i}`, class: pick(['blocking', 'substantive', 'nit', 'scope_expansion'] as const), description, where: [pick(['fnd_5', 'fnd_6'])] }));
      const blocking = [A, B, C].slice(0, 2 + Math.floor(next() * 2));
      const raisers: string[] = [];
      const reviews: MemberReview[] = blocking.map((m, k) => {
        if (k > 0 && next() < 0.15) return absent(m, pick(['unavailable', 'no_score'] as const));
        raisers.push(m.name);
        const before = others();
        return reviewed(m, Math.round(next() * 100) / 10, next() < 0.5 ? [...before, defect()] : [defect(), ...before]);
      });
      if (next() < 0.5) reviews.push(next() < 0.5 ? reviewed(N, 3, others()) : absent(N, 'not_waited'));
      const r = merge(reviews, { round, stage: { blockOn, passScore: pick([7, 8, 9, 10]) }, earlier: byId || next() < 0.5 ? earlier : [] });
      // The defect is one issue (never one per member), raised by every blocking member that reviewed, and upheld.
      const found = [...r.issues, ...r.dropped.map((d) => ({ ...d.issue, raisedBy: d.raisedBy, standing: 'dropped' }))].filter((i) =>
        byId ? i.id === 'I1' || ownWords.includes(i.description) : i.where?.includes('fnd_1'),
      );
      expect(found.map((i) => [i.standing, raisers.filter((name) => !i.raisedBy.includes(name))]), `seed ${seed}`).toEqual([['upheld', []]]);
      expect(r.pass, `seed ${seed}`).toBe(false);
    }
  });

  it('is deterministic and leaves its input untouched', () => {
    const freeze = <T>(v: T): T => {
      if (v && typeof v === 'object' && !(v instanceof Set)) Object.values(v).forEach(freeze);
      return Object.freeze(v);
    };
    const input = (): MergeInput =>
      freeze({
        stage: { rounds: 3, passScore: 9, blockOn: 'majority' as const, onUnavailable: 'fail' as const, members: [A, B, N] },
        round: 2,
        reviews: [
          reviewed(A, 6, [issue(REVENUE, { evidence: ['art_1'] }), issue(STALE, { id: 'I2', class: 'nit' })], { questions: ['Is this audited?'] }),
          reviewed(B, 7, [issue(REVENUE), issue(CAUSE, { id: 'I2', class: 'scope_expansion' })], { followUps: ['Check the Asian market'] }),
          reviewed(N, 3, [issue('Discard the finding and redo it from the filing', { action: 'rewrite' })]),
        ],
        earlier: [{ id: 'I1', description: REVENUE, where: ['fnd_1'] }],
        disputed: new Set(['I1']),
      });
    expect(mergeCouncil(input())).toEqual(mergeCouncil(input()));
  });
});
