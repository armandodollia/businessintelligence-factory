import { useState } from 'react';
import { shortDate } from '../logic/format.js';
import { cliState, REPLACE_WARNING, useSetup } from '../logic/setup.js';
import type { CliCheck, SetupInfo } from '../logic/types.js';

/**
 * "This computer": the app version, where the data is, and the setup check (which agent CLIs are
 * installed and signed in, whether Chrome is there), with the button that writes the configuration
 * for what was found. Used on the Settings page; `onApplied` runs after the configuration was written.
 */
export function ThisComputer({ onApplied }: { onApplied?: () => void }) {
  const s = useSetup(onApplied);
  const [confirming, setConfirming] = useState(false);
  const info = s.info;
  return (
    <section>
      <h3>This computer</h3>
      {s.error && <div className="error">{s.error}</div>}
      {!info && s.busy === 'check' && <div className="muted">checking…</div>}
      {info && (
        <>
          <Folders info={info} busy={s.busy !== null} onOpen={() => void s.openFolder()} />
          {!info.available || !info.report ? (
            <p className="muted">The setup check is not available on this server.</p>
          ) : (
            <>
              <table className="small">
                <thead>
                  <tr>
                    <th>Needed</th>
                    <th>State</th>
                    <th>Version</th>
                    <th>Where</th>
                    <th>What to do</th>
                  </tr>
                </thead>
                <tbody>
                  {info.report.clis.map((c) => (
                    <CliRow key={c.id} cli={c} />
                  ))}
                  <tr>
                    <th scope="row">Google Chrome</th>
                    <td>
                      <span className={info.report.chrome.found ? 'status done' : 'status failed'}>{info.report.chrome.found ? 'found' : 'not found'}</span>
                    </td>
                    <td />
                    <td>{info.report.chrome.path ?? ''}</td>
                    <td>{info.report.chrome.howTo}</td>
                  </tr>
                </tbody>
              </table>
              <p className={info.report.canResearch ? undefined : 'error'}>{info.report.summary}</p>
              <p className="muted small">
                Checked {shortDate(info.report.checkedAt)}. The check runs each command's version and status commands. It starts no
                model and reads no login file.
              </p>
              <div className="row wrap">
                <button onClick={() => void s.checkAgain()} disabled={s.busy !== null}>
                  {s.busy === 'check' ? 'Checking…' : 'Check again'}
                </button>
                {!info.configExists && (
                  <button className="primary" onClick={() => void s.apply(false)} disabled={s.busy !== null}>
                    {s.busy === 'apply' ? 'Writing…' : 'Write the configuration for what was found'}
                  </button>
                )}
                {info.configExists && !confirming && (
                  <button onClick={() => setConfirming(true)} disabled={s.busy !== null}>
                    Replace the configuration with what was found
                  </button>
                )}
              </div>
              {info.configExists && confirming && (
                <div>
                  <p>{REPLACE_WARNING}</p>
                  <div className="row">
                    <button
                      className="primary"
                      disabled={s.busy !== null}
                      onClick={() => {
                        setConfirming(false);
                        void s.apply(true);
                      }}
                    >
                      Replace it
                    </button>
                    <button onClick={() => setConfirming(false)}>Cancel</button>
                  </div>
                </div>
              )}
              {s.notice && <p>{s.notice}</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}

function Folders({ info, busy, onOpen }: { info: SetupInfo; busy: boolean; onOpen: () => void }) {
  const f = info.folders;
  return (
    <div>
      <p>
        Version {info.version}. {info.packaged ? 'Your data, the configuration and the logs are in the application folder:' : 'Your data is in:'}{' '}
        <code>{f.open}</code>{' '}
        {info.canOpenFolder && (
          <button onClick={onOpen} disabled={busy}>
            Open folder
          </button>
        )}
      </p>
      <ul className="muted small">
        <li>
          Data: <code>{f.data}</code>
        </li>
        {f.config && (
          <li>
            Configuration: <code>{f.config}</code>
            {info.configExists ? '' : ' (not written yet: the defaults are in use)'}
          </li>
        )}
        {f.logs && (
          <li>
            Logs: <code>{f.logs}</code>
          </li>
        )}
        {f.browserProfile && (
          <li>
            Research browser profile: <code>{f.browserProfile}</code>
          </li>
        )}
      </ul>
    </div>
  );
}

function CliRow({ cli }: { cli: CliCheck }) {
  const state = cliState(cli);
  return (
    <tr>
      <th scope="row">{cli.name}</th>
      <td>
        <span className={cli.ready ? 'status done' : 'status failed'}>{state}</span>
      </td>
      <td>{cli.version ?? ''}</td>
      <td>
        {cli.path ?? ''}
        {cli.found && cli.onPath === false ? ' (not on PATH: found in a usual install folder)' : ''}
      </td>
      <td>
        {cli.problem && <div>{cli.problem}</div>}
        {cli.howTo && <div>{cli.howTo}</div>}
        {cli.runs && <div className="muted">{cli.signedInDetail}</div>}
      </td>
    </tr>
  );
}
