import { useStakeholderReads } from '../../logic/hooks.js';
import { REAL_DECISIONS, words } from '../../logic/stakeholders.js';
import type { OpenStakeholderView, RealDecision, ServedStakeholderRead } from '../../logic/types.js';

type R = ReturnType<typeof useStakeholderReads>;

/**
 * The stakeholder reads of one recommendation (design §10, §15), labelled simulated: stance,
 * conditions, concerns and reasoning; agree / disagree with an optional reason; and "Record the real
 * decision" of an own, open stakeholder. Nothing when there is no read and no stakeholder to record for.
 */
export function StakeholderReads({ wsId, recId, owners }: { wsId: string; recId: string; owners: OpenStakeholderView[] }) {
  const r = useStakeholderReads(wsId, recId);
  if (r.reads.length === 0 && owners.length === 0 && !r.recorded) return null;
  const labelOf = (personaId: string) => owners.find((o) => o.id === personaId)?.label ?? personaId;
  return (
    <section aria-label={`stakeholder reads of ${recId}`}>
      <h4>Stakeholder reads (simulated)</h4>
      {r.error && <div className="error">{r.error}</div>}
      {r.actionError && <div className="error">{r.actionError}</div>}
      {r.reads.map((read) => (
        <Read key={read.id} read={read} r={r} />
      ))}
      {r.recorded && (
        <div className="small muted">
          Recorded: {words(r.recorded.decision)} ({r.recorded.label})
        </div>
      )}
      {owners.length > 0 &&
        (r.form ? (
          <fieldset aria-label={`record the real decision on ${recId}`}>
            <label>
              Stakeholder
              <select value={r.form.personaId} onChange={(e) => r.setForm({ personaId: e.target.value })}>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Decision
              <select value={r.form.decision} onChange={(e) => r.setForm({ decision: e.target.value as RealDecision })}>
                {REAL_DECISIONS.map((d) => (
                  <option key={d} value={d}>
                    {words(d)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reasoning
              <textarea maxLength={2000} value={r.form.reasoning} onChange={(e) => r.setForm({ reasoning: e.target.value })} />
            </label>
            <div className="row">
              <button type="button" className="primary" disabled={r.busy || !r.canRecord} onClick={() => void r.record(labelOf)}>
                Save
              </button>
              <button type="button" onClick={r.closeForm}>
                Cancel
              </button>
            </div>
          </fieldset>
        ) : (
          <button type="button" className="link" onClick={() => r.openForm(owners[0]!.id)}>
            Record the real decision
          </button>
        ))}
    </section>
  );
}

function Read({ read, r }: { read: ServedStakeholderRead; r: R }) {
  const reacted = r.reacted(read.id);
  return (
    <div className="feedback">
      <div>
        <span className="tag simulated">simulated</span> <b>{read.label}</b> <span className="tag">{read.stakeholderType}</span>
        <span className="tag">{words(read.stance)}</span>
      </div>
      {read.conditions.length > 0 && (
        <div className="small">
          Conditions:
          <ul>
            {read.conditions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {read.concerns.length > 0 && (
        <div className="small">
          Concerns:
          <ul>
            {read.concerns.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="small">{read.reasoning}</p>
      {read.wouldChangeMind && <p className="small muted">Would change mind: {read.wouldChangeMind}</p>}
      <div className="row small">
        <input aria-label={`reason for ${read.id}`} placeholder="Reason (optional)" value={r.reason(read.id)} onChange={(e) => r.setReason(read.id, e.target.value)} />
        <button type="button" disabled={r.busy} onClick={() => void r.react(read.id, 'agree')}>
          Agree
        </button>
        <button type="button" disabled={r.busy} onClick={() => void r.react(read.id, 'disagree')}>
          Disagree
        </button>
        {reacted && (
          <span className="muted">
            {`You ${reacted.reaction === 'agree' ? 'agreed' : 'disagreed'}${reacted.reason ? `: ${reacted.reason}` : '.'}`}
          </span>
        )}
      </div>
    </div>
  );
}
