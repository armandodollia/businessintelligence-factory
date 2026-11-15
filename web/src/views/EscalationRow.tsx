import { shortDate } from '../logic/format.js';
import { useForm } from '../logic/hooks.js';
import { isWithheld, WITHHELD_TEXT } from '../logic/stakeholders.js';
import type { UserRequest } from '../logic/types.js';

/**
 * WP-D: one structured escalation question (task ended unverified / failed). The user picks one
 * option (the agent's recommended one is preselected and tagged) with an optional note, or
 * dismisses the question. Answering every question of an escalation re-runs the task.
 */
export function EscalationRow(props: {
  request: UserRequest;
  busy: boolean;
  answer: (id: string, choice: number, note?: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}) {
  const { request: r, busy, answer, dismiss } = props;
  const opts = r.optionsJson;
  const form = useForm({ choice: opts?.recommended ?? 0, note: '' });
  const note = form.values.note.trim() || undefined;
  return (
    <div className="request escalation">
      <div>
        <span className="tag strong">question</span>
        {r.taskId && <span className="muted"> task {r.taskId}</span>} <span className="muted">{shortDate(r.createdAt)}</span>
      </div>
      <div className="request-details">{isWithheld(r) ? WITHHELD_TEXT : r.details}</div>
      {opts?.rationale && <div className="muted">{opts.rationale}</div>}
      {opts && (
        <fieldset className="escalation-options" aria-label={`options for ${r.id}`}>
          {opts.options.map((o, i) => (
            <label key={i}>
              <input
                type="radio"
                name={`escalation-${r.id}`}
                checked={form.values.choice === i}
                onChange={() => form.set('choice', i)}
              />
              {o}
              {i === opts.recommended && <span className="tag">recommended</span>}
            </label>
          ))}
        </fieldset>
      )}
      <div className="row">
        <input placeholder="note (optional)" value={form.values.note} onChange={(e) => form.set('note', e.target.value)} />
        <button className="primary" disabled={busy || !opts} onClick={() => void answer(r.id, form.values.choice, note)}>
          Answer
        </button>
        <button disabled={busy} onClick={() => void dismiss(r.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
