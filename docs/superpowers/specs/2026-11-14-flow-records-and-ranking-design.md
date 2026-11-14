# Flow records and flow ranking: design

Date: 2026-11-14. Status: approved by the user on 2026-11-14 (reviewed once by a builder check). Code state read: `main` at cb15e8f.

This is project 1 of 4. The other three are named in §13 and get their own designs.

## 1. Intent

BIF should document how every discovered flow works, for each competitor (or alternative, at
internal layers of the business tree) and for the user's own company, and rank flows of the same
type against each other, so the user sees where they stand and why.

Why: the user wants a wide, comparable picture of how companies handle the same job (signing up,
paying, inviting a colleague), grounded in what was observed and what real people say, with the
simulated personas helping on matters of taste. The user is not a designer and should not need to
be one to read the result.

## 2. What exists today (verified at cb15e8f)

- A flow is a free-text `flow` name and a `step` number on screenshot artifacts
  (`save_artifact`, `Artifact.flow` / `.step`). No flow record, no ordered step text.
- Task type `flow_walkthrough` (phase `deep_dives`) has no prompt of its own; the orchestrator
  writes each brief. `own_company_audit` applies the same task types to the own company.
- Knowledge store: entity kind `flow` and relation `has_flow` exist; the edge is created only when
  the saving agent passed an `entity`.
- Reviews: no review task, record, rating, sentiment or source type. Review content lands in
  generic findings.
- Personas (`roles.persona`, default claude sonnet) judge recommendations only
  (`market/panel.ts`, `submit_persona_feedback`), with no browser and no evidence in front of
  them. Their output is labelled `simulated` and "is never evidence".
- Ranking exists for recommendations only (`scoring/priority.ts`).
- Web only. The action policy stops walkthroughs at payment, phone, KYC and captcha.
- `feedback_events` records the user's actions; the weekly retro reads them.
- Scopes with internal audiences already treat "competitors" as "alternatives"
  (`INTERNAL_COMPETITOR_GOAL`).

## 3. Decisions (made by the user)

1. **Every discovered flow**, not a fixed list. Sign-up and sign-in were only the research example.
2. **Like with like.** Flows are ranked within a flow type, across companies.
3. **The user's own company is in the same ranking.**
4. **Checklist and head-to-head are combined.** A checklist decides what can be checked
   objectively. Head-to-head comparison decides the subjective rest.
5. **Order of authority:** the user's overrides always win. Below them the checklist and the
   personas are blended: the more of a flow type the checklist can settle, the more it counts;
   the more it is a matter of taste, the more the personas count. Personas also break near-ties.
   Personas never change a checklist answer.
6. **All against all.** Within a flow type, every flow is compared with every other flow.
7. **Broad first, then narrow.** A persona first judges all flows of a type in one sitting. Only
   the pairs that need it get an individual head-to-head.
8. **The user can give a reason with every approval or rejection.** Positive and negative
   reactions are both kept.
9. **Nothing learns here.** Persona learning happens only in the scheduled retro (project 2).
   This project records the signals.

## 4. Goals, non-goals, anti-goals

Goals
- A flow is a record: ordered steps, each with what was done, what was observed and a screenshot.
- Flows are grouped into shared flow types so like can be compared with like.
- Real reviews are collected as records tied to their evidence copy, and attached to the flow
  type and, where possible, the check they speak to.
- One ranking per flow type, where every position can be explained from checks, verdicts,
  reviews and overrides.
- Every user reaction (agree, disagree, override, each with an optional reason) is stored against
  the exact thing it reacts to, including the persona and persona version behind a verdict.
- Recurring runs update flows as living records (confirm, new version), like facts.

Non-goals (this project)
- Changing personas from feedback (project 2), stakeholder personas (project 3), a persona of the
  user (project 4), UX review agents, mobile apps, walking past the action policy's limits.
- A cross-type ranking ("is their checkout better than our sign-up").

Anti-goals
- A ranking that cannot say why a flow is where it is.
- Simulated opinion presented as evidence, or deciding something the checklist can check.
- Review text or step text from one business tree visible in another.
- A persona verdict changing because of user feedback outside a retro.

## 5. Constraints (unchanged)

Local-first, Node 25, TypeScript ESM, `src/core` imports nothing from api or web. One store per
business tree; no leaks across trees. Upload-derived text stays out of exports by default and the
flag is sticky. Every claim stays tied to its evidence copy. Third-party text is untrusted and is
served fenced. Reviewer agents get minimal slices. Read tools page through `knowledge/paging.ts`
and respect token budgets. CLI agents differ in context limits.

