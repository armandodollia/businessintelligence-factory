import { shortDate } from '../logic/format.js';
import { useFindings } from '../logic/hooks.js';
import type { LastReview, Symptom } from '../logic/types.js';
import { CriteriaRatings } from './CriterionRating.js';
import { EvidenceList } from './EvidenceList.js';

export function Findings({ wsId }: { wsId: string }) {
  const f = useFindings(wsId);
  return (
    <div>
      <h2>Findings & Evidence</h2>
      {f.error && <div className="error">{f.error}</div>}
      {f.actionError && <div className="error">{f.actionError}</div>}
      {f.loading && <div className="muted">loading…</div>}

      <div className="split even">
        <SymptomList wsId={wsId} title="What's going badly" items={f.symptoms} />
        <SymptomList wsId={wsId} title="What's going well" items={f.strengths} />
      </div>

      <h3>Findings ({f.findings.length})</h3>
      {f.findings.map((x) => (
        <div key={x.id} className="card">
          <div>
            <b>{x.subject}</b> <span className={`status ${x.status}`}>{x.status}</span>{' '}
            <span className="muted">{shortDate(x.createdAt)}</span>
          </div>
          <p>{x.claim}</p>
          <label className="muted">
            <input
              type="checkbox"
              aria-label={`use ${x.id} in synthesis`}
              checked={f.usedInSynthesis(x)}
              disabled={f.saving}
              onChange={(e) => void f.setIncludeInSynthesis(x.id, e.currentTarget.checked)}
            />{' '}
            Use in recommendations{x.includeInSynthesis !== undefined ? ' (your override)' : x.status === 'verified' ? '' : ' (excluded: not verified)'}
          </label>{' '}
          {x.includeInSynthesis !== undefined && (
            <button className="link" disabled={f.saving} onClick={() => void f.setIncludeInSynthesis(x.id, null)}>
              reset to default
            </button>
          )}
          {x.status !== 'verified' && x.lastReview && <LastReviewNote review={x.lastReview} />}
          <CriteriaRatings workspaceId={wsId} targetType="finding" targetId={x.id} criteria={x.criteria} />
          <EvidenceList ids={x.evidence} />
        </div>
      ))}
    </div>
  );
}

function SymptomList({ wsId, title, items }: { wsId: string; title: string; items: Symptom[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {items.length === 0 && <p className="muted">none yet</p>}
      {items.map((s) => (
        <div key={s.id} className="card">
          <b>{s.title}</b>
          <p className="muted">{s.detail}</p>
          <CriteriaRatings workspaceId={wsId} targetType="symptom" targetId={s.id} criteria={s.criteria} />
          {s.evidence.length > 0 && <EvidenceList ids={s.evidence} />}
        </div>
      ))}
    </section>
  );
}

/** Last reviewer verdict on an unverified finding's task (spec §7.2). */
function LastReviewNote({ review }: { review: LastReview }) {
  return (
    <div className="review-note">
      <span className="muted">Last review score</span> <b>{review.score}/10</b>
      {review.issues.length > 0 ? (
        <ul className="small">
          {review.issues.map((i, n) => (
            <li key={i.id ?? n}>
              {i.class && <span className="tag">{i.class}</span>} {i.description}
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted"> (no issues listed)</span>
      )}
    </div>
  );
}
