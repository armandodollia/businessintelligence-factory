import { shortDate } from '../../logic/format.js';
import { useStakeholderPosition, useStakeholderStatements, type usePersonaLearning } from '../../logic/hooks.js';
import { formerLine, isFormerColleague, words } from '../../logic/stakeholders.js';
import type { OpenStakeholderView, StakeholderPlaces } from '../../logic/types.js';
import { Learning } from '../personas/Learning.js';
import { Position } from './Position.js';
import { Layers, ProfileTable } from './Profile.js';

/**
 * An open stakeholder (design §15): label, type, relation, review status, the "Use for reads and
 * learning" box while not verified, the profile fields with confidence and evidence, what the user has
 * told the tool (newest first) with "Add a note", and the "What the tool has learned" block. Every
 * text is rendered as text.
 *
 * Positions (positions design §10): the position line with its change form; a former colleague says so
 * with the day it left, and shows three profiles: "Combined" (each field with what it rests on), "What
 * we knew" and "What is public".
 */
export function Card({
  wsId,
  v,
  learning,
  saving,
  setInclude,
  places,
  onChanged,
  atCompetitorId,
}: {
  wsId: string;
  v: OpenStakeholderView;
  learning: ReturnType<typeof usePersonaLearning>;
  saving: boolean;
  setInclude: (personaId: string, include: boolean | null) => void;
  /** The competitors and nodes of the tree a person can go to. */
  places: StakeholderPlaces;
  /** Called after a position change was saved: the page loads its lists again. */
  onChanged: () => Promise<void> | void;
  /** The competitor whose group the card is in: where a former colleague is now. */
  atCompetitorId?: string;
}) {
  const position = useStakeholderPosition(wsId, v, places, onChanged, atCompetitorId);
  const former = isFormerColleague(v);
  return (
    <section className="card" aria-label={`stakeholder ${v.label}`}>
      <div>
        <b>{v.label}</b> <span className="tag">{v.stakeholderType}</span>
        <span className="tag simulated">simulated</span>
        <span className={`status ${v.status}`}>{v.status}</span>
        <span className="muted"> v{v.version}</span>
      </div>
      {former && <p className="small">{formerLine(v)}</p>}
      {/* A former colleague's relation is its title at the new company: said once, in the position line. */}
      {v.relation && v.relation !== v.positionTitle && <p>{v.relation}</p>}
      <Position v={v} p={position} places={places} />
      {v.status !== 'verified' && (
        <div className="small">
          <label className="muted">
            <input
              type="checkbox"
              aria-label={`use ${v.id} for reads and learning`}
              checked={v.includeOverride ?? false}
              disabled={saving || v.status === 'superseded'}
              onChange={(e) => setInclude(v.id, e.currentTarget.checked)}
            />{' '}
            Use for reads and learning{v.includeOverride !== undefined ? ' (your override)' : ' (excluded: not verified)'}
          </label>{' '}
          {v.includeOverride !== undefined && (
            <button type="button" className="link" disabled={saving} onClick={() => setInclude(v.id, null)}>
              reset to default
            </button>
          )}
        </div>
      )}
      {former ? (
        <>
          <section aria-label={`combined profile of ${v.id}`}>
            <h4>Combined</h4>
            <ProfileTable profile={v.profile} basis />
          </section>
          <Layers v={v} p={position} />
        </>
      ) : (
        <ProfileTable profile={v.profile} />
      )}
      <Statements wsId={wsId} personaId={v.id} />
      <Learning personaId={v.id} l={learning} />
    </section>
  );
}

/** "What you have told the tool": the user's statements about the stakeholder, newest first, and "Add a note". */
function Statements({ wsId, personaId }: { wsId: string; personaId: string }) {
  const st = useStakeholderStatements(wsId, personaId);
  return (
    <section aria-label={`what you have told the tool about ${personaId}`}>
      <h4>What you have told the tool</h4>
      {st.error && <div className="error">{st.error}</div>}
      {st.actionError && <div className="error">{st.actionError}</div>}
      {!st.loading && st.statements.length === 0 && <p className="small muted">Nothing yet.</p>}
      {st.statements.length > 0 && (
        <ul className="small">
          {st.statements.map((s) => (
            <li key={s.id}>
              {s.text}
              <span className="muted">
                {' '}
                ({words(s.source)}
                {s.decision ? `: ${words(s.decision)}` : ''}, {shortDate(s.createdAt)})
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <textarea aria-label={`note about ${personaId}`} maxLength={4000} placeholder="Add a note" value={st.note} onChange={(e) => st.setNote(e.target.value)} />
        <button type="button" disabled={st.busy || !st.canAdd} onClick={() => void st.addNote()}>
          Add a note
        </button>
      </div>
    </section>
  );
}