## 6. Approaches considered

- **A. Checklist with facts first.** A fixed list of checks per flow, scored by rules. Traceable
  and repeatable; blind to anything not on the list.
- **B. Personas score each flow.** Flexible and needs no checklist; simulated opinion would drive
  the ranking and scores drift between runs. Rejected: personas are an assist.
- **C. Head-to-head.** Two flows compared at a time, ranking from wins. Comparison is more
  reliable than scoring in isolation; cost grows with the number of pairs and "why third?" is
  harder to answer.

**Chosen: A and C together** (decisions 4–7). The checklist carries what is objective, the
head-to-heads carry what is not, and the personas are the head-to-head judges.

## 7. Concepts

- **Subject:** the company, competitor, alternative or product a flow belongs to (a knowledge
  store entity).
- **Flow type:** a shared name for a job users do (sign-up, sign-in, checkout, invite a teammate).
  One catalog per business tree. Statuses: `proposed`, `active`, `merged`.
- **Flow:** one subject's way of doing one flow type, as observed. A living record with versions.
- **Variant:** a subject can have several ways through one flow type (sign-up by email, by single
  sign-on; self-serve checkout, contact sales). Each is its own flow, identified by subject, flow
  type and a short variant name. One is the **primary** variant: the path the subject itself puts
  first (the default or most prominent option). (Design call.)
- **Step:** one screen or action in a flow.
- **Checklist:** a versioned list of checks. One general checklist applies to every flow; a flow
  type may have a specific checklist.
- **Check:** one question with a rule for scoring its answer. Either `objective` (counts in the
  checklist score) or `audience_dependent` (recorded as a fact and given to the personas; it does
  not count in the checklist score).
- **Review mention:** one piece of real public feedback, quoted from a stored copy of its source.
- **Verdict:** one persona's judgment of one pair of flows. Always simulated.
- **Override:** the user's ruling on a pair or a position. Always wins.

## 8. Documenting flows

### 8.1 Discovery and typing

For each subject in scope, a worker lists the flows it can find (navigation, pricing and help
pages, the product itself) and assigns each to a flow type from the catalog. When none fits, it
proposes a new flow type with a one-line definition. A proposed type does not take part in any
ranking until the user accepts it; the user can also merge it into an existing type.

The catalog starts with: sign-up, sign-in, account recovery, onboarding to first use, pricing and
plan choice, checkout, cancel or downgrade, invite a teammate, get support. More arrive by
proposal. Account recovery is its own flow type; the sign-in checklist does not cover it.

### 8.2 The flow record

A flow holds: subject, flow type, name, goal (what the user is trying to get done), entry point,
whether the goal was reached, and if not, the stop reason (payment, phone, KYC, captcha, approval
needed, error, not found). It also holds one unscored note, "anything else notable", for what the
checklists do not ask.

A step holds: its order, what was done, what was observed, the screenshot (an artifact, captioned
as today), the page address, what the step asked the user for (fields, permissions, commitments),
and any error met.

A flow is unique by subject, flow type and variant. The saving worker names the variant and says
which one is primary; a re-walk of the same variant confirms it or saves a new version, and a
different variant is a different flow, never a "new version". Variants are documented and shown
under their subject. What takes part in the ranking is decided in §10.

Flows go through the review loop like findings: the reviewer checks steps and check answers
against the screenshots. A flow has the same review `status` as other task outputs.

A partial flow (goal not reached) is kept and ranked on the steps walked, and is marked partial
wherever it is shown.

### 8.3 Versions

A re-walk of the same subject and flow type either confirms the current flow (steps and
observations unchanged) or saves a new version that replaces it. Sameness is decided on the
normalized step sequence (actions, what was asked, errors), not on screenshot bytes. "What
changed" reports new flows, new versions, and ranking moves.

`Artifact.flow` / `.step` stay filled on the screenshots, so existing views and
`scheduler/diff.ts` keep working.

### 8.4 Knowledge store

Each flow belongs to a `flow` entity linked from its subject with `has_flow`, created in the same
transaction as the flow. Flows, steps, checks and review mentions are readable through the
existing read tools (`search`, `expand`, `get_card`), paged and budgeted like everything else.
Step text and review quotes are third-party text: stored redacted and fence-stripped, served
fenced as untrusted.

A flow is upload-derived when any step cites an upload-derived artifact, or it was built from an
upload (for example an internal process document at a lower layer). The flag follows the existing
rules: sticky, propagated to checks, verdicts and ranking explanations that rest on it, excluded
from export by default.

