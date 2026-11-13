import { shortDate, toggle } from '../logic/format.js';
import { useForm, useSchedules } from '../logic/hooks.js';
import { ALL_PHASES, type Phase } from '../logic/types.js';

const PHASES = ALL_PHASES.filter((p): p is Phase => p !== 'mapping');

export function Schedule({ wsId }: { wsId: string }) {
  const s = useSchedules(wsId);
  const form = useForm({ name: '', cron: '0 9 * * 1', phases: ['deep_dives'] as Phase[], enabled: true });
  const v = form.values;

  const create = async () => {
    if (await s.create({ name: v.name.trim(), cron: v.cron.trim(), phases: v.phases, enabled: v.enabled })) form.reset();
  };

  return (
    <div>
      <h2>Schedule</h2>
      <p className="muted">Recurring runs while the local server is running; missed runs execute on next start.</p>
      {s.error && <div className="error">{s.error}</div>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Cron</th>
            <th>Phases</th>
            <th>Last run</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          {s.schedules.map((x) => (
            <tr key={x.id}>
              <td>{x.name}</td>
              <td>
                <code>{x.cron}</code>
              </td>
              <td>{x.phases.join(', ')}</td>
              <td>{shortDate(x.lastRunAt) || 'never'}</td>
              <td>
                <input
                  type="checkbox"
                  checked={x.enabled}
                  disabled={s.saving}
                  onChange={() => void s.update(x.id, { enabled: !x.enabled })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>New schedule</h3>
      <div className="form">
        <label>
          Name <input placeholder="weekly competitor re-walk" value={v.name} onChange={(e) => form.set('name', e.target.value)} />
        </label>
        <label>
          Cron <input value={v.cron} onChange={(e) => form.set('cron', e.target.value)} />
        </label>
        <fieldset>
          <legend>Phases</legend>
          {PHASES.map((p) => (
            <label key={p} className="inline">
              <input type="checkbox" checked={v.phases.includes(p)} onChange={() => form.set('phases', toggle(v.phases, p))} />
              {p}
            </label>
          ))}
        </fieldset>
        <label className="inline">
          <input type="checkbox" checked={v.enabled} onChange={() => form.set('enabled', !v.enabled)} /> enabled
        </label>
        <button
          className="primary"
          disabled={s.saving || !v.name.trim() || !v.cron.trim() || v.phases.length === 0}
          onClick={() => void create()}
        >
          Add schedule
        </button>
      </div>
    </div>
  );
}
