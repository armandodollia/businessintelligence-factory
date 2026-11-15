import { useState } from 'react';
import { pct } from '../../logic/flows.js';
import type { useFlowChecklists } from '../../logic/hooks.js';
import type { Checklist, ChecklistItemEdit } from '../../logic/types.js';
import { ReasonBox, reasonOf } from './parts.js';

type Lists = ReturnType<typeof useFlowChecklists>;

const ORIGIN_WORDS: Record<Checklist['origin'], string> = { builtin: 'built in', agent: 'drafted by an agent', user: 'edited by you' };

/**
 * "Checklist" (spec §10.1): the checks a flow of the chosen type is scored on, its own and the ones for
 * every flow, each with its question, whether it counts in the score and its weight, and how much of
 * the flow type the checklist can settle. The user can edit a checklist: change the coverage, a
 * check's weight or question, or remove a check, with an optional reason; saving makes a new version.
 * Adding checks is not offered here.
 */
export function ChecklistPanel({ lists, typeName }: { lists: Lists; typeName: string }) {
  const data = lists.checklists;
  return (
    <section className="flow-checklists">
      <h4>Checklist</h4>
      {lists.error && <div className="error">{lists.error}</div>}
      {lists.actionError && <div className="error">{lists.actionError}</div>}
      {lists.notice && <div className="small">{lists.notice}</div>}
      {!data && !lists.error && <div className="muted">loading…</div>}
      {data?.specific && <ChecklistCard key={data.specific.id} c={data.specific} title={`Checks for ${typeName}`} typeName={typeName} lists={lists} />}
      {data && <ChecklistCard key={data.general.id} c={data.general} title="Checks for every flow" typeName={typeName} lists={lists} general />}
    </section>
  );
}

/** Coverage in words: how much of judging the flow type the checklist can settle. */
function coverageText(c: Checklist, typeName: string, general: boolean): string {
  return general
    ? `For a flow type with no checks of its own, these checks settle about ${pct(c.coverage)} of judging it; the personas' simulated judgment counts for the rest.`
    : `These checks settle about ${pct(c.coverage)} of judging ${typeName}; the personas' simulated judgment counts for the rest.`;
}

type Draft = Record<string, { question: string; weight: string; remove: boolean }>;

const draftOf = (c: Checklist): Draft => Object.fromEntries(c.items.map((i) => [i.key, { question: i.question, weight: String(i.weight), remove: false }]));

function ChecklistCard({ c, title, typeName, lists, general = false }: { c: Checklist; title: string; typeName: string; lists: Lists; general?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(c));
  const [coverage, setCoverage] = useState(String(Math.round(c.coverage * 100)));
  const [reason, setReason] = useState('');
  const start = () => {
    setDraft(draftOf(c));
    setCoverage(String(Math.round(c.coverage * 100)));
    setReason('');
    setEditing(true);
  };
  const set = (key: string, patch: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [key]: { ...d[key]!, ...patch } }));

  // What the edit would send, and whether it can be sent.
  const items: ChecklistItemEdit[] = [];
  let valid = true;
  for (const i of c.items) {
    const d = draft[i.key];
    if (!d) continue;
    if (d.remove) {
      items.push({ key: i.key, remove: true });
      continue;
    }
    const edit: ChecklistItemEdit = { key: i.key };
    const weight = Number(d.weight);
    if (d.weight.trim() === '' || !Number.isFinite(weight) || weight <= 0 || weight > 100) valid = false;
    else if (weight !== i.weight) edit.weight = weight;
    const question = d.question.trim();
    if (!question) valid = false;
    else if (question !== i.question) edit.question = question;
    if (edit.weight !== undefined || edit.question !== undefined) items.push(edit);
  }
  const kept = c.items.filter((i) => !draft[i.key]?.remove).length;
  const n = Number(coverage);
  const coverageOk = coverage.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100;
  const coverageChanged = coverageOk && n / 100 !== c.coverage;
  const canSave = valid && coverageOk && kept > 0 && (items.length > 0 || coverageChanged);
  const save = async () => {
    const ok = await lists.edit(c.id, { ...(coverageChanged ? { coverage: n / 100 } : {}), items }, reasonOf(reason));
    if (ok) setEditing(false);
  };

  return (
    <div className="card" data-checklist={c.id}>
      <div>
        <b>{title}</b>{' '}
        <span className="small muted">
          version {c.version}, {ORIGIN_WORDS[c.origin]}
        </span>
      </div>
      {general && <div className="small muted">These checks apply to every flow type.</div>}
      <div className="small">{coverageText(c, typeName, general)}</div>
      <table className="checklist">
        <thead>
          <tr>
            <th>Check</th>
            <th>Score</th>
            <th>Weight</th>
            {editing && <th>Remove</th>}
          </tr>
        </thead>
        <tbody>
          {c.items.map((i) => {
            const d = draft[i.key]!;
            return (
              <tr key={i.key} className={editing && d.remove ? 'muted' : undefined}>
                <td>
                  {editing ? (
                    <input aria-label={`question of ${i.key}`} value={d.question} maxLength={500} disabled={d.remove} onChange={(e) => set(i.key, { question: e.currentTarget.value })} />
                  ) : (
                    i.question
                  )}
                </td>
                <td className="small">{i.scored ? 'counts in the score' : 'not scored (a fact for the personas)'}</td>
                <td>
                  {editing ? (
                    <input
                      aria-label={`weight of ${i.key}`}
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      className="crit-input"
                      value={d.weight}
                      disabled={d.remove}
                      onChange={(e) => set(i.key, { weight: e.currentTarget.value })}
                    />
                  ) : (
                    i.weight
                  )}
                </td>
                {editing && (
                  <td>
                    <input aria-label={`remove ${i.key}`} type="checkbox" checked={d.remove} onChange={(e) => set(i.key, { remove: e.currentTarget.checked })} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing ? (
        <div className="form">
          <label className="small">
            How much of judging {general ? 'a flow type with no checks of its own' : typeName} these checks can settle:{' '}
            <input
              aria-label="checklist coverage"
              type="number"
              min={0}
              max={100}
              className="crit-input"
              value={coverage}
              onChange={(e) => setCoverage(e.currentTarget.value)}
            />
            %
          </label>
          {kept === 0 && <div className="small error">Keep at least one check.</div>}
          <ReasonBox value={reason} onChange={setReason} />
          <div className="row">
            <button type="button" disabled={lists.busy || !canSave} onClick={() => void save()}>
              Save checklist
            </button>
            <button type="button" disabled={lists.busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={lists.busy} onClick={start}>
          Edit
        </button>
      )}
    </div>
  );
}
