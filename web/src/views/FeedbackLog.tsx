import { shortDate } from '../logic/format.js';
import { FEEDBACK_KIND_LABELS, feedbackChange, useFeedbackLog } from '../logic/feedback.js';

/** Human feedback log (learning loop WP-A): who did what to which agent output, when and why. */
export function FeedbackLog({ wsId }: { wsId: string }) {
  const log = useFeedbackLog(wsId);
  return (
    <section>
      <h3>Your feedback</h3>
      <p className="muted">
        Every override, edit, correction, answer and approval you made, with the agent run and prompt version it applied to.
      </p>
      {log.error && <div className="error">{log.error}</div>}
      {log.events.length === 0 && !log.loading && <p className="muted">No feedback yet.</p>}
      {log.events.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Target</th>
              <th>Change</th>
              <th>Reason</th>
              <th>Agent run / prompt</th>
            </tr>
          </thead>
          <tbody>
            {log.events.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{shortDate(e.createdAt)}</td>
                <td>{e.actor}</td>
                <td>
                  <span className="tag">{FEEDBACK_KIND_LABELS[e.kind] ?? e.kind}</span>
                </td>
                <td className="small">
                  {e.targetType} {e.targetId}
                </td>
                <td>
                  <details>
                    <summary>{feedbackChange(e)}</summary>
                    <pre>{JSON.stringify({ before: e.beforeJson ?? null, after: e.afterJson ?? null }, null, 2)}</pre>
                  </details>
                </td>
                <td>{e.reason ?? <span className="muted">—</span>}</td>
                <td className="small">
                  {e.agentRunId ?? '—'}
                  {e.promptVersion && <div className="muted">{e.promptVersion}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
