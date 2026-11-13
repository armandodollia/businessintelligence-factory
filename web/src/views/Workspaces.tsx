import { orderAsTree, shortDate, toggle, workspaceLabel } from '../logic/format.js';
import { useForm, useWorkspaces } from '../logic/hooks.js';
import { workspaceHref } from '../logic/router.js';
import type { Audience, ScopeLevel } from '../logic/types.js';

const LEVELS: ScopeLevel[] = ['company', 'division', 'slice'];
const AUDIENCES: Audience[] = ['external', 'internal'];

export function Workspaces() {
  const { workspaces, loading, error, create, creating } = useWorkspaces();
  const form = useForm({
    name: '',
    sector: '',
    level: 'company' as ScopeLevel,
    scopeName: '',
    description: '',
    audiences: ['external'] as Audience[],
    parentWorkspaceId: '',
  });
  const v = form.values;

  const submit = async () => {
    const created = await create({
      name: v.name.trim(),
      sector: v.sector.trim(),
      scope: { level: v.level, name: v.scopeName.trim() || v.name.trim(), description: v.description.trim() },
      audiences: v.audiences,
      ...(v.parentWorkspaceId ? { parentWorkspaceId: v.parentWorkspaceId } : {}),
    });
    if (created) form.reset();
  };

  return (
    <div>
      <h2>Workspaces</h2>
      {error && <div className="error">{error}</div>}
      {loading && <div className="muted">loading…</div>}
      {!loading && workspaces.length === 0 && <p className="muted">No workspaces yet.</p>}
      <ul className="tree">
        {orderAsTree(workspaces).map(({ workspace: w, depth }) => (
          <li key={w.id} style={{ paddingLeft: `${depth * 1.5}em` }}>
            <a href={workspaceHref(w.id)}>{workspaceLabel(w)}</a>{' '}
            <span className="muted">
              {w.sector} · {shortDate(w.createdAt)}
            </span>{' '}
            <a href={workspaceHref(w.id, 'interview')}>interview</a>{' '}
            <a href={workspaceHref(w.id, 'research')}>research</a>
          </li>
        ))}
      </ul>

      <h3>New workspace</h3>
      <div className="form">
        <label>
          Name <input value={v.name} onChange={(e) => form.set('name', e.target.value)} />
        </label>
        <label>
          Sector <input value={v.sector} onChange={(e) => form.set('sector', e.target.value)} />
        </label>
        <label>
          Scope
          <select value={v.level} onChange={(e) => form.set('level', e.target.value as ScopeLevel)}>
            {LEVELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label>
          Scope name <input placeholder="defaults to name" value={v.scopeName} onChange={(e) => form.set('scopeName', e.target.value)} />
        </label>
        <label>
          Description
          <textarea rows={2} value={v.description} onChange={(e) => form.set('description', e.target.value)} />
        </label>
        <fieldset>
          <legend>Audiences</legend>
          {AUDIENCES.map((a) => (
            <label key={a} className="inline">
              <input
                type="checkbox"
                checked={v.audiences.includes(a)}
                onChange={() => form.set('audiences', toggle(v.audiences, a))}
              />
              {a}
            </label>
          ))}
        </fieldset>
        <label>
          Parent
          <select value={v.parentWorkspaceId} onChange={(e) => form.set('parentWorkspaceId', e.target.value)}>
            <option value="">(none — new business)</option>
            {orderAsTree(workspaces).map(({ workspace: w, depth }) => (
              <option key={w.id} value={w.id}>
                {'  '.repeat(depth)}
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={creating || !v.name.trim() || v.audiences.length === 0}
          onClick={() => void submit()}
        >
          Create
        </button>
      </div>
    </div>
  );
}
