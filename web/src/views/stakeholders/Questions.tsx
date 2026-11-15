import type { ReactNode } from 'react';
import type { useStakeholders } from '../../logic/hooks.js';
import { QUESTIONS_INTRO, questionsHeading } from '../../logic/stakeholders.js';
import type { HiddenStakeholderView, StakeholderQuestion } from '../../logic/types.js';

type S = ReturnType<typeof useStakeholders>;

/**
 * The question round (design §8, §15). A hidden stakeholder shows only its label, its type and its
 * questions, with Skip and "Show what the tool found"; Skip all and Send answers act on the round.
 * Hidden stakeholders without open questions are listed with their label and type only.
 */
export function Questions({ s }: { s: S }) {
  const withQuestions = new Set(s.groups.flatMap((g) => (g.persona ? [g.persona.id] : [])));
  const waiting = s.hidden.filter((h) => !withQuestions.has(h.id));
  return (
    <section className="pending" aria-label="questions for you">
      <div className="row">
        <h3>{questionsHeading(s.groups)}</h3>
        <button type="button" disabled={s.busy} onClick={() => void s.skipAll()}>
          Skip all
        </button>
      </div>
      <p>{QUESTIONS_INTRO}</p>
      {s.groups.map((g) =>
        g.persona ? (
          <Stakeholder key={g.persona.id} s={s} persona={g.persona}>
            {g.questions.map((q) => (
              <Question key={q.id} q={q} s={s} />
            ))}
          </Stakeholder>
        ) : (
          <div key="node">
            {g.questions.map((q) => (
              <Question key={q.id} q={q} s={s} />
            ))}
          </div>
        ),
      )}
      {waiting.map((h) => (
        <Stakeholder key={h.id} s={s} persona={h} />
      ))}
      <div className="row">
        <button type="button" className="primary" disabled={s.busy || !s.canSend} onClick={() => void s.send()}>
          Send answers
        </button>
      </div>
    </section>
  );
}

/**
 * Hidden stakeholders while stakeholder personas are off (final review item 4): no question round, but
 * each hidden stakeholder is listed (label and type) with only "Show what the tool found", so none stays
 * hidden for good.
 */
export function HiddenWhileOff({ s }: { s: S }) {
  return (
    <section aria-label="hidden stakeholders">
      <p className="small muted">The tool found these stakeholders before the feature was turned off.</p>
      {s.hidden.map((h) => (
        <Stakeholder key={h.id} s={s} persona={h} revealOnly />
      ))}
    </section>
  );
}

function Stakeholder({
  s,
  persona,
  children,
  revealOnly = false,
}: {
  s: S;
  persona: Pick<HiddenStakeholderView, 'id' | 'label' | 'stakeholderType'>;
  children?: ReactNode;
  revealOnly?: boolean;
}) {
  return (
    <fieldset aria-label={persona.label}>
      <div className="row">
        <span>
          <b>{persona.label}</b> · <span className="tag">{persona.stakeholderType}</span>
        </span>
        {!revealOnly && (
          <button type="button" disabled={s.busy} onClick={() => void s.skip(persona.id)}>
            Skip
          </button>
        )}
        <button type="button" disabled={s.busy} onClick={() => void s.reveal(persona.id)}>
          Show what the tool found
        </button>
      </div>
      {children}
    </fieldset>
  );
}

function Question({ q, s }: { q: StakeholderQuestion; s: S }) {
  return (
    <div>
      <div>{q.text}</div>
      <textarea aria-label={q.text} maxLength={4000} value={s.draft(q.id)} onChange={(e) => s.setDraft(q.id, e.target.value)} />
    </div>
  );
}
