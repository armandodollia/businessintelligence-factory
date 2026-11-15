import type { ReactNode } from 'react';
import { shortDate } from '../../logic/format.js';
import type { usePersonaLearning } from '../../logic/hooks.js';
import { citedSignals, editable, effectLine, evidenceLine, gateLines, proposalLabel, reactionsLine } from '../../logic/personaLearning.js';
import type { PersonaLearningEntry, PersonaProposal, PersonaSignal } from '../../logic/types.js';

type L = ReturnType<typeof usePersonaLearning>;

/**
 * "What the tool has learned" on a persona card (persona learning design §14): the user's reactions
 * not yet used by a retro and what the gate says, the last retro's assumption, proposals waiting for the
 * user (accept, edit, reject, with a reason), active adjustments with their effect (retire), and the
 * signals on demand. Every text is rendered as text. Nothing when the persona has no entry (not loaded,
 * or an older server).
 */
export function Learning({ personaId, l }: { personaId: string; l: L }) {
  const entry = l.entryOf(personaId);
  return entry ? <Block entry={entry} l={l} /> : null;
}

function Block({ entry, l }: { entry: PersonaLearningEntry; l: L }) {
  const pending = entry.proposals.filter((p) => p.status === 'pending');
  const decided = entry.proposals.filter((p) => p.status !== 'pending');
  const allKey = `${entry.personaId}:all`;
  const signals = l.signalsOf(entry.personaId);
  return (
    <section className="learning" aria-label={`what the tool has learned about ${entry.personaId}`}>
      <h4>What the tool has learned</h4>
      <p className="small muted">From your reactions to this persona's simulated judgements; changes only in the weekly retro, and only when you accept them.</p>
      <div>
        {reactionsLine(entry.gate)}{' '}
        <button type="button" className="link" onClick={() => void l.toggleSignals(allKey, entry.personaId)}>
          {l.signalsShown(allKey) ? '▾ hide' : '▸ show'}
        </button>
      </div>
      {l.signalsShown(allKey) && <SignalList signals={signals} />}
      {gateLines(entry.gate, pending.length > 0).map((line) => (
        <div key={line} className="small">
          {line}
        </div>
      ))}
      {entry.lastRun?.assumption && (
        <p>
          Assumption (retro of {shortDate(entry.lastRun.createdAt)}): {entry.lastRun.assumption}
        </p>
      )}
      {pending.map((p) => (
        <Pending key={p.id} p={p} personaId={entry.personaId} l={l} />
      ))}
      {entry.adjustments.map((a) => (
        <div key={a.id} className="card">
          <div>
            <span className="tag">Active</span>
            <span className="tag">
              {a.marker}.v{a.version}
            </span>
            {a.field && <span className="tag">{a.field}</span>}
            {a.text}
          </div>
          <div className="small muted">{effectLine(a.effect)}</div>
          <div className="row">
            <input aria-label={`reason for ${a.id}`} placeholder="Reason (optional)" value={l.reason(a.id)} onChange={(e) => l.setReason(a.id, e.target.value)} />
            <button type="button" disabled={l.busy} onClick={() => void l.retire(a)}>
              Retire
            </button>
          </div>
        </div>
      ))}
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
                {p.actor ? `by ${p.actor} ` : ''}
                {p.decidedAt ? shortDate(p.decidedAt) : ''}
                {p.reason ? ` — ${p.reason}` : ''}
              </span>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

function Pending({ p, personaId, l }: { p: PersonaProposal; personaId: string; l: L }) {
  const key = `${personaId}:${p.id}`;
  const signals = l.signalsOf(personaId);
  return (
    <ProposalCard p={p} c={l}>
      <div className="small muted">
        {evidenceLine(p, signals)}{' '}
        <button type="button" className="link" onClick={() => void l.toggleSignals(key, personaId)}>
          {l.signalsShown(key) ? '▾ hide' : '▸ show'}
        </button>
      </div>
      {l.signalsShown(key) && <SignalList signals={signals && citedSignals(p, signals)} />}
    </ProposalCard>
  );
}

/** What a page holding proposals offers for each: its edit box, its reason box, Accept / Edit / Reject. */
export type ProposalControls = {
  edit: (id: string) => string | undefined;
  startEdit: (p: PersonaProposal) => void;
  setEdit: (id: string, v: string) => void;
  reason: (id: string) => string;
  setReason: (id: string, v: string) => void;
  canAccept: (id: string) => boolean;
  accept: (p: PersonaProposal) => Promise<boolean>;
  reject: (p: PersonaProposal) => Promise<boolean>;
  busy: boolean;
};

/**
 * A pending proposal: its action and field, its text (or the edit box), its rationale, `children` (what
 * it rests on), and a reason box with Accept / Edit / Reject. Every text is rendered as text. Shared by
 * the persona cards and the You page.
 */
export function ProposalCard({ p, c, children }: { p: PersonaProposal; c: ProposalControls; children?: ReactNode }) {
  const edit = c.edit(p.id);
  return (
    <div className="pending">
      <div>
        <span className="tag">Proposed</span>
        <span className="tag">{proposalLabel(p)}</span>
        {p.source === 'engine' && <span className="tag">not helping</span>}
      </div>
      {edit === undefined ? (
        <div>
          <b>"{p.text}"</b>
        </div>
      ) : (
        <textarea aria-label={`text of ${p.id}`} value={edit} maxLength={400} onChange={(e) => c.setEdit(p.id, e.target.value)} />
      )}
      {p.rationale && <div className="small">{p.rationale}</div>}
      {children}
      <div className="row">
        <input aria-label={`reason for ${p.id}`} placeholder="Reason (optional)" value={c.reason(p.id)} onChange={(e) => c.setReason(p.id, e.target.value)} />
        <button type="button" disabled={c.busy || !c.canAccept(p.id)} onClick={() => void c.accept(p)}>
          Accept
        </button>
        {editable(p) && edit === undefined && (
          <button type="button" disabled={c.busy} onClick={() => c.startEdit(p)}>
            Edit
          </button>
        )}
        <button type="button" disabled={c.busy} onClick={() => void c.reject(p)}>
          Reject
        </button>
      </div>
    </div>
  );
}

/** The signals: what the persona said, what the user did, and the user's reason. */
function SignalList({ signals }: { signals: PersonaSignal[] | undefined }) {
  if (!signals) return <div className="small muted">loading…</div>;
  if (signals.length === 0) return <div className="small muted">No reactions.</div>;
  return (
    <ul className="small">
      {signals.map((s) => (
        <li key={s.id}>
          <span className="tag">{s.polarity}</span>
          {s.detail}
          {s.reason && <span className="muted"> — your reason: {s.reason}</span>}
          <span className="muted"> ({shortDate(s.at)})</span>
        </li>
      ))}
    </ul>
  );
}
