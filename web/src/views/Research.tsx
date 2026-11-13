import { changedArtifactLabel, describeEvent, eventRunId, shortDate, summarize, toggle } from '../logic/format.js';
import { artifactUrl, useChanges, useDecisions, useForm, useResearch } from '../logic/hooks.js';
import { ALL_PHASES, OPTIONAL_PHASES, type ResearchPhase } from '../logic/types.js';
import { PendingRequests } from './PendingRequests.js';

export function Research({ wsId }: { wsId: string }) {
  const r = useResearch(wsId);
  const plan = useDecisions(wsId, 'task_proposal');
  const reviews = useDecisions(wsId, 'review');
  const form = useForm({ phases: [...ALL_PHASES] as ResearchPhase[] });
  const phases = form.values.phases;

  return (
    <div>
      <h2>Research</h2>
      <PendingRequests wsId={wsId} />
      {r.error && <div className="error">{r.error}</div>}

      <section>
        <h3>Start a run</h3>
        <div className="row wrap">
          {[...OPTIONAL_PHASES, ...ALL_PHASES].map((p) => (
            <label key={p} className="inline">
              <input type="checkbox" checked={phases.includes(p)} onChange={() => form.set('phases', toggle(phases, p))} />
              {p}
            </label>
          ))}
        </div>
        <button className="primary" disabled={r.starting || phases.length === 0} onClick={() => void r.start(phases)}>
          {r.starting ? 'Starting…' : 'Start research'}
        </button>
      </section>

      <WhatChanged wsId={wsId} />

      <section>
        <h3>Runs</h3>
        {r.runs.length === 0 && <p className="muted">No runs yet.</p>}
        <ul className="plain">
          {r.runs.map((run) => (
            <li key={run.id}>
              <button className={`link ${run.id === r.selectedRunId ? 'current' : ''}`} onClick={() => r.selectRun(run.id)}>
                {run.phase} — {run.status}
              </button>{' '}
              <span className="muted">
                {shortDate(run.startedAt)}
                {run.endedAt ? ` → ${shortDate(run.endedAt)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Tasks</h3>
        <table>
          <thead>
            <tr>
              <th>Phase</th>
              <th>Type</th>
              <th>Subject / brief</th>
              <th>Model</th>
              <th>Round</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {r.tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.phase}</td>
                <td>{t.type}</td>
                <td>
                  {t.subject && <b>{t.subject} </b>}
                  <span className="muted">{summarize(t.brief, 160)}</span>
                </td>
                <td>
                  {t.model.provider}/{t.model.model}
                </td>
                <td>{t.round}</td>
                <td>
                  <span className={`status ${t.status}`}>{t.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="split">
        <section className="main">
          <h3>Live</h3>
          <div className="log">
            {r.liveEvents.length === 0 && <div className="muted">waiting for events…</div>}
            {[...r.liveEvents].reverse().slice(0, 200).map((e, i) => (
              <div key={i} className={`log-line ${e.type}`}>
                <span className="muted">{eventRunId(e)?.slice(-6) ?? ''}</span> {describeEvent(e)}
              </div>
            ))}
          </div>
        </section>
        <aside>
          <h3>Orchestrator plan</h3>
          <ul className="plain small">
            {plan.decisions.slice(0, 20).map((d) => (
              <li key={d.id}>{summarize(d.payload, 200)}</li>
            ))}
          </ul>
          <h3>Review rounds</h3>
          <ul className="plain small">
            {reviews.decisions.slice(0, 30).map((d) => (
              <li key={d.id}>
                <span className="muted">{shortDate(d.createdAt)}</span> {summarize(d.payload, 200)}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function WhatChanged({ wsId }: { wsId: string }) {
  const { changes, error } = useChanges(wsId);
  return (
    <section>
      <h3>What changed</h3>
      <p className="muted">Differences between consecutive scheduled runs of the same phase.</p>
      {error && <div className="error">{error}</div>}
      {changes.length === 0 && <p className="muted">No scheduled runs compared yet.</p>}
      <ul className="plain">
        {changes.map((c) => (
          <li key={c.id}>
            <b>{c.scheduleName}</b> · {c.phase} <span className="muted">{shortDate(c.createdAt)}</span>
            {c.empty && <span className="muted"> — no changes</span>}
            {c.newFindings.length > 0 && <div className="small">{c.newFindings.length} new finding(s)</div>}
            {c.removedSubjects.length > 0 && (
              <div className="small">No longer found: {c.removedSubjects.join(', ')}</div>
            )}
            {c.changedArtifacts.map((a) => (
              <div key={`${a.subject ?? ''}:${a.flow}:${a.step}`} className="small">
                Screenshot changed: {changedArtifactLabel(a)} (<a href={artifactUrl(a.prev)} target="_blank" rel="noreferrer">before</a>
                {' / '}
                <a href={artifactUrl(a.next)} target="_blank" rel="noreferrer">after</a>)
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
