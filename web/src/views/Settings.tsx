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
      <div className="row">
        <label>
          Persona weight in priority (simulated feedback; default 0)
          <input
            type="number"
            min={0}
            step={0.1}
            value={c.personaWeight}
            disabled={!!c.parseError}
            onChange={(e) => c.setPersonaWeight(Number(e.target.value))}
          />
        </label>
      </div>
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
