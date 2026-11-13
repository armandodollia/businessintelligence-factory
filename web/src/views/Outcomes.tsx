import { useOutcomes } from '../logic/outcomes.js';

/** Learning loop WP-C: counts of each decision-outcome label per role / task type / prompt version. */
export function OutcomesTable({ wsId }: { wsId: string }) {
  const o = useOutcomes(wsId);
  return (
    <section>
      <h3>Decision outcomes</h3>
      <p className="muted">
        How agent decisions turned out later: review results, superseded outputs, scheduled re-runs, review disputes and your
        overrides.
      </p>
      <label className="row">
        <input type="checkbox" checked={o.tree} onChange={(e) => o.setTree(e.target.checked)} />
        Whole business tree
      </label>
      {o.error && <div className="error">{o.error}</div>}
      {o.loading && <div className="muted">loading…</div>}
      {o.report && o.report.rows.length === 0 && <div className="muted">No outcomes yet.</div>}
      {o.report && o.report.rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Task type</th>
              <th>Prompt</th>
              {o.columns.map((l) => (
                <th key={l}>{l}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {o.report.rows.map((r) => (
              <tr key={`${r.role ?? ''}:${r.taskType ?? ''}:${r.promptVersion ?? ''}`}>
                <td>{r.role ?? '—'}</td>
                <td>{r.taskType ?? '—'}</td>
                <td className="small">{r.promptVersion ?? '—'}</td>
                {o.columns.map((l) => (
                  <td key={l}>{r.counts[l] ?? 0}</td>
                ))}
                <td>{r.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
