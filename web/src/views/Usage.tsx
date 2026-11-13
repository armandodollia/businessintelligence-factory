import { useState } from 'react';
import { shortDate } from '../logic/format.js';
import type { CostGroup } from '../logic/types.js';
import {
  describeRunEvent,
  formatRate,
  formatTokens,
  formatUsd,
  useAgentRuns,
  useCalibrationHistory,
  useCosts,
  usePromptText,
  usePromptVersionMetrics,
  useRunEvents,
} from '../logic/usage.js';

/** Usage & prompts: costs and budgets, per-prompt-version trend, calibration history, run events. */
export function Usage({ wsId }: { wsId: string }) {
  const [promptHash, setPromptHash] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  return (
    <div>
      <h2>Usage &amp; prompts</h2>
      <Costs wsId={wsId} />
      <PromptVersions wsId={wsId} onPrompt={setPromptHash} />
      {promptHash && <PromptText hash={promptHash} onClose={() => setPromptHash(null)} />}
      <CalibrationHistory wsId={wsId} />
      <Runs wsId={wsId} selected={runId} onSelect={setRunId} onPrompt={setPromptHash} />
      {runId && <RunEvents runId={runId} onClose={() => setRunId(null)} />}
    </div>
  );
}

function capText(c: { maxTokens?: number; maxCostUsd?: number }): string {
  return [c.maxTokens !== undefined ? `${formatTokens(c.maxTokens)} tokens` : '', c.maxCostUsd !== undefined ? formatUsd(c.maxCostUsd) : '']
    .filter(Boolean)
    .join(' / ');
}

function Costs({ wsId }: { wsId: string }) {
  const { report, error } = useCosts(wsId);
  if (error) return <div className="error">{error}</div>;
  if (!report) return <p className="muted">Loading costs…</p>;
  const t = report.total;
  return (
    <section>
      <h3>Costs</h3>
      <p>
        <b>{formatUsd(t.costUsd)}</b> · {formatTokens(t.totalTokens)} tokens · {t.runs} runs
        {t.unpriced > 0 && <span className="muted"> · {t.unpriced} usage records without a price</span>}
        <span className="muted small">
          {' '}
          (pricing {report.pricing.version}, effective {report.pricing.effectiveDate}; edit src/core/harness/pricing.json)
        </span>
      </p>
      {(report.budgets ?? []).map((b) => (
        <div key={`${b.kind}:${b.id}`} className={b.exceeded ? 'flag' : 'card'}>
          {b.kind} budget: spent {formatTokens(b.spent.tokens)} tokens / {formatUsd(b.spent.costUsd)} of {capText(b.effectiveCap)}
          {b.extensions > 0 && ` (${b.extensions} extension${b.extensions > 1 ? 's' : ''})`}
          {b.exceeded && (b.denied ? ' — extension denied, new runs stopped' : ' — reached; approve the request above to continue')}
        </div>
      ))}
      <div className="split">
        <CostTable title="By role" rows={report.byRole} />
        <CostTable title="By model" rows={report.byModel} />
      </div>
      <div className="split">
        <CostTable title="By prompt version" rows={report.byPromptVersion} />
        <CostTable title="By task" rows={report.byTask.slice(0, 20)} />
      </div>
    </section>
  );
}