## 9. Reviews

### 9.1 Collection

A review task collects public feedback per subject: app stores, review sites, forums, community
and support boards, social posts. For internal layers there are no public reviews; the same
record holds feedback the user provides (survey exports, ticket exports, notes), which is
upload-derived.

### 9.2 The review mention

One record per piece of feedback: subject, source type, source address, the stored copy
(artifact) and a quote verified against that copy's text (same rule as citations), the date, a
rating when the source gives one, a polarity (negative, neutral, positive), and its attribution:
flow type, and check when it clearly speaks to one. Attribution carries a confidence. A mention
that names no flow stays attached to the subject only and is not counted for any flow.

The same quote from the same source is stored once. Counts shown anywhere are counts of distinct
mentions.

### 9.3 How reviews are used

- **As evidence for checks a walkthrough cannot see** (does the reset email arrive, do sessions
  hold). Such a check is answered from reviews: `reported problem` when at least
  `minMentionsForCheck` distinct negative mentions speak to it, otherwise `no signal`. `No signal`
  neither helps nor hurts the score.
- **For a check both can answer:** the walkthrough's answer stands unless enough negative
  mentions contradict a pass. Then the answer is `disputed`, scores half, and shows both sides.
  One walkthrough is one observation; several independent complaints say it does not always go
  that way.
- **Which mentions count** toward a threshold: dated within `mentionWindowDays`, and attributed
  with at least `minAttributionConfidence`. Older, undated and low-confidence mentions are still
  shown, marked as not counted. (Design calls.)
- **As input to the personas** in head-to-heads, as a short digest per flow with the quotes
  behind it.
- **Shown beside every ranking position:** how many mentions, how many negative.

Research finding the builder should keep in mind: people complain publicly about sign-in problems
far more than about sign-up friction, which mostly shows as silent abandonment. Thin review
coverage of a flow type is normal and must read as "no signal", never as "no problems".

## 10. Ranking

A ranking is for one node of the business tree and one flow type. (Design call.)
- **Which flows:** the flows of that node's own subjects: its competitors or alternatives, and
  its own company or unit. Flows of ancestor or descendant nodes are not mixed in; they are
  different businesses or parts of one. They stay readable from the node under the usual scope
  rules.
- **Which personas judge:** that node's audience personas, internal and external alike.
- **What is kept per node:** verdicts (a persona belongs to a node), pair overrides and
  snapshots. A flow record itself belongs to its subject and is shared when two nodes have the
  same subject, so it is walked once.
- **Variants:** the primary variant of each subject takes part. Other variants are compared with
  the primary variants only when the user asks for it on that flow type.

Rankings use the current reviewed version of each flow. They are computed from stored records
when read, not written by an agent. A snapshot is stored at the end of each ranking round so
changes can be reported.

### 10.1 Checklists

- **General checklist (every flow):** steps to the goal, dead ends, errors and how they are
  explained, what is asked before any value is given, forced commitments (card, phone, contract,
  sales call), consent tricks and other deceptive patterns, whether the next step is clear,
  whether progress survives leaving and coming back.
- **Specific checklists** for well-defined flow types. The first four, built from published
  standards and research (NIST SP 800-63B, WCAG 2.2 accessible authentication, web.dev sign-in
  and sign-up guidance, GOV.UK account patterns, Baymard and NN/g findings): sign-up, sign-in,
  account recovery, checkout.
- **The general checklist and these four are in Appendix A** and are active from the first run:
  approving this design approves them. The user can edit them afterwards like any checklist.
  (Design call.) Weights start equal within a checklist.
- **New flow types:** an agent drafts a specific checklist with a source for each check. It is
  `proposed` until the user accepts it; until then the flow type is ranked on the general
  checklist and the head-to-heads only.
- Each check names its kind (yes/no, count, one of a list), its scoring rule, its weight, whether
  it is `objective` or `audience_dependent`, and whether a walkthrough, reviews or both can answer
  it. Every answer cites the steps or review mentions it rests on. A check that does not apply is
  `not applicable` and is left out of the score.
- A checklist also states its **coverage**: how much of judging this flow type the objective
  checks can settle, from 0 to 1. Suggested starting values: sign-in 0.7, sign-up 0.6, checkout
  0.6, general checklist alone 0.3. The user can change it when accepting a checklist.
- Checklists are versioned. A new version re-scores flows from their stored answers where the
  checks are unchanged, and marks the rest as needing a re-walk.

