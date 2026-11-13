import { hypothesisCorrection, useHypotheses, type HypothesisView } from '../logic/feedback.js';
import { useForm } from '../logic/hooks.js';

/**
 * Research hypotheses per interview symptom (learning loop WP-A): the include override for the
 * interviewer's drill-down and the user's own correction (text / confidence + why).
 */
export function Hypotheses({ wsId }: { wsId: string }) {
  const h = useHypotheses(wsId);
  if (h.hypotheses.length === 0 && !h.error) return null;
  return (
    <section>
      <h3>Symptom hypotheses ({h.hypotheses.length})</h3>
      {h.error && <div className="error">{h.error}</div>}
      {h.actionError && <div className="error">{h.actionError}</div>}
      {h.hypotheses.map((x) => (
        <HypothesisCard key={x.id} item={x} used={h.used(x)} busy={h.busy} setInclude={h.setInclude} correct={h.correct} />
      ))}
    </section>
  );
}

function HypothesisCard(props: {
  item: HypothesisView;
  used: boolean;
  busy: boolean;
  setInclude: (id: string, include: boolean | null) => Promise<boolean>;
  correct: ReturnType<typeof useHypotheses>['correct'];
}) {
  const { item: x } = props;
  const form = useForm({ hypothesis: x.hypothesis, confidence: String(x.confidence), reason: '' });
  const correction = hypothesisCorrection(x, form.values);
  return (
    <div className="card">
      <div>
        <span className="muted">Symptom: {x.symptomTitle}</span> <span className={`status ${x.status ?? 'pending'}`}>{x.status ?? 'pending'}</span>
      </div>
      <p>
        {x.hypothesis} <span className="muted">({x.confidence}% confidence)</span>
      </p>
      <label className="muted">
        <input
          type="checkbox"
          aria-label={`use ${x.id} in interview drill-down`}
          checked={props.used}
          disabled={props.busy}
          onChange={(e) => void props.setInclude(x.id, e.currentTarget.checked)}
        />{' '}
        Use in interview drill-down
        {x.includeOverride !== undefined ? ' (your override)' : x.status === 'verified' ? '' : ' (excluded: not verified)'}
      </label>{' '}
      {x.includeOverride !== undefined && (
        <button className="link" disabled={props.busy} onClick={() => void props.setInclude(x.id, null)}>
          reset to default
        </button>
      )}
      <details>
        <summary>Correct this hypothesis</summary>
        <div className="form">
          <label>
            Hypothesis
            <textarea aria-label={`hypothesis ${x.id}`} rows={2} value={form.values.hypothesis} onChange={(e) => form.set('hypothesis', e.target.value)} />
          </label>
          <label>
            Confidence %
            <input aria-label={`confidence ${x.id}`} type="number" min={0} max={100} value={form.values.confidence} onChange={(e) => form.set('confidence', e.target.value)} />
          </label>
          <label>
            Why
            <input aria-label={`reason ${x.id}`} value={form.values.reason} onChange={(e) => form.set('reason', e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={props.busy || !correction}
            onClick={() => {
              if (!correction) return;
              void props.correct(x.id, correction).then((ok) => ok && form.set('reason', ''));
            }}
          >
            Save correction
          </button>
        </div>
      </details>
    </div>
  );
}
