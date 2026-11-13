import { useCompetitors } from '../logic/hooks.js';
import { CriterionRating } from './CriterionRating.js';
import { EvidenceList } from './EvidenceList.js';

/** Rated competitors (spec §9): threat, directness and per-area comparison, each criterion ratable. */
export function Competitors({ wsId }: { wsId: string }) {
  const { competitors, criteriaKeys, loading, error } = useCompetitors(wsId);
  return (
    <div>
      <h2>Competitors</h2>
      <p className="muted">Comparison areas: 5 = the competitor is much better than you, 3 = on par, 1 = much worse.</p>
      {error && <div className="error">{error}</div>}
      {loading && <div className="muted">loading…</div>}
      {!loading && competitors.length === 0 && <p className="muted">No competitors yet — run competitor discovery.</p>}
      {competitors.map((c) => (
        <div key={c.id} className="card">
          <div>
            <b>{c.name}</b> {c.site && <span className="muted">{c.site}</span>}
          </div>
          <div className="crits">
            {criteriaKeys.map((k) => (
              <CriterionRating key={k} workspaceId={wsId} targetType="competitor" targetId={c.id} criterion={k} agentValue={c.criteria[k]} />
            ))}
          </div>
          {c.evidence.length > 0 && <EvidenceList ids={c.evidence} />}
        </div>
      ))}
    </div>
  );
}
