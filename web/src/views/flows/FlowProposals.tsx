import { useState } from 'react';
import { pct } from '../../logic/flows.js';
import type { useFlowTypes } from '../../logic/hooks.js';
import type { Checklist, FlowType } from '../../logic/types.js';
import { ReasonBox, reasonOf } from './parts.js';

type Types = ReturnType<typeof useFlowTypes>;

/**
 * "Waiting on you": proposed flow types (accept / edit / reject / merge) and proposed checklists
 * (accept, optionally with another coverage, or reject), each with an optional reason.
 * `onDecided` runs after a decision went through (the ranking reloads).
 */
export function FlowProposals({ ft, onDecided }: { ft: Types; onDecided: () => void }) {
  const { flowTypes, checklists } = ft.proposals;
  const n = flowTypes.length + checklists.length;
  return (
    <section className="flow-proposals">
      <h3>Waiting on you ({n})</h3>
      {n === 0 && <p className="small muted">Nothing to decide.</p>}
      {ft.actionError && <div className="error">{ft.actionError}</div>}
      {ft.notice && <div className="small">{ft.notice}</div>}
      {flowTypes.map((t) => (
        <TypeProposal key={t.id} t={t} ft={ft} onDecided={onDecided} />
      ))}
      {checklists.map((c) => (
        <ChecklistProposal key={c.id} c={c} ft={ft} onDecided={onDecided} />
      ))}
    </section>
  );
}

function TypeProposal({ t, ft, onDecided }: { t: FlowType; ft: Types; onDecided: () => void }) {
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.name);
  const [definition, setDefinition] = useState(t.definition);
  const targets = ft.types.filter((x) => x.id !== t.id && x.status === 'active');
  const [into, setInto] = useState('');
  const decide = async (decision: Parameters<Types['decideType']>[1]): Promise<boolean> => {
    const ok = await ft.decideType(t.id, decision, reasonOf(reason));
    if (ok) onDecided();
    return ok;
  };
  return (
    <div className="pending" data-proposal={t.id}>
      <div>
        <span className="tag">new flow type</span> <b>{t.name}</b>
      </div>
      <div className="small">{t.definition}</div>
      {editing && (
        <div className="form">
          <label>
            Name
            <input aria-label="flow type name" value={name} maxLength={200} onChange={(e) => setName(e.currentTarget.value)} />
          </label>
          <label>
            What the job is
            <textarea aria-label="flow type definition" rows={2} maxLength={1000} value={definition} onChange={(e) => setDefinition(e.currentTarget.value)} />
          </label>
        </div>
      )}
      <ReasonBox value={reason} onChange={setReason} />
      <div className="row wrap">
        <button type="button" disabled={ft.busy} onClick={() => void decide({ action: 'accept' })}>
          Accept
        </button>
        {editing ? (
          <button type="button" disabled={ft.busy} onClick={() => void decide({ action: 'edit', name, definition }).then((ok) => ok && setEditing(false))}>
            Save changes
          </button>
        ) : (
          <button type="button" disabled={ft.busy} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        <button type="button" disabled={ft.busy} onClick={() => void decide({ action: 'reject' })}>
          Reject
        </button>
      </div>
      {targets.length > 0 && (
        <div className="row wrap">
          <label className="small">
            Same job as{' '}
            <select aria-label="merge into" value={into} onChange={(e) => setInto(e.currentTarget.value)}>
              <option value="">choose a flow type…</option>
              {targets.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={ft.busy || !into} onClick={() => void decide({ action: 'merge', intoId: into })}>
            Merge
          </button>
        </div>
      )}
    </div>
  );
}

function ChecklistProposal({ c, ft, onDecided }: { c: Checklist; ft: Types; onDecided: () => void }) {
  const [reason, setReason] = useState('');
  const [coverage, setCoverage] = useState(String(Math.round(c.coverage * 100)));
  const typeName = c.flowTypeId ? (ft.types.find((t) => t.id === c.flowTypeId)?.name ?? 'a flow type') : 'every flow';
  const n = Number(coverage);
  const coverageOk = coverage.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100;
  const accept = async () => {
    const changed = coverageOk && n / 100 !== c.coverage;
    if (await ft.decideChecklist(c.id, changed ? { action: 'accept', coverage: n / 100 } : { action: 'accept' }, reasonOf(reason))) onDecided();
  };
  const reject = async () => {
    if (await ft.decideChecklist(c.id, { action: 'reject' }, reasonOf(reason))) onDecided();
  };
  return (
    <div className="pending" data-proposal={c.id}>
      <div>
        <span className="tag">checklist</span> <b>Checklist for {typeName}</b> <span className="small muted">version {c.version}</span>
      </div>
      <details>
        <summary className="small">
          {c.items.length} check{c.items.length === 1 ? '' : 's'}
        </summary>
        <ul className="small">
          {c.items.map((i) => (
            <li key={i.key}>
              {i.question} <span className="muted">{i.scored ? '(counts in the score)' : '(a fact for the personas, not scored)'}</span>
              {i.source && <span className="muted"> · source: {i.source}</span>}
            </li>
          ))}
        </ul>
      </details>
      <label className="small">
        How much of judging this flow the checks can settle (now {pct(c.coverage)}):{' '}
        <input aria-label="coverage" type="number" min={0} max={100} className="crit-input" value={coverage} onChange={(e) => setCoverage(e.currentTarget.value)} />%
      </label>
      <ReasonBox value={reason} onChange={setReason} />
      <div className="row">
        <button type="button" disabled={ft.busy || !coverageOk} onClick={() => void accept()}>
          Accept
        </button>
        <button type="button" disabled={ft.busy} onClick={() => void reject()}>
          Reject
        </button>
      </div>
    </div>
  );
}
