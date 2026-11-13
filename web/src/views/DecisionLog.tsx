import { formatValue, shortDate, summarize } from '../logic/format.js';
import { useCalibration, useDecisions, useForm } from '../logic/hooks.js';
import type { Decision } from '../logic/types.js';

const KINDS: Decision['kind'][] = ['decision', 'review', 'pushback', 'task_proposal', 'persona_feedback', 'score'];

export function DecisionLog({ wsId }: { wsId: string }) {
  const form = useForm({ kind: '' as Decision['kind'] | '' });
  const { decisions, exportUrl, loading, error } = useDecisions(wsId, form.values.kind || undefined);
  const cal = useCalibration(wsId);

  return (
    <div>
      <h2>Decision log</h2>
      <div className="row">
        <label>
          Kind
          <select value={form.values.kind} onChange={(e) => form.set('kind', e.target.value as Decision['kind'] | '')}>
            <option value="">all</option>
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        {exportUrl && (
          <a href={exportUrl} download>
            Export decisions + ratings (JSONL)
          </a>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {loading && <div className="muted">loading…</div>}
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Role / model</th>
            <th>Kind</th>
            <th>Payload</th>
            <th>Refs</th>
            <th>Prompt</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d) => (
            <tr key={d.id}>
              <td className="nowrap">{shortDate(d.createdAt)}</td>
              <td>
                {d.role}
                <div className="muted small">
                  {d.model.provider}/{d.model.model}
                </div>
              </td>
              <td>
                <span className={`tag ${d.kind === 'persona_feedback' ? 'simulated' : ''}`}>{d.kind}</span>
              </td>
              <td>
                <details>
                  <summary>{summarize(d.payload, 140)}</summary>
                  <pre>{JSON.stringify(d.payload, null, 2)}</pre>
                </details>
              </td>
              <td className="small">{d.refs.join(', ')}</td>
              <td className="small">{d.promptVersion}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Calibration</h3>
      <p className="muted">Where your ratings disagree with the agents, per criterion.</p>
      {cal.error && <div className="error">{cal.error}</div>}
      {cal.report && (
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Criterion</th>
              <th>n</th>
              <th>Agree rate</th>
              <th>Mean delta</th>
            </tr>
          </thead>
          <tbody>
            {cal.report.byCriterion.map((c) => (
              <tr key={`${c.targetType}:${c.criterion}`}>
                <td>{c.targetType}</td>
                <td>{c.criterion}</td>
                <td>{c.n}</td>
                <td>{Math.round(c.agreeRate * 100)}%</td>
                <td>{formatValue(c.meanDelta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
