import { useState } from 'react';
import { shortDate } from '../logic/format.js';
import { auditLabel, modelLabel, useAudits, useExperimentComparison, useExperiments } from '../logic/experiments.js';
import { isWithheld, WITHHELD_TEXT } from '../logic/stakeholders.js';
import { formatRate } from '../logic/usage.js';

/** Learning loop WP-F: reviewer audits and A/B experiments (minimal views). */
export function Experiments({ wsId }: { wsId: string }) {
  return (
    <div>
      <h2>Audits &amp; experiments</h2>
      <Audits wsId={wsId} />
      <ExperimentsSection wsId={wsId} />
    </div>
  );
}

function Audits({ wsId }: { wsId: string }) {
  const a = useAudits(wsId);
  const [n, setN] = useState('5');
  const [cron, setCron] = useState('0 3 * * 1');
  const s = a.view?.summary;
  return (
    <section>
      <h3>Reviewer audits</h3>
      <p className="muted">
        A different model re-reviews recently verified tasks of this business with the reviewer&apos;s own context. A miss (the auditor
        fails work the reviewer passed) is logged as a weak review. Audits never change a task.
      </p>
      {a.error && <div className="error">{a.error}</div>}
      {s && (
        <p>
          {s.total} audits · {s.agree} agree · <b>{s.miss} misses</b> · {s.invalid} invalid · {s.skipped} skipped · miss rate {formatRate(s.missRate)}
          {s.running > 0 && <span className="muted"> · {s.running} running…</span>}
        </p>
      )}
      <div className="row">
        <label>
          Tasks{' '}
          <input type="number" min={1} max={50} value={n} onChange={(e) => setN(e.target.value)} style={{ width: '4em' }} />
        </label>
        <button disabled={a.busy} onClick={() => void a.runAudit(Number(n) || 5)}>
          Audit now
        </button>
      </div>
      {a.actionError && <div className="error">{a.actionError}</div>}
      {a.view && a.view.audits.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Task</th>
              <th>Reviewer</th>
              <th>Score</th>
              <th>Auditor</th>
              <th>Score</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {a.view.audits.map((x) => (
              <tr key={x.id} className={x.verdict === 'miss' && !isWithheld(x) ? 'flag' : ''}>
                <td className="small">{shortDate(x.createdAt)}</td>
                <td className="small">
                  {x.taskType} <span className="muted">{x.taskId}</span>
                </td>
                <td className="small">{modelLabel(x.originalModel)}</td>
                <td>{x.originalScore}</td>
                <td className="small">{modelLabel(x.auditModel)}</td>
                <td>{x.auditScore ?? '—'}</td>
                <td>
                  {/* Stakeholder design §7: an audit of own-stakeholder research while a stakeholder is hidden. */}
                  {isWithheld(x) ? <span className="muted">{WITHHELD_TEXT}</span> : auditLabel(x)}
                  {!isWithheld(x) && x.verdict === 'miss' && x.auditIssues.length > 0 && (
                    <ul className="small">
                      {x.auditIssues.map((i, k) => (
                        <li key={k}>
                          ({i.class}) {i.description}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>Audit schedules</h4>
      {a.view?.schedules.map((sc) => (
        <div key={sc.id} className="row">
          <code>{sc.cron}</code> · {sc.n} tasks · {sc.enabled ? 'on' : 'off'}
          {sc.lastRunAt && <span className="muted small"> · last run {shortDate(sc.lastRunAt)}</span>}
          <button disabled={a.busy} onClick={() => void a.setScheduleEnabled(sc.id, !sc.enabled)}>
            {sc.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      ))}
      <div className="row">
        <label>
          Cron <input value={cron} onChange={(e) => setCron(e.target.value)} />
        </label>
        <button disabled={a.busy} onClick={() => void a.createSchedule(cron, Number(n) || 5)}>
          Add schedule
        </button>
      </div>
    </section>
  );
}

function ExperimentsSection({ wsId }: { wsId: string }) {
  const x = useExperiments(wsId);
  const f = x.form;
  const armFields = (key: 'a' | 'b', label: string) => (
    <fieldset>
      <legend>Arm {label}</legend>
      <label>
        Worker model{' '}
        <select value={f[key].model} onChange={(e) => x.setForm({ ...f, [key]: { ...f[key], model: e.target.value } })}>
          <option value="">task&apos;s model</option>
          {x.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        Worker prompt version{' '}
        <input
          placeholder="current"
          value={f[key].promptVersion}
          onChange={(e) => x.setForm({ ...f, [key]: { ...f[key], promptVersion: e.target.value } })}
        />
      </label>
    </fieldset>
  );
  return (
    <section>
      <h3>Experiments</h3>
      <p className="muted">
        Runs a finished task again under arm A and arm B (worker model and/or prompt version) through the normal review loop, with
        lessons off. Experiment results are kept apart: they add nothing to findings or metrics. Tasks that use the browser are off
        unless allowed in Settings, because their real-world actions repeat per arm and per repeat.
      </p>
      {x.error && <div className="error">{x.error}</div>}
      <div className="card">
        <label>
          Task{' '}
          <select value={f.taskId} onChange={(e) => x.setForm({ ...f, taskId: e.target.value })}>
            <option value="">choose a finished task</option>
            {x.sourceTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.type}
                {t.subject ? `: ${t.subject}` : ''} ({t.status})
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Name <input value={f.name} onChange={(e) => x.setForm({ ...f, name: e.target.value })} />
        </label>{' '}
        <label>
          Repeats{' '}
          <input type="number" min={1} max={5} value={f.repeats} onChange={(e) => x.setForm({ ...f, repeats: e.target.value })} style={{ width: '4em' }} />
        </label>
        {x.browserWarning && (
          <div className="warning">
            <p>{x.browserWarning}</p>
            {x.allowBrowser ? (
              <label>
                <input type="checkbox" checked={f.confirmBrowser === true} onChange={(e) => x.setForm({ ...f, confirmBrowser: e.target.checked })} /> I
                understand: these actions will be repeated
              </label>
            ) : (
              <p className="muted">Experiments on browser tasks are off (set experiments.allowBrowser in Settings).</p>
            )}
          </div>
        )}
        {armFields('a', 'A')}
        {armFields('b', 'B')}
        <button disabled={x.busy} onClick={() => void x.start()}>
          Start experiment
        </button>
        {x.actionError && <div className="error">{x.actionError}</div>}
      </div>
      {x.experiments.length > 0 && (
        <ul>
          {x.experiments.map((e) => (
            <li key={e.id}>
              <button className="link" onClick={() => x.select(e.id)}>
                {e.name ?? e.id}
              </button>{' '}
              <span className="muted small">
                {e.status} · {shortDate(e.createdAt)} · {e.arms.map((a) => `${a.arm}: ${modelLabel(a.model)}${a.promptVersion ? ` @${a.promptVersion}` : ''}`).join(' vs ')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {x.selected && <Comparison id={x.selected} />}
    </section>
  );
}

function Comparison({ id }: { id: string }) {
  const c = useExperimentComparison(id);
  if (c.error) return <div className="error">{c.error}</div>;
  if (!c.comparison) return <p className="muted">Loading experiment…</p>;
  const { experiment, arms } = c.comparison;
  return (
    <div className="card">
      <h4>
        {experiment.name ?? experiment.id} <span className="muted small">({experiment.status})</span>
      </h4>
      {experiment.failureReason && <div className="error">{experiment.failureReason}</div>}
      <table>
        <thead>
          <tr>
            <th />
            {arms.map((a) => (
              <th key={a.arm}>Arm {a.arm}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {c.rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              {r.cells.map((v, i) => (
                <td key={i}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
