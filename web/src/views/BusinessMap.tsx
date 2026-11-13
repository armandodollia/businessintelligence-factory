import { formatValue, toggle, workspaceLabel } from '../logic/format.js';
import { useBusinessMap, useForm } from '../logic/hooks.js';
import { workspaceHref } from '../logic/router.js';
import type { Audience, ScopeLevel, TreeNode, UnitProposal, UnitProposalEdits } from '../logic/types.js';
import { CriteriaRatings } from './CriterionRating.js';
import { EvidenceList } from './EvidenceList.js';

export function BusinessMap({ wsId }: { wsId: string }) {
  const map = useBusinessMap(wsId);
  const proposed = map.proposals.filter((p) => p.status === 'proposed');
  const decided = map.proposals.filter((p) => p.status !== 'proposed');
  const rollup = map.rollup;
  const tag = (id: string) => (
    <a className="tag" href={workspaceHref(id)}>
      {map.workspaceName(id)}
    </a>
  );

  return (
    <div>
      <h2>Business map</h2>
      {map.error && <div className="error">{map.error}</div>}
      {map.loading && <div className="muted">loading…</div>}

      <section>
        <h3>Tree</h3>
        {map.tree ? <Tree node={map.tree} current={wsId} /> : !map.loading && <p className="muted">No tree.</p>}
      </section>

      <section>
        <h3>Mapping proposals ({proposed.length})</h3>
        {proposed.length === 0 && <p className="muted">No open proposals. Run research with the mapping phase to get some.</p>}
        {proposed.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            busy={map.busy}
            parentName={map.workspaceName(p.workspaceId)}
            accept={map.accept}
            reject={map.reject}
          />
        ))}
        {decided.length > 0 && (
          <details>
            <summary>Decided proposals ({decided.length})</summary>
            <ul>
              {decided.map((p) => (
                <li key={p.id}>
                  {p.name} — {p.status}
                  {p.childWorkspaceId && <> → {tag(p.childWorkspaceId)}</>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {rollup && (
        <section>
          <h3>Roll-up</h3>
          {map.crossCutting.length > 0 && (
            <div className="flag">
              <b>Possible company-wide issues</b>
              <ul>
                {map.crossCutting.map((g) => (
                  <li key={g.key}>
                    {g.title} — seen in {g.sourceWorkspaceIds.length} units: {g.sourceWorkspaceIds.map((id) => <span key={id}>{tag(id)} </span>)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <h4>Symptoms & strengths</h4>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>Title</th>
                <th>Criteria</th>
              </tr>
            </thead>
            <tbody>
              {rollup.symptoms.map((s) => (
                <tr key={s.id}>
                  <td>{tag(s.sourceWorkspaceId)}</td>
                  <td>{s.kind}</td>
                  <td>
                    {s.title}
                    <div className="muted">{s.detail}</div>
                  </td>
                  <td>
                    <CriteriaRatings
                      workspaceId={s.sourceWorkspaceId}
                      targetType="symptom"
                      targetId={s.id}
                      criteria={s.criteria}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Recommendations</h4>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Priority</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {[...rollup.recommendations]
                .sort((a, b) => b.priority - a.priority)
                .map((r) => (
                  <tr key={r.id}>
                    <td>{tag(r.sourceWorkspaceId)}</td>
                    <td>{formatValue(r.priority)}</td>
                    <td>
                      {r.title}
                      <div className="muted">{r.summary}</div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Tree({ node, current }: { node: TreeNode; current: string }) {
  return (
    <ul className="tree">
      <li>
        <a href={workspaceHref(node.workspace.id)} className={node.workspace.id === current ? 'current' : ''}>
          {workspaceLabel(node.workspace)}
        </a>
        {node.children.map((c) => (
          <Tree key={c.workspace.id} node={c} current={current} />
        ))}
      </li>
    </ul>
  );
}

const LEVELS: ScopeLevel[] = ['company', 'division', 'slice'];
const AUDIENCES: Audience[] = ['external', 'internal'];

function ProposalCard(props: {
  proposal: UnitProposal;
  parentName: string;
  busy: boolean;
  accept: (id: string, edits?: UnitProposalEdits) => Promise<void>;
  reject: (id: string, reason?: string) => Promise<void>;
}) {
  const p = props.proposal;
  const form = useForm({
    editing: false,
    name: p.name,
    description: p.description,
    level: p.level,
    audiences: p.audiences,
    reason: '',
  });
  const v = form.values;
  const edits: UnitProposalEdits = {
    ...(v.name !== p.name ? { name: v.name } : {}),
    ...(v.description !== p.description ? { description: v.description } : {}),
    ...(v.level !== p.level ? { level: v.level } : {}),
    ...(v.audiences.join() !== p.audiences.join() ? { audiences: v.audiences } : {}),
  };
  const hasEdits = Object.keys(edits).length > 0;

  return (
    <div className="card">
      <div>
        <b>{p.name}</b> <span className="tag">{p.level}</span> <span className="tag">{p.audiences.join('+')}</span>{' '}
        <span className="muted">under {props.parentName}</span>
      </div>
      <p>{p.description}</p>
      <p className="muted">Reasoning: {p.reasoning}</p>
      <EvidenceList ids={p.evidence} />
      {v.editing && (
        <div className="form">
          <label>
            Name <input value={v.name} onChange={(e) => form.set('name', e.target.value)} />
          </label>
          <label>
            Description <textarea rows={2} value={v.description} onChange={(e) => form.set('description', e.target.value)} />
          </label>
          <label>
            Level
            <select value={v.level} onChange={(e) => form.set('level', e.target.value as ScopeLevel)}>
              {LEVELS.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Audiences</legend>
            {AUDIENCES.map((a) => (
              <label key={a} className="inline">
                <input type="checkbox" checked={v.audiences.includes(a)} onChange={() => form.set('audiences', toggle(v.audiences, a))} />
                {a}
              </label>
            ))}
          </fieldset>
        </div>
      )}
      <div className="row">
        <button className="primary" disabled={props.busy} onClick={() => void props.accept(p.id, hasEdits ? edits : undefined)}>
          {hasEdits ? 'Accept with edits' : 'Accept'}
        </button>
        <button onClick={() => form.set('editing', !v.editing)}>{v.editing ? 'Hide edit' : 'Edit'}</button>
        <input placeholder="reject reason (optional)" value={v.reason} onChange={(e) => form.set('reason', e.target.value)} />
        <button disabled={props.busy} onClick={() => void props.reject(p.id, v.reason.trim() || undefined)}>
          Reject
        </button>
      </div>
    </div>
  );
}
