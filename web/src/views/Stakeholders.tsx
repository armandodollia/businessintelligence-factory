import { usePersonaLearning, useStakeholders } from '../logic/hooks.js';
import { isOpenView, KEPT_OUT_NOTE } from '../logic/stakeholders.js';
import { Card } from './stakeholders/Card.js';
import { HiddenWhileOff, Questions } from './stakeholders/Questions.js';

/**
 * The Stakeholders page of a node (stakeholder personas design §15): the question round, then the
 * open own stakeholders as cards, then competitor stakeholders under their company. A hidden
 * stakeholder appears only in the question round (label, type, questions); while stakeholder personas
 * are off, only with "Show what the tool found".
 */
export function Stakeholders({ wsId }: { wsId: string }) {
  const learning = usePersonaLearning(wsId);
  const s = useStakeholders(wsId, () => void learning.reload());
  const setInclude = (personaId: string, include: boolean | null) => void s.setInclude(personaId, include);
  const enabled = s.view?.enabled !== false;
  // No question round while stakeholder personas are off (questions left from before wait until they are on again).
  const round = enabled && (s.groups.length > 0 || s.hidden.length > 0);
  // A competitor section only when it has an open stakeholder to show.
  const competitors = s.competitors.map((c) => ({ ...c, open: c.stakeholders.filter(isOpenView) })).filter((c) => c.open.length > 0);
  return (
    <div>
      <h2>Stakeholders</h2>
      <p className="muted">
        The people, teams and systems this part of the business depends on, as personas built from evidence and from what you
        tell the tool. Their reads of recommendations are <b>simulated</b>.
      </p>
      {round && s.hasHidden && <p className="small">{KEPT_OUT_NOTE}</p>}
      {!enabled && <p className="small muted">Stakeholder personas are off (config stakeholders.enabled).</p>}
      {s.error && <div className="error">{s.error}</div>}
      {s.actionError && <div className="error">{s.actionError}</div>}
      {learning.actionError && <div className="error">{learning.actionError}</div>}
      {learning.signalError && <div className="error">{learning.signalError}</div>}
      {s.loading && !s.view && <div className="muted">loading…</div>}
      {round && <Questions s={s} />}
      {!enabled && s.hidden.length > 0 && <HiddenWhileOff s={s} />}
      {s.view && !round && s.hidden.length === 0 && s.open.length === 0 && competitors.length === 0 && <p className="muted">No stakeholders yet — run research.</p>}
      {s.open.map((v) => (
        <Card key={v.id} wsId={wsId} v={v} learning={learning} saving={s.busy} setInclude={setInclude} />
      ))}
      {competitors.map((c) => (
        <section key={c.competitorId} aria-label={`stakeholders of ${c.name}`}>
          <h3>{c.name}</h3>
          {c.open.map((v) => (
            <Card key={v.id} wsId={wsId} v={v} learning={learning} saving={s.busy} setInclude={setInclude} />
          ))}
        </section>
      ))}
    </div>
  );
}