**Checklist score** of a flow: the weighted share of its applicable objective checks that pass,
0–100.

### 10.2 Head-to-heads (personas)

Judges: the audience personas of the node the ranking is for. Each persona judges as itself: "for
someone like me, which of these two gets the job done better, and why".

What a persona is given per flow: the goal, the steps (what was done, observed and asked), the
answers to the `audience_dependent` checks, the "anything else notable" note, and the review
digest. It is not given the checklist score or the other personas' verdicts.

**Stage 1, broad.** One run per persona per flow type. The persona reads all flows of the type,
in an order shuffled per persona, and returns a verdict for every pair: winner or tie, strength
(slight, clear, strong), confidence, and a reason of one or two sentences. If the flows of a type
do not fit one run's budget, they are split into overlapping groups so every pair is still judged
once.

**Stage 2, focused.** A pair gets an individual head-to-head (one run, one persona, two flows,
fuller detail) only when one of these holds:
- the persona's stage 1 confidence on the pair was low;
- personas split on the pair;
- the persona's own verdicts form a loop (A over B, B over C, C over A);
- the two flows are next to each other in the ranking and within the tie margin, or the pair
  decides a top-three position;
- the verdict strongly contradicts the checklist scores (this is where the blend lets personas
  overturn a factual lead, so it gets the closer look);
- the user disagreed with a verdict on that pair (it is re-judged in the next ranking round, with
  the same persona version; this is a second look, not learning).

A focused verdict replaces the broad one for that persona and pair. Focused runs per round are
capped (`maxFocusedComparisons`); the most rank-relevant pairs go first and the rest are listed
as not yet narrowed.

**Reuse.** A verdict is kept until either flow has a new version or the persona has a new
version. Recurring rounds only judge pairs that are new or stale.

**Persona score** of a flow: its strength-weighted win share across all pairs and personas, 0–100.
Personas count equally unless the node's audiences carry weights.

### 10.3 Combining (blend, decided by the user)

For a flow type with coverage `c`:

`rank score = c × checklist score + (1 − c) × persona score`

Flows are ordered by rank score.

- **Consequence the user accepted:** in a flow type with low coverage, a clear persona preference
  can place a flow above one with a better checklist score. In a flow type with high coverage the
  checklist lead holds. The explanation of a position always shows both scores and the coverage,
  so it is visible when the personas decided the order.
