import { Fragment } from 'react';
import type { AboutOthersFlag, PanelBaseline, PersonaFeedback, RecommendationPanel, RecommendationView } from '../../logic/types.js';
import { CriteriaRatings } from '../CriterionRating.js';

/**
 * The persona panel of one recommendation on the Strategy page (persona panel design 2026-11-16 §8).
 * Everything here is simulated: reactions of simulated people, side by side, never merged into one.
 *
 * With no `panel` served (no `personaPanel` block, nothing stored of rounds or a baseline), the persona
 * feedback is shown as it was before the panel had seats and rounds. With one: where the personas
 * disagree as a range (never an average), each persona's reaction with its round, seat, grounded and
 * ungrounded concerns, the other side, another route, what it is unsure about, its rulings and its
 * earlier rounds, the personas that were unavailable or have used up their rounds, and the baseline.
 */
export function PersonaPanel({ wsId, rec }: { wsId: string; rec: RecommendationView }) {
  const { panel } = rec;
  const reactions = (
    <>
      {rec.personaFeedback.length === 0 && <span className="muted">no persona feedback</span>}
      {rec.personaFeedback.map((pf) => (
        <PersonaFeedbackCell key={pf.personaId} wsId={wsId} recId={rec.id} feedback={pf} panel={panel} />
      ))}
    </>
  );
  if (!panel) return reactions;
  const reacted = new Set(rec.personaFeedback.map((f) => f.personaId));
  return (
    <section aria-label={`persona panel of ${rec.id}`}>
      <Spread panel={panel} />
      {reactions}
      {panel.unavailable
        .filter((u) => !reacted.has(u.personaId))
        .map((u) => (
          <div key={u.personaId} className="feedback">
            <div>
              <b>{u.personaId}</b>
            </div>
            <Unavailable {...u} />
          </div>
        ))}
      <Baseline panel={panel} />
    </section>
  );
}

/** Where the personas disagree: the range of their scores per scale, marked simulated like the scores it is made of. Never an average. */
function Spread({ panel }: { panel: RecommendationPanel }) {
  if (panel.disagreement.length === 0 && panel.leftOut === 0) return null;
  return (
    <div className="small">
      {panel.disagreement.length > 0 && (
        <div>
          <span className="tag">simulated</span> <b>Where they disagree</b>
          {`: ${panel.disagreement.map((d) => `${d.scale} ${d.min} to ${d.max}`).join('; ')}`}
        </div>
      )}
      {panel.leftOut > 0 && (
        <div className="muted">
          {panel.leftOut === 1
            ? '1 reaction is not counted here: it adds nothing beyond a general reader.'
            : `${panel.leftOut} reactions are not counted here: they add nothing beyond a general reader.`}
        </div>
      )}
    </div>
  );
}

type Seat = NonNullable<PersonaFeedback['seat']>;
const seatText = (seat: Seat) => `${seat.provider} ${seat.model}${seat.effort ? ` (effort ${seat.effort})` : ''}`;

/** A read that could not be had: the seat could not be started, or its run gave no answer. No other model takes its place. */
function Unavailable({ round, seat, reason }: { round: number; seat: Seat; reason: string }) {
  return <div className="small">{`Unavailable (round ${round}): ${reason}. Runs on ${seatText(seat)}; no other model was tried.`}</div>;
}

function LimitReached({ round }: { round: number }) {
  return <div className="small">{`Round limit reached: it has not read the text as it is now (its last read was round ${round}).`}</div>;
}

/** Which read a reaction is and where it ran. Nothing for a reaction stored before the panel had rounds and seats. */
function ReadOf({ reaction }: { reaction: PanelBaseline }) {
  return (
    <>
      {reaction.round !== undefined && (
        <>
          {' '}
          <span className="tag">{`Round ${reaction.round}`}</span>
        </>
      )}
      {reaction.seat && (
        <>
          {' '}
          <span className="small muted">{`Runs on ${seatText(reaction.seat)}`}</span>
        </>
      )}
    </>
  );
}