function CostTable({ title, rows }: { title: string; rows: CostGroup[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>{title}</th>
          <th>Runs</th>
          <th>Input</th>
          <th>Cache read</th>
          <th>Output</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((g) => (
          <tr key={g.key}>
            <td>{g.label}</td>
            <td>{g.runs}</td>
            <td>{formatTokens(g.inputTokens + g.cacheWriteTokens)}</td>
            <td>{formatTokens(g.cacheReadTokens)}</td>
            <td>{formatTokens(g.outputTokens)}</td>
            <td>{formatUsd(g.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PromptVersions({ wsId, onPrompt }: { wsId: string; onPrompt: (hash: string) => void }) {
  const { rows, error } = usePromptVersionMetrics(wsId);
  return (
    <section>
      <h3>Prompt versions</h3>
      <p className="muted small">Per role, oldest version first: rating agreement and review outcomes of the work each version produced.</p>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Version</th>
            <th>First used</th>
            <th>Runs</th>
            <th>Ratings</th>
            <th>Agree</th>
            <th>Mean Δ</th>
            <th>Tasks</th>
            <th>Pass</th>
            <th>1st-round pass</th>
            <th>Rounds</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.role}:${r.promptVersion}`}>
              <td>{r.role}</td>
              <td>
                <button className="link" onClick={() => onPrompt(r.promptVersion)}>
                  {r.promptVersion}
                </button>
              </td>
              <td className="nowrap">{shortDate(r.firstSeen)}</td>
              <td>{r.runs}</td>
              <td>{r.ratings}</td>
              <td>{formatRate(r.agreeRate)}</td>
              <td>{r.meanDelta === null ? '—' : r.meanDelta.toFixed(2)}</td>
              <td>{r.tasks}</td>
              <td>{formatRate(r.passRate)}</td>
              <td>{formatRate(r.firstRoundPassRate)}</td>
              <td>{r.meanRounds === null ? '—' : r.meanRounds.toFixed(1)}</td>
              <td>{formatUsd(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PromptText({ hash, onClose }: { hash: string; onClose: () => void }) {
  const { prompt, error } = usePromptText(hash);
  return (
    <div className="card">
      <div className="row">
        <b>Prompt version {hash}</b>
        {prompt && <span className="muted small">{prompt.role}</span>}
        <button onClick={onClose}>Close</button>
      </div>
      {error && <div className="error">{error}</div>}
      {prompt && <pre className="log">{prompt.text}</pre>}
    </div>
  );
}

function CalibrationHistory({ wsId }: { wsId: string }) {
  const h = useCalibrationHistory(wsId);
  return (
    <section>
      <h3>Calibration history</h3>
      <p className="muted small">Approved prompt patches of this business, per role. Reverting restores an earlier appendix and is logged.</p>
      {h.error && <div className="error">{h.error}</div>}
      {h.reverted && (
        <p className="muted">
          Reverted {h.reverted.version.role} calibration (decision {h.reverted.decisionId}).
        </p>
      )}
      {h.roles.length === 0 && <p className="muted">No calibration patches yet.</p>}
      {h.roles.map((g) => (
        <div key={g.role} className="card">
          <b>{g.role}</b>
          <table>
            <tbody>
              {[...g.versions].reverse().map((v) => (
                <tr key={v.id}>
                  <td className="nowrap">{shortDate(v.createdAt)}</td>
                  <td>
                    <span className="tag">{v.source}</span>
                    {v.id === g.current.id && <span className="tag">current</span>}
                  </td>
                  <td className="muted small">{v.actor}</td>
                  <td className="small">{v.text.trim() ? `${v.text.trim().split('\n').length} lines` : '(no calibration)'}</td>
                  <td>
                    {v.id !== g.current.id && (
                      <button disabled={h.busy} onClick={() => void h.revert(v.id)}>
                        Revert to this
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function Runs({
  wsId,
  selected,
  onSelect,
  onPrompt,
}: {
  wsId: string;
  selected: string | null;
  onSelect: (id: string) => void;
  onPrompt: (hash: string) => void;
}) {
  const { runs, error } = useAgentRuns(wsId);
  return (
    <section>
      <h3>Agent runs</h3>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Role</th>
            <th>Model</th>
            <th>Prompt</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Failure</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={r.id === selected ? 'current' : ''}>
              <td className="nowrap">{shortDate(r.startedAt)}</td>
              <td>
                {r.role}
                {r.taskType && <span className="muted small"> {r.taskType}</span>}
                {r.round !== undefined && <span className="muted small"> r{r.round}</span>}
              </td>
              <td>
                {r.model.provider}/{r.model.model}
              </td>
              <td>
                {r.promptVersion && (
                  <button className="link" onClick={() => onPrompt(r.promptVersion!)}>
                    {r.promptVersion}
                  </button>
                )}
              </td>
              <td>{r.status}</td>
              <td>{r.attempts ?? '—'}</td>
              <td className="small">{r.failureReason}</td>
              <td>{formatTokens(r.usage.totalTokens)}</td>
              <td>{formatUsd(r.usage.costUsd)}</td>
              <td>
                <button onClick={() => onSelect(r.id)}>Events</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RunEvents({ runId, onClose }: { runId: string; onClose: () => void }) {
  const v = useRunEvents(runId);
  return (
    <div className="card">
      <div className="row">
        <b>Run {runId}</b>
        <span className="muted small">
          events {v.from}–{v.to} of {v.total}
        </span>
        <button disabled={!v.canPrev} onClick={v.prev}>
          Previous
        </button>
        <button disabled={!v.canNext} onClick={v.next}>
          Next
        </button>
        <button onClick={onClose}>Close</button>
      </div>
      {v.error && <div className="error">{v.error}</div>}
      {v.detail && v.detail.attempts.length > 0 && (
        <ul className="small">
          {v.detail.attempts.map((a) => (
            <li key={a.id}>
              attempt {a.attempt}: exit {a.exitCode}
              {a.rateLimited ? ', rate limited' : ''}
              {a.failureReason ? ` — ${a.failureReason}` : ''}
              {a.backoffMs !== undefined ? `, back-off ${Math.round(a.backoffMs / 1000)} s` : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="log">
        {v.events.map((e, i) => (
          <div key={v.offset + i} className="log-line">
            {describeRunEvent(e)}
          </div>
        ))}
      </div>
    </div>
  );
}
