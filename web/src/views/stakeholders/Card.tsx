import { formatValue, shortDate } from '../../logic/format.js';
import { useStakeholderStatements, type usePersonaLearning } from '../../logic/hooks.js';
import { words } from '../../logic/stakeholders.js';
import type { OpenStakeholderView } from '../../logic/types.js';
import { EvidenceList } from '../EvidenceList.js';
import { Learning } from '../personas/Learning.js';

/**
 * An open stakeholder (design §15): label, type, relation, review status, the "Use for reads and
 * learning" box while not verified, the profile fields with confidence and evidence, what the user has
 * told the tool (newest first) with "Add a note", and the "What the tool has learned" block. Every
 * text is rendered as text.
 */
export function Card({
  wsId,
  v,
  learning,
  saving,
  setInclude,
}: {
  wsId: string;
  v: OpenStakeholderView;
  learning: ReturnType<typeof usePersonaLearning>;
  saving: boolean;
  setInclude: (personaId: string, include: boolean | null) => void;
}) {
  return (
    <section className="card" aria-label={`stakeholder ${v.label}`}>
      <div>
        <b>{v.label}</b> <span className="tag">{v.stakeholderType}</span>
        <span className="tag simulated">simulated</span>
        <span className={`status ${v.status}`}>{v.status}</span>
        <span className="muted"> v{v.version}</span>
      </div>
      {v.relation && <p>{v.relation}</p>}
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
      {Object.keys(v.profile).length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
              <th>Confidence</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(v.profile).map(([field, f]) => (
              <tr key={field}>
                <td>{words(field)}</td>
                <td>{f.value}</td>
                <td>{formatValue(f.confidence)}</td>
                <td>
                  <details>
                    <summary>{f.evidence.length}</summary>
                    <EvidenceList ids={f.evidence} />
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