function PersonaFeedbackCell({ wsId, recId, feedback, panel }: { wsId: string; recId: string; feedback: PersonaFeedback; panel: RecommendationPanel | undefined }) {
  const unavailable = panel?.unavailable.find((u) => u.personaId === feedback.personaId);
  const limit = panel?.limitReached.find((l) => l.personaId === feedback.personaId);
  const earlier = panel?.earlierRounds.filter((e) => e.personaId === feedback.personaId) ?? [];
  return (
    <div className="feedback">
      <div>
        <span className="tag">simulated</span> <b>{feedback.personaId}</b>
        <ReadOf reaction={feedback} />
      </div>
      {feedback.sameAsBaseline === true && <div className="small muted">Adds nothing beyond a general reader</div>}
      {unavailable && <Unavailable {...unavailable} />}
      {limit && <LimitReached round={limit.round} />}
      <CriteriaRatings
        workspaceId={wsId}
        targetType="persona_feedback"
        targetId={`${recId}:${feedback.personaId}`}
        criteria={feedback.scores}
      />
      <ReactionBody reaction={feedback} noBasis="No basis in the profile" />
      {earlier.length > 0 && <EarlierRounds reads={earlier.map((e) => ({ ...e.reaction, round: e.round }))} noBasis="No basis in the profile" />}
    </div>
  );
}

/** Reads that are not rated (an earlier round, the baseline): the scores as text. */
function Scores({ scores }: { scores: PersonaFeedback['scores'] }) {
  return (
    <div className="small">
      {Object.entries(scores)
        .map(([scale, value]) => `${scale} ${value}`)
        .join(' · ')}
    </div>
  );
}

/** A read that is not the reader's current one, or not a persona's: marked simulated, with its round, seat and scores, and nothing to rate. */
function PlainRead({ reaction, noBasis }: { reaction: PanelBaseline; noBasis: string }) {
  return (
    <div className="feedback">
      <div>
        <span className="tag">simulated</span>
        <ReadOf reaction={reaction} />
      </div>
      <Scores scores={reaction.scores} />
      <ReactionBody reaction={reaction} noBasis={noBasis} />
    </div>
  );
}

function EarlierRounds({ reads, noBasis }: { reads: PanelBaseline[]; noBasis: string }) {
  return (
    <details>
      <summary>{`Earlier rounds (${reads.length})`}</summary>
      {reads.map((r, i) => (
        <PlainRead key={i} reaction={r} noBasis={noBasis} />
      ))}
    </details>
  );
}

/**
 * `text` with the passages flagged as claims about other people struck out, each followed by why it is
 * not counted. Nothing the reader wrote is removed. Without flags: the text as it is.
 */
function Flagged({ text, flags }: { text: string; flags: AboutOthersFlag[] }) {
  if (flags.length === 0) return <>{text}</>;
  const parts: Array<{ text: string; struck: boolean }> = [];
  let rest = text;
  for (const flag of flags) {
    const at = rest.indexOf(flag.text);
    if (at < 0) continue;
    if (at > 0) parts.push({ text: rest.slice(0, at), struck: false });
    parts.push({ text: flag.text, struck: true });
    rest = rest.slice(at + flag.text.length);
  }
  if (rest) parts.push({ text: rest, struck: false });
  return (
    <>
      {parts.map((p, i) => (p.struck ? <s key={i}>{p.text}</s> : <Fragment key={i}>{p.text}</Fragment>))}
      {flags.map((f, i) => (
        <span key={`why-${i}`} className="muted">{` About other people: not counted (${f.reason})`}</span>
      ))}
    </>
  );
}

/**
 * What a concern rests on, after the concern: its basis (a passage of it about other people struck out),
 * or `noBasis` for a concern raised without one. Nothing when no basis is recorded for it (`null` or
 * unset: it was raised before the panel asked for one).
 */
function Basis({ basis, flags, noBasis }: { basis: string | null | undefined; flags: AboutOthersFlag[]; noBasis: string }) {
  if (basis === null || basis === undefined) return null;
  return (
    <>
      {' '}
      <span className="muted">
        {basis ? (
          <>
            Rests on: <Flagged text={basis} flags={flags} />
          </>
        ) : (
          noBasis
        )}
      </span>
    </>
  );
}

