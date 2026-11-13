import { formatValue } from '../logic/format.js';
import { useRecommendations } from '../logic/hooks.js';
import type { PersonaFeedback } from '../logic/types.js';
import { CriteriaRatings } from './CriterionRating.js';

export function Strategy({ wsId }: { wsId: string }) {
  const { recommendations, loading, error } = useRecommendations(wsId);
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
                <span className="muted">{r.findingIds.length} findings</span>
              </td>
              <td>{formatValue(r.priority)}</td>
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
    </div>
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
