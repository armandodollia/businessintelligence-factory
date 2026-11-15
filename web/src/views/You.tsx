import { shortDate } from '../logic/format.js';
import { useUserPersona } from '../logic/hooks.js';
import { proposalLabel } from '../logic/personaLearning.js';
import type { UserInteraction, UserPersonaLine, UserPersonaView } from '../logic/types.js';
import { lineEvidenceText, nextRetroLine, statsLine, usedByLine } from '../logic/userPersona.js';
import { ProposalCard } from './personas/Learning.js';

type U = ReturnType<typeof useUserPersona>;

/**
 * The You page (user persona design §12): how the tool sees the person using it in this business — the
 * lines learned from their decisions, by field, each with Retire and the actions it rests on; proposals
 * of the last retro waiting for them (accept, edit, reject, with a reason); what the tool has seen them
 * do; and how far the next retro is. Lines change only in the weekly retro, and only when accepted.
 * Every text is rendered as text.
 */
export function You({ wsId }: { wsId: string }) {
  const u = useUserPersona(wsId);
  const v = u.view;
  return (
    <div>
      <h2>How the tool sees you</h2>
      <p className="muted">
        Learned from your decisions in this business: what you accept, reject, edit and correct, and why. The weekly retro proposes lines; nothing
        changes until you accept it.
      </p>
      {u.error && <div className="error">{u.error}</div>}
      {u.loading && !v && <p className="muted">Loading…</p>}
      {v && <Body v={v} u={u} />}
    </div>
  );
}

function Body({ v, u }: { v: UserPersonaView; u: U }) {
  const pending = v.proposals.filter((p) => p.status === 'pending');
  const decided = v.proposals.filter((p) => p.status !== 'pending');
  return (
    <>
      <p className="small muted">
        {usedByLine(v)} · {v.useInPrompts ? 'on' : 'off (config userPersona.useInPrompts)'}
        {!v.enabled && ' · learning off (config userPersona.enabled, lessons or the retro)'}
      </p>
      {u.actionError && <div className="error">{u.actionError}</div>}
      {u.evidenceError && <div className="error">{u.evidenceError}</div>}

      <section>
        {v.fields.length === 0 && <p className="muted">Nothing learned yet.</p>}
        {v.fields.map(({ field, lines }) => (
          <div key={field}>
            <h3>{field}</h3>
            {lines.map((line) => (
              <Line key={line.id} line={line} u={u} />
            ))}
          </div>
        ))}
      </section>

      {pending.length > 0 && (
        <section>
          <h3>Proposed by the retro{v.lastRun ? ` of ${shortDate(v.lastRun.createdAt)}` : ''}</h3>
          {v.lastRun?.assumption && <p>Assumption: {v.lastRun.assumption}</p>}
          {pending.map((p) => (
            <ProposalCard key={p.id} p={p} c={u}>
              <div className="small muted">{lineEvidenceText(p.evidence.length)}</div>
            </ProposalCard>
          ))}
        </section>
      )}

      <section>
        <h3>What the tool has seen you do</h3>
        <p>{statsLine(v.stats)}</p>
        <p className="small">{nextRetroLine(v.gate, pending.length > 0)}</p>
      </section>

      {decided.length > 0 && (
        <details>
          <summary className="small">Decided proposals ({decided.length})</summary>
          {decided.map((p) => (
            <div key={p.id} className="small feedback">
              <span className="tag">{p.status}</span>
              <span className="tag">{proposalLabel(p)}</span>
              {p.finalText ?? p.text}
              <span className="muted">
                {' '}
                {p.decidedAt ? shortDate(p.decidedAt) : ''}
                {p.reason ? ` — ${p.reason}` : ''}
              </span>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

function Line({ line, u }: { line: UserPersonaLine; u: U }) {
  const shown = u.evidenceShown(line);
  return (
    <section className="card" aria-label={`line ${line.marker}`}>
      <div>
        <span className="tag">
          {line.marker}.v{line.version}
        </span>
        {line.text}
      </div>
      <div className="small muted">
        {lineEvidenceText(line.evidence)}{' '}
        <button type="button" className="link" onClick={() => void u.toggleEvidence(line)}>
          {shown ? '▾ hide' : '▸ show'}
        </button>
      </div>
      {shown && <InteractionList interactions={u.evidenceOf(line)} />}
      <div className="row">
        <input aria-label={`reason for ${line.id}`} placeholder="Reason (optional)" value={u.reason(line.id)} onChange={(e) => u.setReason(line.id, e.target.value)} />
        <button type="button" disabled={u.busy} onClick={() => void u.retire(line)}>
          Retire
        </button>
      </div>
    </section>
  );
}

/** What the person did: the stance, the action, their reason and the date. */
function InteractionList({ interactions }: { interactions: UserInteraction[] | undefined }) {
  if (!interactions) return <div className="small muted">loading…</div>;
  if (interactions.length === 0) return <div className="small muted">No actions found.</div>;
  return (
    <ul className="small">
      {interactions.map((x) => (
        <li key={x.id}>
          <span className="tag">{x.stance}</span>
          {x.detail}
          {x.reason && <span className="muted"> — your reason: {x.reason}</span>}
          <span className="muted"> ({shortDate(x.at)})</span>
        </li>
      ))}
    </ul>
  );
}
