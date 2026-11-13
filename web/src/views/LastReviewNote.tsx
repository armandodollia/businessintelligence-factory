import type { LastReview } from '../logic/types.js';

/** Last reviewer verdict on an output that did not pass review (spec §7.2: shown with the objections). */
export function LastReviewNote({ review }: { review: LastReview }) {
  return (
    <div className="review-note">
      <span className="muted">Last review score</span> <b>{review.score}/10</b>
      {review.synthetic && <span className="muted"> (reviewer run failed; recorded by the harness)</span>}
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
