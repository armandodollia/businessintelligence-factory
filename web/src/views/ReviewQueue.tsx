import { useReviewQueue } from '../logic/hooks.js';
import { CriteriaRatings } from './CriterionRating.js';

export function ReviewQueue({ wsId }: { wsId: string }) {
  const q = useReviewQueue(wsId);
  return (
    <div>
      <h2>Review queue</h2>
      <p className="muted">Items with criteria you haven't rated yet. Rated criteria drop off the queue.</p>
      {q.error && <div className="error">{q.error}</div>}
      {q.loading && <div className="muted">loading…</div>}
      {!q.loading && q.items.length === 0 && <p>All caught up.</p>}
      {q.items.map((it) => (
        <div key={`${it.targetType}:${it.targetId}`} className="card">
          <div>
            <span className={`tag ${it.targetType === 'persona_feedback' ? 'simulated' : ''}`}>
              {it.targetType === 'persona_feedback' ? 'persona feedback (simulated)' : it.targetType}
            </span>{' '}
            <b>{it.title}</b>
          </div>
          <CriteriaRatings
            workspaceId={wsId}
            targetType={it.targetType}
            targetId={it.targetId}
            criteria={it.criteria}
            only={it.unrated}
            onRated={(r) => q.markRated(it.targetType, it.targetId, r.criterion)}
          />
        </div>
      ))}
    </div>
  );
}
