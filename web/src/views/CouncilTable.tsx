import { blockOnText, councilTable, memberCell, roundResult, useTaskCouncil } from '../logic/council.js';
import type { MergedIssue } from '../logic/types.js';

/**
 * Review council (design 2026-11-16-review-council-design.md §9): the council that reviewed a task.
 * Members down, rounds across; below the table the open issues of the latest round with who raised
 * each, what was shown as advice, the questions, and the follow-ups of every round.
 */
export function CouncilTable({ taskId, wsId }: { taskId: string; wsId: string }) {
  const c = useTaskCouncil(taskId, wsId);
  if (c.error) return <div className="error">{c.error}</div>;
  if (!c.view) return <div className="muted small">loading…</div>;
  const { view } = c;
  if (view.withheld) {
    const n = view.rounds.length;
    return <div className="muted small">{`${n} council round${n === 1 ? '' : 's'}, withheld while this research is private.`}</div>;
  }
  if (view.rounds.length === 0) return <div className="muted small">No council round is recorded for this task.</div>;
  const t = councilTable(view);
  const s = view.stage;
  return (
    <div className="council">
      {s && (
        <div className="muted small">
          {`Council: pass score ${s.passScore}, at most ${s.rounds} round${s.rounds === 1 ? '' : 's'}, ${blockOnText(s.blockOn)}, unavailable member: ${s.onUnavailable}`}
        </div>
      )}
      <table className="small">
        <thead>
          <tr>
            <th scope="col">Member</th>
            {t.rounds.map((r) => (
              <th key={r.round} scope="col">{`Round ${r.round}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map(({ member, cells }) => (
            <tr key={member.name}>
              <th scope="row">
                {member.name}{' '}
                <span className="muted">{`${member.provider}/${member.model} · ${member.lens}`}</span>{' '}
                {!member.blocking && <span className="tag">non-blocking</span>}
              </th>
              {cells.map((m, i) => (
                <td key={t.rounds[i]!.round} title={m?.reason}>
                  {memberCell(m)}
                  {m?.unsupportedScore && <span className="muted">{` (counted as ${m.countedScore}: no upheld issue backs it)`}</span>}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row">Result</th>
            {t.rounds.map((r) => (
              <td key={r.round}>{roundResult(r)}</td>
            ))}
          </tr>
        </tbody>
      </table>
      {t.rounds.map((r) => r.failed !== undefined && <div key={r.round} className="error small">{`Round ${r.round} did not count: ${r.failed}`}</div>)}
      {t.reasons.length > 0 && (
        <ul className="small muted" aria-label="Members without a score">
          {t.reasons.map((x) => (
            <li key={`${x.round}:${x.name}`}>{`Round ${x.round}, ${x.name}: ${x.state} (${x.reason})`}</li>
          ))}
        </ul>
      )}
      <Issues title="Open issues" issues={t.open} />
      <Issues title="Not blocking" issues={t.advisory} />
      <Texts title="Questions" verb="asked by" items={t.questions} />
      <Texts title="Follow-ups" verb="raised by" items={t.followUps} />
    </div>
  );
}

function Issues({ title, issues }: { title: string; issues: MergedIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="small">
      <b>{title}</b>
      <ul aria-label={title}>
        {issues.map((i) => (
          <li key={i.id}>
            <span className="tag">{i.id}</span> {i.class && <span className="tag">{i.class}</span>}{' '}
            {i.action && i.action !== 'fix' && <span className="tag strong">{i.action}</span>}
            {i.description}
            {i.where?.length ? ` (about ${i.where.join(', ')})` : ''} <span className="muted">{`raised by ${i.raisedBy.join(', ')}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Texts({ title, verb, items }: { title: string; verb: string; items: Array<{ text: string; raisedBy: string[]; round?: number }> }) {
  if (items.length === 0) return null;
  return (
    <div className="small">
      <b>{title}</b>
      <ul aria-label={title}>
        {items.map((x) => (
          <li key={x.text}>
            {x.text} <span className="muted">{`${verb} ${x.raisedBy.join(', ')}${x.round !== undefined ? ` (round ${x.round})` : ''}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