const RULING_WORDS = { resolved: 'Resolved', stands: 'Still stands' } as const;

/**
 * What a reader said: its concerns (in a panel with seats, each with what it rests on, or `noBasis`),
 * the other side, another route, what it is unsure about, its rulings on its earlier concerns (each
 * earlier concern with the marks it was raised with: its basis or `noBasis`, and its flag), and its
 * reasoning on demand. Every text of it is shown with its passages about other people struck out. A
 * reaction stored before the panel had these shows its concerns and reasoning only.
 */
function ReactionBody({ reaction, noBasis }: { reaction: PanelBaseline; noBasis: string }) {
  const flags = (field: AboutOthersFlag['field'], index?: number) => (reaction.aboutOthers ?? []).filter((f) => f.field === field && f.index === index);
  const { concernBasis, earlierConcerns, earlierConcernBasis } = reaction;
  return (
    <>
      {reaction.concerns.length > 0 && (
        <ul className="small">
          {reaction.concerns.map((c, i) => (
            <li key={i}>
              <Flagged text={c} flags={flags('concerns', i)} />
              <Basis basis={concernBasis ? (concernBasis[i] ?? '') : undefined} flags={flags('concernBasis', i)} noBasis={noBasis} />
            </li>
          ))}
        </ul>
      )}
      {reaction.otherSide && (
        <p className="small">
          The other side: <Flagged text={reaction.otherSide} flags={flags('otherSide')} />
        </p>
      )}
      {reaction.instead && (
        <p className="small">
          Another route: <Flagged text={reaction.instead} flags={flags('instead')} />
        </p>
      )}
      {reaction.unsure && reaction.unsure.length > 0 && (
        <div className="small">
          Unsure:
          <ul>
            {reaction.unsure.map((u, i) => (
              <li key={i}>
                <Flagged text={u} flags={flags('unsure', i)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {earlierConcerns && earlierConcerns.length > 0 && (
        <div className="small">
          Rulings on its earlier concerns:
          <ul>
            {earlierConcerns.map((concern, i) => {
              const at = reaction.rulings?.findIndex((r) => r.concern === i + 1) ?? -1;
              const ruling = reaction.rulings?.[at];
              return (
                <li key={i}>
                  <Flagged text={concern} flags={flags('earlierConcerns', i)} />
                  <Basis basis={earlierConcernBasis?.[i]} flags={flags('earlierConcernBasis', i)} noBasis={noBasis} />{' '}
                  <span className="tag">{ruling ? RULING_WORDS[ruling.ruling] : 'No ruling'}</span>
                  {ruling?.reason?.trim() && (
                    <>
                      : <Flagged text={ruling.reason} flags={flags('rulings', at)} />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <details>
        <summary>reasoning</summary>
        <p className="small">
          <Flagged text={reaction.reasoning} flags={flags('reasoning')} />
        </p>
        <p className="small muted">
          Would change mind: <Flagged text={reaction.wouldChangeMind} flags={flags('wouldChangeMind')} />
        </p>
      </details>
    </>
  );
}

/**
 * The baseline, on demand: what a run with no persona said about the same text. It is no persona's
 * feedback, is never rated and is in no range above; a persona that says the same adds nothing beyond it.
 */
function Baseline({ panel }: { panel: RecommendationPanel }) {
  const { baseline, baselineUnavailable, baselineLimitReached } = panel;
  if (!baseline && !baselineUnavailable && !baselineLimitReached) return null;
  return (
    <details>
      <summary>General reader (no persona)</summary>
      <p className="small muted">The same text, read with no persona. A persona that says the same adds nothing beyond a general reader.</p>
      {baselineUnavailable && <Unavailable {...baselineUnavailable} />}
      {baseline && baselineLimitReached && <LimitReached round={baseline.reaction.round ?? 1} />}
      {baseline && !baseline.current && !baselineLimitReached && <div className="small">This is its reaction to an earlier text of the recommendation.</div>}
      {baseline && <PlainRead reaction={baseline.reaction} noBasis="No basis in the text" />}
      {baseline && baseline.earlier.length > 0 && <EarlierRounds reads={baseline.earlier} noBasis="No basis in the text" />}
    </details>
  );
}
