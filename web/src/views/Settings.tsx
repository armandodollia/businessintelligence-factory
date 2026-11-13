import { shortDate } from '../logic/format.js';
import { useConfigEditor } from '../logic/hooks.js';

export function Settings() {
  const c = useConfigEditor();
  return (
    <div>
      <h2>Settings</h2>
      <p className="muted">Edits <code>bif.config.json</code> (providers, models, roles, loop, limits, browser, identity, action policy, scoring).</p>
      {c.error && <div className="error">{c.error}</div>}
      {c.loading && <div className="muted">loading…</div>}
      <p className="muted">
        Priority weights and the persona weight are edited on each workspace's Strategy page; a scoring change saved here
        also rescores every workspace and is logged as a decision.
      </p>
      <textarea className="code" rows={30} spellCheck={false} value={c.text} onChange={(e) => c.setText(e.target.value)} />
      {c.parseError && <div className="error">Invalid JSON: {c.parseError}</div>}
      <div className="row">
        <button className="primary" disabled={!c.dirty || !!c.parseError || c.saving} onClick={() => void c.save()}>
          {c.saving ? 'Saving…' : 'Save'}
        </button>
        <button disabled={!c.dirty} onClick={c.revert}>
          Revert
        </button>
        {c.savedAt && <span className="muted">saved {shortDate(c.savedAt)}</span>}
      </div>
    </div>
  );
}
