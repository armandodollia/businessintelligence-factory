import { decisionCriteria, formatValue, shortDate, summarize } from '../logic/format.js';
import { useCalibration, useDecisions, useForm, usePromptPatch } from '../logic/hooks.js';
import type { Decision, PatchRole } from '../logic/types.js';
import { CriteriaRatings } from './CriterionRating.js';

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
            <th>Rate</th>
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
              <td>
                <DecisionRatings wsId={wsId} decision={d} />
              </td>
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

      <PromptPatchPanel wsId={wsId} />
    </div>
  );
}

function PromptPatchPanel({ wsId }: { wsId: string }) {
  const p = usePromptPatch(wsId);
  return (
    <section>
      <h3>Prompt calibration patch</h3>
      <p className="muted">
        Builds a prompt appendix for one role from the ratings you disagreed with. Nothing is written until you apply it.
      </p>
      <div className="row">
        <label>
          Role
          <select value={p.role} onChange={(e) => p.setRole(e.target.value as PatchRole)}>
            {p.roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <button disabled={p.busy} onClick={() => void p.propose()}>
          {p.busy && !p.proposal ? 'Proposing…' : 'Propose patch'}
        </button>
      </div>
      {p.error && <div className="error">{p.error}</div>}
      {p.applied && (
        <div className="muted">
          Applied. Written to <code>{p.applied.path}</code> (decision {p.applied.decisionId}).
        </div>
      )}
      {p.proposal && (
        <div>
          <p className="small muted">
            Based on {p.proposal.examples.length} disagreement{p.proposal.examples.length === 1 ? '' : 's'}
            {p.edited ? ' (edited)' : ''}.
          </p>
          <textarea
            className="code"
            rows={12}
            spellCheck={false}
            aria-label="Patch text"
            value={p.text}
            onChange={(e) => p.setText(e.target.value)}
          />
          <div className="row">
            <button className="primary" disabled={!p.canApply} onClick={() => void p.apply()}>
              Apply patch
            </button>
            <button onClick={p.discard}>Discard</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Inline rating of a decision's agent values (confidence, review score); nothing when none. */
function DecisionRatings({ wsId, decision }: { wsId: string; decision: Decision }) {
  const criteria = decisionCriteria(decision);
  if (Object.keys(criteria).length === 0) return null;
  return <CriteriaRatings workspaceId={wsId} targetType="decision" targetId={decision.id} criteria={criteria} />;
}
