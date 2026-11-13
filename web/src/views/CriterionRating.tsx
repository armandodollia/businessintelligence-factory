import { formatValue } from '../logic/format.js';
import { useCriterionRating, type CriterionTarget } from '../logic/hooks.js';
import type { Criteria, Rating, RatingTargetType } from '../logic/types.js';

type Props = CriterionTarget & { onRated?: (r: Rating) => void };

/** One agent criterion value: agree, or disagree → own value + optional reason. */
export function CriterionRating({ onRated, ...target }: Props) {
  const r = useCriterionRating(target, onRated);
  return (
    <div className="crit">
      <span className="crit-name">{target.criterion}</span>
      <span className="crit-value">{formatValue(target.agentValue)}</span>
      {r.mode === 'idle' && (
        <span className="crit-actions">
          <button disabled={r.saving} onClick={() => void r.agree()}>
            Agree
          </button>
          <button disabled={r.saving} onClick={r.startDisagree}>
            Disagree
          </button>
        </span>
      )}
      {r.mode === 'disagreeing' && (
        <span className="crit-actions">
          <input
            aria-label={`Your ${target.criterion}`}
            className="crit-input"
            value={r.value}
            onChange={(e) => r.setValue(e.target.value)}
          />
          <input
            aria-label="Reason (optional)"
            placeholder="reason (optional)"
            value={r.reason}
            onChange={(e) => r.setReason(e.target.value)}
          />
          <button disabled={r.saving || !r.canSubmitDisagree} onClick={() => void r.submitDisagree()}>
            Save
          </button>
          <button onClick={r.cancel}>Cancel</button>
        </span>
      )}
      {r.mode === 'done' && (
        <span className="crit-done">
          {r.verdict === 'agree' ? 'agreed' : `you: ${r.value}`}{' '}
          <button className="link" onClick={r.change}>
            change
          </button>
        </span>
      )}
      {r.error && <span className="error">{r.error}</span>}
    </div>
  );
}

/** All criteria of one item, each individually ratable. */
export function CriteriaRatings(props: {
  workspaceId: string;
  targetType: RatingTargetType;
  targetId: string;
  criteria: Criteria;
  only?: string[];
  onRated?: (r: Rating) => void;
}) {
  const keys = props.only ?? Object.keys(props.criteria);
  if (keys.length === 0) return <div className="muted">no criteria</div>;
  return (
    <div className="crits">
      {keys.map((k) => (
        <CriterionRating
          key={k}
          workspaceId={props.workspaceId}
          targetType={props.targetType}
          targetId={props.targetId}
          criterion={k}
          agentValue={props.criteria[k]}
          {...(props.onRated ? { onRated: props.onRated } : {})}
        />
      ))}
    </div>
  );
}
