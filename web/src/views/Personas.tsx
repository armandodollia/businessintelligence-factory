import { usePersonaLearning, usePersonas } from '../logic/hooks.js';
import { CriterionRating } from './CriterionRating.js';
import { EvidenceList } from './EvidenceList.js';
import { LastReviewNote } from './LastReviewNote.js';
import { Learning } from './personas/Learning.js';

export function Personas({ wsId }: { wsId: string }) {
  const ps = usePersonas(wsId);
  const { personas, loading, error } = ps;
  const learning = usePersonaLearning(wsId);
  return (
    <div>
      <h2>Audience & Personas</h2>
      <p className="muted">
        Personas are built from evidence; their feedback on recommendations is <b>simulated</b>.
      </p>
      {error && <div className="error">{error}</div>}
      {ps.actionError && <div className="error">{ps.actionError}</div>}
      {learning.view && !learning.view.enabled && <p className="small muted">Persona learning is off (config personaLearning.enabled).</p>}
      {learning.actionError && <div className="error">{learning.actionError}</div>}
      {learning.signalError && <div className="error">{learning.signalError}</div>}
      {loading && <div className="muted">loading…</div>}
      {!loading && personas.length === 0 && <p className="muted">No personas yet — run research.</p>}
      {personas.map((p) => (
        <div key={p.id} className="card">
          <div>
            <b>{p.segment}</b> <span className="tag">{p.slug}</span>
            {p.audience && <span className="tag">{p.audience}</span>}
            {p.status && <span className={`status ${p.status}`}>{p.status}</span>}
            <span className="muted"> v{p.version} · {p.agentMdPath}</span>
          </div>
          {ps.needsReviewFlag(p) && p.lastReview && <LastReviewNote review={p.lastReview} />}
          <label className="muted small">
            <input
              type="checkbox"
              aria-label={`use ${p.id} in persona panel`}
              checked={ps.usedInPanel(p)}
              disabled={ps.saving || p.status === 'superseded'}
              onChange={(e) => void ps.setInclude(p.id, e.currentTarget.checked)}
            />{' '}
            Use in persona panel
            {p.includeOverride !== undefined ? ' (your override)' : p.status && p.status !== 'verified' ? ' (excluded: not verified)' : ''}
          </label>{' '}
          {p.includeOverride !== undefined && (
            <button className="link" disabled={ps.saving} onClick={() => void ps.setInclude(p.id, null)}>
              reset to default
            </button>
          )}
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                <th>Confidence (ratable)</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(p.profile).map(([field, f]) => (
                <tr key={field}>
                  <td>{field}</td>
                  <td>{f.value}</td>
                  <td>
                    <CriterionRating
                      workspaceId={wsId}
                      targetType="persona"
                      targetId={p.id}
                      criterion={field}
                      agentValue={f.confidence}
                    />
                  </td>
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
          <Learning personaId={p.id} l={learning} />
        </div>
      ))}
    </div>
  );
}
