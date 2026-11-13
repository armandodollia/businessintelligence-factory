import { usePersonas } from '../logic/hooks.js';
import { CriterionRating } from './CriterionRating.js';
import { EvidenceList } from './EvidenceList.js';

export function Personas({ wsId }: { wsId: string }) {
  const { personas, loading, error } = usePersonas(wsId);
  return (
    <div>
      <h2>Audience & Personas</h2>
      <p className="muted">
        Personas are built from evidence; their feedback on recommendations is <b>simulated</b>.
      </p>
      {error && <div className="error">{error}</div>}
      {loading && <div className="muted">loading…</div>}
      {!loading && personas.length === 0 && <p className="muted">No personas yet — run research.</p>}
      {personas.map((p) => (
        <div key={p.id} className="card">
          <div>
            <b>{p.segment}</b> <span className="tag">{p.slug}</span>
            {p.audience && <span className="tag">{p.audience}</span>}
            <span className="muted"> v{p.version} · {p.agentMdPath}</span>
          </div>
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
        </div>
      ))}
    </div>
  );
}
