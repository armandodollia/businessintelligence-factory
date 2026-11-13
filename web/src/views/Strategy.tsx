import { formatValue } from '../logic/format.js';
import { useFindingIndex, useRecommendations, useScoringWeights } from '../logic/hooks.js';
import type { FindingView, PersonaFeedback } from '../logic/types.js';
import { CriteriaRatings, CriterionRating } from './CriterionRating.js';
import { EvidenceList } from './EvidenceList.js';

export function Strategy({ wsId }: { wsId: string }) {
  const { recommendations, loading, error, reload } = useRecommendations(wsId);
  const index = useFindingIndex(wsId);
  return (
    <div>
      <h2>Strategy</h2>
      <p className="muted">
        Ranked by priority (evidence-backed criteria). Persona feedback is simulated and shown separately; by default it
        does not affect priority.
      </p>
      {error && <div className="error">{error}</div>}
      {loading && <div className="muted">loading…</div>}
      <table className="strategy">
        <thead>
          <tr>
            <th>#</th>
            <th>Recommendation</th>
            <th>Priority</th>
            <th>Criteria (evidence-backed)</th>
            <th className="simulated">Simulated</th>
          </tr>
        </thead>
        <tbody>
          {recommendations.map((r, i) => (
            <tr key={r.id}>
              <td>{i + 1}</td>
              <td>
                <b>{r.title}</b>
                <p>{r.summary}</p>
                <LinkedFindings ids={r.findingIds} resolve={index.resolve} />
              </td>
              <td>
                <CriterionRating
                  workspaceId={wsId}
                  targetType="recommendation"
                  targetId={r.id}
                  criterion="priority"
                  agentValue={r.priority}
                />
              </td>
              <td>
                <CriteriaRatings workspaceId={wsId} targetType="recommendation" targetId={r.id} criteria={r.criteria} />
              </td>
              <td className="simulated">
                {r.personaFeedback.length === 0 && <span className="muted">no persona feedback</span>}
                {r.personaFeedback.map((pf) => (
                  <PersonaFeedbackCell key={pf.personaId} wsId={wsId} recId={r.id} feedback={pf} />
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <WeightsEditor wsId={wsId} onSaved={() => void reload()} />
    </div>
  );
}

function WeightsEditor({ wsId, onSaved }: { wsId: string; onSaved: () => void }) {
  const w = useScoringWeights(wsId);
  return (
    <section>
      <h3>Priority weights</h3>
      <p className="muted">
        Weights apply to all workspaces. Saving rescores every recommendation and is logged as a decision. Persona weight
        is the share of simulated feedback in priority (default 0).
      </p>
      {w.error && <div className="error">{w.error}</div>}
      <table>
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Weight</th>
            {w.proposed && <th>Proposed from your ratings</th>}
          </tr>
        </thead>
        <tbody>
          {w.keys.map((k) => (
            <tr key={k}>
              <td>{k}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  aria-label={`weight ${k}`}
                  className={w.invalid.includes(k) ? 'invalid' : ''}
                  value={w.values[k]}
                  onChange={(e) => w.set(k, e.target.value)}
                />
              </td>
              {w.proposed && <td>{formatValue(w.proposed[k])}</td>}
            </tr>
          ))}
          <tr>
            <td className="simulated">personaWeight (simulated)</td>
            <td>
              <input
                type="number"
                min={0}
                step={0.1}
                aria-label="persona weight"
                className={w.invalid.includes('personaWeight') ? 'invalid' : ''}
                value={w.values.personaWeight}
                onChange={(e) => w.set('personaWeight', e.target.value)}
              />
            </td>
            {w.proposed && <td />}
          </tr>
        </tbody>
      </table>
      {w.invalid.length > 0 && <div className="error">Weights must be numbers ≥ 0: {w.invalid.join(', ')}</div>}
      <div className="row">
        <button
          className="primary"
          disabled={!w.dirty || w.invalid.length > 0 || w.saving}
          onClick={() => void w.save().then((ok) => ok && onSaved())}
        >
          {w.saving ? 'Saving…' : 'Save weights'}
        </button>
        <button disabled={!w.hasProposal} onClick={w.adoptProposed}>
          Use proposed
        </button>
        <button disabled={!w.dirty} onClick={w.revert}>
          Revert
        </button>
        {w.savedDecisionId && <span className="muted">saved (decision {w.savedDecisionId})</span>}
      </div>
    </section>
  );
}

function PersonaFeedbackCell({ wsId, recId, feedback }: { wsId: string; recId: string; feedback: PersonaFeedback }) {
  return (
    <div className="feedback">
      <div>
        <span className="tag">simulated</span> <b>{feedback.personaId}</b>
      </div>
      <CriteriaRatings
        workspaceId={wsId}
        targetType="persona_feedback"
        targetId={`${recId}:${feedback.personaId}`}
        criteria={feedback.scores}
      />
      {feedback.concerns.length > 0 && (
        <ul className="small">
          {feedback.concerns.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>reasoning</summary>
        <p className="small">{feedback.reasoning}</p>
        <p className="small muted">Would change mind: {feedback.wouldChangeMind}</p>
      </details>
    </div>
  );
}

/** Recommendation → findings → artifacts (spec §7.3): each cited finding expands to its evidence. */
function LinkedFindings({
  ids,
  resolve,
}: {
  ids: string[];
  resolve: (ids: string[]) => { found: FindingView[]; missing: string[] };
}) {
  const { found, missing } = resolve(ids);
  if (ids.length === 0) return <div className="muted">no findings cited</div>;
  return (
    <details className="linked-findings">
      <summary>
        {ids.length} finding{ids.length === 1 ? '' : 's'}
      </summary>
      <ul className="plain small">
        {found.map((f) => (
          <li key={f.id}>
            <details>
              <summary>
                <b>{f.subject}</b>: {f.claim} <span className={`status ${f.status}`}>{f.status}</span>
              </summary>
              <EvidenceList ids={f.evidence} />
            </details>
          </li>
        ))}
        {missing.map((id) => (
          <li key={id} className="muted">
            {id} (not found)
          </li>
        ))}
      </ul>
    </details>
  );
}
