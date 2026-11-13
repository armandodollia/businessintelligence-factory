import { useCompetitors } from '../logic/hooks.js';
import type { CompetitorView } from '../logic/types.js';
import { CriterionRating } from './CriterionRating.js';
import { EvidenceList } from './EvidenceList.js';
import { LastReviewNote } from './LastReviewNote.js';

/**
 * Rated competitors (spec §9): threat, directness and per-area comparison, each criterion ratable.
 * Only verified (or user-included) competitors are listed and rated; the others are listed below
 * with their last review and an include toggle.
 */
export function Competitors({ wsId }: { wsId: string }) {
  const cs = useCompetitors(wsId);
  const { competitors, notUsed, criteriaKeys, loading, error } = cs;
  const toggle = (c: CompetitorView, used: boolean) => (
    <div className="small">
      <label className="muted">
        <input
          type="checkbox"
          aria-label={`use ${c.id}`}
          checked={used}
          disabled={cs.saving}
          onChange={(e) => void cs.setInclude(c.id, e.currentTarget.checked)}
        />{' '}
        Use this competitor{c.includeOverride !== undefined ? ' (your override)' : c.status && c.status !== 'verified' ? ' (excluded: not verified)' : ''}
      </label>{' '}
      {c.includeOverride !== undefined && (
        <button className="link" disabled={cs.saving} onClick={() => void cs.setInclude(c.id, null)}>
          reset to default
        </button>
      )}
    </div>
  );
  return (
    <div>
      <h2>Competitors</h2>
      <p className="muted">Comparison areas: 5 = the competitor is much better than you, 3 = on par, 1 = much worse.</p>
      {error && <div className="error">{error}</div>}
      {cs.actionError && <div className="error">{cs.actionError}</div>}
      {loading && <div className="muted">loading…</div>}
      {!loading && competitors.length === 0 && <p className="muted">No verified competitors yet — run competitor discovery.</p>}
      {competitors.map((c) => (
        <div key={c.id} className="card">
          <div>
            <b>{c.name}</b> {c.site && <span className="muted">{c.site}</span>}{' '}
            {c.status && c.status !== 'verified' && <span className={`status ${c.status}`}>{c.status}</span>}
          </div>
          <div className="crits">
            {criteriaKeys.map((k) => (
              <CriterionRating key={k} workspaceId={wsId} targetType="competitor" targetId={c.id} criterion={k} agentValue={c.criteria[k]} />
            ))}
          </div>
          {toggle(c, true)}
          {c.evidence.length > 0 && <EvidenceList ids={c.evidence} />}
        </div>
      ))}
      {notUsed.length > 0 && (
        <details>
          <summary>
            {notUsed.length} competitor{notUsed.length === 1 ? '' : 's'} not used (pending, unverified, failed or excluded)
          </summary>
          {notUsed.map((c) => (
            <div key={c.id} className="card">
              <div>
                <b>{c.name}</b> {c.site && <span className="muted">{c.site}</span>}{' '}
                {c.status && <span className={`status ${c.status}`}>{c.status}</span>}
              </div>
              {c.status !== 'verified' && c.lastReview && <LastReviewNote review={c.lastReview} />}
              {toggle(c, false)}
              {c.evidence.length > 0 && <EvidenceList ids={c.evidence} />}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
