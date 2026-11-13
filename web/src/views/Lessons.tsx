import { shortDate } from '../logic/format.js';
import { ACTION_LABELS, acceptEffect, effectVerdict, pctText, useLessons, type LessonProposal } from '../logic/lessons.js';

/**
 * Learning loop WP-E: lessons of this business tree. Proposals (rules from recurring signals, edits from
 * the weekly retro) wait for the user's accept or reject; accepted rules are in the role's prompt with a
 * tracking marker, and their effect is shown per prompt version.
 */
export function Lessons({ wsId }: { wsId: string }) {
  const l = useLessons(wsId);
  const s = l.page?.settings;
  return (
    <div>
      <h2>Lessons</h2>
      <p className="muted">
        Rules learned from review issues, outcomes, failures, policy denials, your feedback and knowledge-store signals, per role, for this
        whole business. Nothing reaches a prompt until you accept it.
      </p>
      {l.loadError && <div className="error">{l.loadError}</div>}
      {l.loading && !l.page && <p className="muted">Loading…</p>}
      {s && (
        <p className="small muted">
          {s.enabled ? 'Lessons on' : 'Lessons off (config lessons.enabled)'} · a rule is proposed after {s.minTasks} tasks · retired after{' '}
          {s.retireAfterCleanTasks} clean tasks · judged after {s.minEffectTasks} tasks · at most {s.maxRulesPerRole} per role · weekly retro{' '}
          {s.retro.enabled ? `(${s.retro.cron}${s.retro.nextAt ? `, next ${shortDate(s.retro.nextAt)}` : ''})` : 'off'}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={l.busy} onClick={() => void l.evaluate()}>
          Check signals now
        </button>
        <button type="button" disabled={l.busy || !s?.retro.enabled} onClick={() => void l.startRetro()}>
          Run retro now
        </button>
      </div>
      {l.error && <div className="error">{l.error}</div>}
      {l.notice && <div className="muted">{l.notice}</div>}

      <section>
        <h3>Waiting for you ({l.pending.length})</h3>
        {l.page && l.pending.length === 0 && <p className="muted">No proposals.</p>}
        {l.pending.map((p) => (
          <Proposal key={p.id} p={p} l={l} />
        ))}
      </section>

      <section>
        <h3>Active rules</h3>
        {l.page && l.page.roles.length > 0 && (
          <p className="small muted">{l.page.roles.map((r) => `${r.role}: ${r.active}/${r.cap} active, ${r.pending} pending`).join(' · ')}</p>
        )}
        {l.page && l.active.length === 0 && <p className="muted">No active rules.</p>}
        {l.active.map(({ rule, effect }) => (
          <div key={rule.id} className="card">
            <div>
              <span className="tag">{rule.role}</span>
              <span className="tag">
                {rule.marker}.v{rule.version}
              </span>
              <span className="tag">{rule.source === 'retro' ? 'retro' : rule.category}</span>
              {rule.text}
            </div>
            <div className="small muted">
              Accepted by {rule.actor} {shortDate(rule.changedAt)} · prompt {rule.promptVersionBefore ?? '—'} → {rule.promptVersionAfter ?? '—'} ·{' '}
              {rule.source === 'retro' ? 'no signal to measure (retro edit)' : effectVerdict(effect, s?.minEffectTasks)} · clean streak{' '}
              {effect.cleanStreak}
            </div>
            {effect.versions.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Prompt version</th>
                    <th>Rule</th>
                    <th>Tasks</th>
                    <th>With this category</th>
                    <th>Pass rate</th>
                    <th>Rating agreement</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {effect.versions.map((v) => (
                    <tr key={v.promptVersion}>
                      <td className="small">{v.promptVersion}</td>
                      <td>{v.ruleVersion ? `v${v.ruleVersion}` : '—'}</td>
                      <td>{v.tasks}</td>
                      <td>
                        {v.hits} ({pctText(v.rate)})
                      </td>
                      <td>{pctText(v.passRate)}</td>
                      <td>{pctText(v.agreeRate)}</td>
                      <td>${v.costUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <button type="button" disabled={l.busy} onClick={() => void l.proposeRetire(rule.id)}>
              Propose taking it out
            </button>
          </div>
        ))}
      </section>

      {l.past.length > 0 && (
        <section>
          <h3>Past rules</h3>
          {l.past.map(({ rule }) => (
            <div key={rule.id} className="small">
              <span className="tag">{rule.status}</span>
              <span className="tag">{rule.role}</span>
              {rule.marker}: {rule.text} <span className="muted">({rule.endedAt ? shortDate(rule.endedAt) : ''})</span>
            </div>
          ))}
        </section>
      )}

      <section>
        <h3>Retros</h3>
        {l.page && l.page.retros.length === 0 && <p className="muted">No retro yet.</p>}
        {l.page?.retros.map((r) => (
          <div key={r.id} className="card">
            <span className="tag">{r.status}</span>
            <span className="small muted">
              {shortDate(r.windowStart)} – {shortDate(r.windowEnd)} · {r.triggeredBy} · {r.proposalIds.length} proposal(s)
            </span>
            {r.summary && <div className="request-details">{r.summary}</div>}
            {r.failureReason && <div className="error">{r.failureReason}</div>}
          </div>
        ))}
      </section>

      {l.decided.length > 0 && (
        <section>
          <h3>Decided proposals</h3>
          {l.decided.map((p) => (
            <div key={p.id} className="small feedback">
              <span className="tag">{p.status}</span>
              <span className="tag">{ACTION_LABELS[p.action]}</span>
              <span className="tag">{p.role}</span>
              {p.text}
              <span className="muted">
                {' '}
                {p.actor ? `by ${p.actor} ` : ''}
                {p.decidedAt ? shortDate(p.decidedAt) : ''}
                {p.reason ? ` — ${p.reason}` : ''}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Proposal({ p, l }: { p: LessonProposal; l: ReturnType<typeof useLessons> }) {
  return (
    <div className="pending">
      <div>
        <span className="tag">{ACTION_LABELS[p.action]}</span>
        <span className="tag">{p.role}</span>
        <span className="tag">{p.source}</span>
        <b>{p.text}</b>
      </div>
      <div className="small">{p.rationale}</div>
      {p.evidence.length > 0 && (
        <ul className="small">
          {p.evidence.map((e) => (
            <li key={`${e.kind}:${e.id}`}>
              <span className="muted">
                {e.kind} {e.id}
                {e.taskId ? ` (task ${e.taskId})` : ''}
              </span>
              {e.quote ? <pre className="evidence-text">{e.quote}</pre> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="small muted">{acceptEffect(p)}</div>
      <div className="row">
        <input aria-label="reason" placeholder="Reason (optional)" value={l.reason(p.id)} onChange={(e) => l.setReason(p.id, e.target.value)} />
        <button type="button" disabled={l.busy} onClick={() => void l.accept(p.id)}>
          Accept
        </button>
        <button type="button" disabled={l.busy} onClick={() => void l.reject(p.id)}>
          Reject
        </button>
      </div>
    </div>
  );
}