- **Tie-break:** two flows whose rank scores differ by less than the tie margin are ordered by
  their direct head-to-head (the personas' verdicts on that pair). If that is also even, they
  share the position.
- The personas never change a check's answer or the checklist score.
- A flow with no one to compare with (the only one of its type) has a checklist score, no persona
  score, and is shown as "no comparison".
- A ranking is also available per audience (one persona's verdicts in place of all).

### 10.4 The user's overrides

The user can rule on a pair ("this one is better") or correct a check's answer, each with an
optional reason. A pair ruling is a hard constraint: the ranking is the best order that respects
every ruling. A corrected check re-scores the flow. Overridden positions are marked and show the
user's reason. Overrides stay in force for a pair until one of its flows has a new version; then
the user is asked whether it still holds.

### 10.5 Explaining a position

Every position can be opened to show: the checklist score with each check, its answer and its
evidence; the head-to-head record with each persona's verdict and reason (labelled simulated, and
broad or focused); the review counts with the mentions; the overrides; and whether the flow is
partial.

## 11. The user's feedback (signals)

The user can react, with an optional free-text reason, to:
- a ranking position (agree, disagree);
- a persona's verdict (agree, disagree);
- a check's answer (correct it);
- a flow type or checklist proposal (accept, edit, reject, merge);
- a review mention's attribution (wrong flow or check).

Each reaction is a `feedback_events` row naming exactly what it reacts to. A reaction to a
verdict also records the persona, the persona version, the stage and both flow versions, so
project 2 can tell which version of a persona was right or wrong, and about what. Agreement is
stored the same way as disagreement.

Machine signals stored for project 2, with no learning attached here: a persona's broad verdict
versus its own focused verdict on the same pair; a persona's verdict versus the user's override;
a persona's loops; a persona's verdicts versus what reviews later say.

## 12. Surfaces

### 12.1 Agents

- Workers get tools to save a flow with its steps, save check answers, save review mentions (in
  batches), and propose a flow type or checklist. Saving a flow goes through the same
  duplicate handshake idea as facts: the tool says when a current flow exists for that subject
  and type, and the worker confirms it or saves a new version.
- Personas get one tool to submit their verdicts for a flow type (stage 1) or a pair (stage 2).
  They keep having no browser.
- The orchestrator's `deep_dives` phase plans three task types: discover and walk flows, collect
  reviews, and (a runner phase, like the panel) run the ranking round. `flow_walkthrough` gets a
  prompt of its own.
- Reviewers see a flow, its steps and its check answers as their slice.
- Usage, decisions and retrievals are logged through the existing learning-loop tables; persona
  runs for verdicts are ordinary `persona` runs in `agent_usage`.

### 12.2 The user

A Flows view per node: flow types down the side; for the chosen type, the ranking.

```
Sign-up                     Rank  Checklist  Personas     Reviews
1. Competitor B              84      88      wins 9/10    14 (3 neg)
2. Your company   [partial]  71      75      wins 6/10     9 (5 neg)
3. Competitor A              52      50      wins 2/10    22 (15 neg)
   open · compare two · agree / disagree + why · override
Waiting on you: 1 new flow type, 1 checklist to accept
```

Opening a flow shows the steps as a strip of screenshots with what was done and observed, then
the checks, the reviews and the verdicts. "Compare two" puts two flows side by side, step by step.

## 13. What this leaves for the next projects

- **Project 2, persona learning in the retro:** reads the signals of §11, changes personas only
  in the scheduled retro and only with enough data, and shows the user the assumptions and the
  proposed changes.
- **Project 3, stakeholder personas:** leaders, managers, investors and, at lower layers, the
  neighbouring and parent systems and teams whose approval or data the node depends on. Built in
  the background; a first question round that does not reveal what BIF assumed; later information
  from the user feeds the retro.
- **Project 4, a persona of the user**, built from how they use the tool.
- Later: UX review agents.

This project must not close doors on those: verdicts and feedback carry persona ids and versions;
"persona" is not assumed to mean "audience persona" in the verdict records.

## 14. Privacy, isolation, trust

- Flows, flow types, checklists, review mentions, verdicts and rankings belong to one business
  tree. Nothing is shared across trees, including the flow type catalog and accepted checklists.
- Node scope follows the knowledge store (§7.1 of its design): a node sees its own, its
  descendants' and its ancestors' records.
- A persona run that is shown upload-derived text is upload-exposed; its verdicts are excluded
  from export by default, by the existing per-task rule.
- Step text, review quotes and reasons that quote them are fenced as untrusted whenever an agent
  or persona is shown them. A review that says "ignore your instructions" is data.
- Review mentions about named private individuals are not collected; reviewer names and handles
  are not stored.

## 15. Configuration

A `flows` block, all fields defaulted: `tieMargin` (5 points), `minMentionsForCheck` (3),
`mentionWindowDays` (365), `minAttributionConfidence` (0.6), `maxFocusedComparisons` per round
(20), `lowConfidence` threshold for stage 2, `maxFlowsPerSitting` for stage 1, and the model for
verdict runs (default: `roles.persona`).

## 16. Testing (required)

- Isolation: two trees with the same competitor names and flow types; no read, ranking, catalog
  entry or count leaks.
- Flow lifecycle: save, confirm, new version, partial flow, review loop statuses.
- Checklists: scoring rules, not-applicable handling, proposed versus accepted, version change
  and re-score.
- Reviews: quote verification, duplicate mentions, attribution with and without a flow,
  thresholds, "no signal".
- Ranking: the combining rule at several coverages, the tie-break, the only-one-of-its-type case,
  per-audience ranking, overrides as hard constraints including conflicting overrides, stale
  overrides after a new flow version.
- Head-to-heads: every pair judged exactly once in stage 1 including the split-into-groups case,
  each stage 2 trigger, the cap, verdict reuse and staleness.
- Feedback: every reaction stored with its target, persona version and reason; agreement and
  disagreement both stored; nothing about a persona changes.
- Privacy: upload-derived flows and what rests on them stay out of the default export.
- Hostile content in step text and review quotes.
- End to end with the fake adapter: discover, walk, collect reviews, rank, react, re-run with one
  changed flow; "what changed" is correct and only stale pairs are re-judged.
- Real-CLI smoke: one worker saves a flow with steps and checks; one persona submits verdicts.

## 17. Left to the builder

Table and column names, the exact tool names and input shapes, how overlapping groups are formed
in stage 1, the exact formula that turns verdicts into the persona score, how the best order
under override constraints is found, cache and snapshot details, UI layout beyond §12.2, prompt
wording. Anything that changes a decision in §3, the order of authority, what personas are shown,
or a privacy rule in §14 comes back to the design thread.

## Appendix A. Built-in checklists

`Answered by`: W = walkthrough, R = reviews, B = both. `Kind`: O = objective (counts in the
checklist score), A = audience-dependent (recorded and given to the personas, not scored).
"Good" is the answer that passes.

### A.1 General (every flow)

| Check | Good | By | Kind |
|---|---|---|---|
| Goal reached without leaving the product for help | yes | W | O |
| Dead ends (a screen with no way forward) | none | W | O |
| Errors met name the problem and how to fix it | yes | W | O |
| Input survives an error (nothing typed is lost) | yes | W | O |
| Asked only for what the next step needs | yes | W | O |
| Deceptive patterns (pre-ticked consent, hidden decline, forced extras, disguised ads) | none | W | O |
| Each screen says what happens next | yes | W | O |
| Progress survives leaving and coming back | yes | B | O |
| Works by keyboard alone, with visible focus | yes | W | O |
| Works at phone width without sideways scrolling | yes | W | O |
| The flow fails or breaks for real users | no reports | R | O |
| Number of steps and fields to reach the goal | recorded | W | A |
| Commitment asked before any value (card, phone, contract, sales call) | recorded | W | A |
| Tone and amount of explanation | recorded | W | A |

### A.2 Sign-up

| Check | Good | By | Kind |
|---|---|---|---|
| Value can be seen or tried before an account is required | yes | W | O |
| Password rules shown before or while typing, not after a failed submit | yes | W | O |
| No forced character-type rules; long passwords and paste allowed | yes | W | O |
| Password can be shown while typing | yes | W | O |
| Fields are checked when left, with specific messages | yes | W | O |
| Email or phone verification does not block first use, or can be finished later | yes | W | O |
| Verification code or link arrives and works | no reports | B | O |
| Code entry accepts paste and autofill; resend offered | yes | W | O |
| Consents are separate and unticked | yes | W | O |
| No puzzle or text-copying test without an alternative | yes | W | O |
| Sign-up options offered (email, single sign-on, social, passkey) | recorded | W | A |
| Card, phone or sales call required to start | recorded | W | A |
| Profile questions asked before first use | recorded | W | A |

### A.3 Sign-in

| Check | Good | By | Kind |
|---|---|---|---|
| Sign-in is clearly separate from creating an account | yes | W | O |
| Password managers and paste work | yes | W | O |
| Password can be shown while typing | yes | W | O |
| A wrong sign-in says what to do next without revealing which part was wrong | yes | W | O |
| The method used last time is remembered or hinted | yes | W | O |
| A second factor, when asked, has a fallback | yes | W | O |
| No memory test (pick the 3rd and 5th characters) or text-copying puzzle without an alternative | yes | W | O |
| People can sign in reliably (codes arrive, no loops) | no reports | R | O |
| Sessions hold; people are not signed out unexpectedly | no reports | R | O |
| Lockout after failed attempts is recoverable without contacting support | yes | B | O |
| Sign-in options offered (password, single sign-on, passkey, magic link) | recorded | W | A |
| How often a second factor is asked for | recorded | B | A |
| Session length before re-sign-in | recorded | B | A |

### A.4 Account recovery

| Check | Good | By | Kind |
|---|---|---|---|
| Recovery can be started from the sign-in screen | yes | W | O |
| The response does not reveal whether an account exists | yes | W | O |
| The reset message arrives and its link or code works | no reports | B | O |
| A new password is set in one step, under the same rules as sign-up | yes | W | O |
| No security questions | yes | W | O |
| After reset, the user is signed in or sent straight to sign-in | yes | W | O |
| Recovery without access to the original email or phone | recorded | W | A |

### A.5 Checkout

| Check | Good | By | Kind |
|---|---|---|---|
| Purchase possible without creating an account, or the account is created after paying | yes | W | O |
| Full price, taxes and fees shown before payment details are asked | yes | W | O |
| Billing period and renewal terms stated before paying | yes | W | O |
| Nothing added to the order that the user did not choose | yes | W | O |
| Order can be reviewed and edited before paying | yes | W | O |
| Payment errors say what to fix and keep what was entered | yes | W | O |
| Charges match what was shown (no surprise charges) | no reports | R | O |
| Payment methods offered | recorded | W | A |
| Trial terms: card needed, length, what happens at the end | recorded | W | A |
| Upsells shown before paying | recorded | W | A |

Walkthroughs stop before paying (action policy), so checks that need a completed payment are
answered from reviews only.

