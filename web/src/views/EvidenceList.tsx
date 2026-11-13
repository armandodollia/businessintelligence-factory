import { evidenceLabel, useEvidence } from '../logic/hooks.js';

/** Screenshots as ordered thumbnails per flow; archived pages / documents as links. */
export function EvidenceList({ ids }: { ids: string[] }) {
  const { groups, loading } = useEvidence(ids);
  if (ids.length === 0) return <div className="muted">no evidence</div>;
  if (loading) return <div className="muted">loading evidence…</div>;
  return (
    <div className="evidence">
      {groups.flows.map((f) => (
        <div key={f.flow} className="flow">
          <div className="flow-name">{f.flow}</div>
          <div className="thumbs">
            {f.items.map((it) => (
              <a key={it.id} href={it.url} target="_blank" rel="noreferrer" className="thumb">
                <img src={it.url} alt={evidenceLabel(it)} loading="lazy" />
                <span>{it.artifact?.step !== undefined ? `step ${it.artifact.step}` : evidenceLabel(it)}</span>
              </a>
            ))}
          </div>
        </div>
      ))}
      {groups.links.length > 0 && (
        <ul className="links">
          {groups.links.map((it) => (
            <li key={it.id}>
              <a href={it.url} target="_blank" rel="noreferrer">
                {evidenceLabel(it)}
              </a>
              {it.artifact && <span className="tag">{it.artifact.kind}</span>}
              {it.artifact?.sourceUrl && (
                <a className="muted" href={it.artifact.sourceUrl} target="_blank" rel="noreferrer">
                  source
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
