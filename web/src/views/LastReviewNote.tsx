import { useState } from 'react';
import type { LastReview } from '../logic/types.js';
import { CouncilTable } from './CouncilTable.js';

/**
 * Last reviewer verdict on an output that did not pass review (spec §7.2: shown with the objections).
 * When the review was a council round, the council (members, scores per round, who raised what) can be
 * opened below it; it is loaded then, from the node the page is on (`wsId`).
 */
export function LastReviewNote({ review, wsId }: { review: LastReview; wsId: string }) {
  const [council, setCouncil] = useState(false);
  return (
    <div className="review-note">
      <span className="muted">Last review score</span> <b>{review.score}/10</b>
      {review.council && <span className="muted"> by a council</span>}
      {review.synthetic && (
        <span className="muted">
          {review.council ? ' (the council round did not count; nothing was put to the worker)' : ' (reviewer run failed; recorded by the harness)'}
        </span>
      )}
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
      {review.council && (
        <div>
          <button className="link small" aria-expanded={council} onClick={() => setCouncil((v) => !v)}>
            {council ? 'Hide the council' : 'Show the council'}
          </button>
          {council && <CouncilTable taskId={review.council.taskId} wsId={wsId} />}
        </div>
      )}
    </div>
  );
}
