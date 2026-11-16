import { blockOnText, onUnavailableText, useCouncilOverview } from '../logic/council.js';
import { shortDate } from '../logic/format.js';
import { useConfigEditor } from '../logic/hooks.js';
import type { CouncilOverview } from '../logic/types.js';

export function Settings() {
  const c = useConfigEditor();
  const council = useCouncilOverview(c.savedAt);
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
      <section>
        <h3>Review council</h3>
        {council.error && <div className="error">{council.error}</div>}
        {council.loaded && <CouncilSettings council={council.council} />}
      </section>
    </div>
  );
}

/** The configured council on the settings page: read-only, each member available or not and why. */
function CouncilSettings({ council }: { council: CouncilOverview | null }) {
  if (!council) {
    return (
      <p className="muted">
        No council is configured: every task type is reviewed by its single reviewer. To have a stage reviewed by several
        reviewers, add a <code>council</code> block (see the README).
      </p>
    );
  }
  const r = council.rounds;
  return (
    <div>
      <p>{`At most ${r} round${r === 1 ? '' : 's'}, pass score ${council.passScore}, ${blockOnText(council.blockOn)}, ${onUnavailableText(council.onUnavailable)}.`}</p>
      <table className="small">
        <thead>
          <tr>
            <th>Member</th>
            <th>CLI / model</th>
            <th>Lens</th>
            <th>Blocking</th>
            <th>On this machine</th>
            <th>Stages</th>
          </tr>
        </thead>
        <tbody>
          {council.members.map((m) => (
            <tr key={m.name}>
              <td>{m.name}</td>
              <td>{`${m.provider}/${m.model}${m.effort ? ` (effort ${m.effort})` : ''}`}</td>
              <td>{m.lens}</td>
              <td>{m.blocking ? 'yes' : 'no'}</td>
              <td className={m.available ? undefined : 'status failed'}>{m.available ? 'available' : `unavailable: ${m.reason ?? 'unknown'}`}</td>
              <td>{m.stages.length ? m.stages.join(', ') : 'not seated'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {council.stages.length === 0 ? (
        <p className="muted">No task type is reviewed by the council: name the stages under <code>council.stages</code>.</p>
      ) : (
        <table className="small">
          <thead>
            <tr>
              <th>Stage (task type)</th>
              <th>Seated members</th>
              <th>Rounds</th>
              <th>Pass score</th>
            </tr>
          </thead>
          <tbody>
            {council.stages.map((s) => (
              <tr key={s.taskType}>
                <td>{s.taskType}</td>
                <td>{s.members.join(', ')}</td>
                <td>{s.rounds}</td>
                <td>{s.passScore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        Read-only: edit the <code>council</code> block above. Available means this configuration can start the member (its
        provider is enabled and lists its model); a CLI that does not start is reported when the round runs. No other model
        ever takes a member's place.
      </p>
    </div>
  );
}
