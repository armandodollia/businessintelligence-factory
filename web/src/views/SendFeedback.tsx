import { formatBytes, LEVELS, NEVER_INCLUDED, OFFERED_NOTE, OWN_WORDS_HINT, useFeedbackBundle } from '../logic/feedbackBundle.js';

/**
 * "Send feedback": makes the feedback bundle, one file the tester saves and sends by their own means.
 * Period, level, a note, a preview of what the file holds, then "Save".
 */
export function SendFeedback() {
  const f = useFeedbackBundle();
  const { choices, preview } = f;
  return (
    <div>
      <h2>Send feedback</h2>
      <p>
        This makes one file with the figures of how the tool worked for you: runs, failures, review rounds, costs, your ratings and
        decisions. The application sends nothing. You save the file and send it yourself.
      </p>

      <section>
        <h3>Period</h3>
        <div className="row">
          <label>
            From
            <input type="date" value={choices.since} onChange={(e) => f.set('since', e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={choices.until} onChange={(e) => f.set('until', e.target.value)} />
          </label>
          <span className="muted">Leave both empty for everything.</span>
        </div>
      </section>

      <section>
        <h3>What the file includes</h3>
        {LEVELS.map((l) => (
          <div key={l.level}>
            <label>
              <input type="radio" name="feedback-level" checked={choices.level === l.level} onChange={() => f.set('level', l.level)} />
              {l.label}
            </label>
            <div className="muted small">{l.includes}</div>
          </div>
        ))}
        <p data-testid="never-included">{NEVER_INCLUDED}</p>
      </section>

      <section>
        <h3>Note</h3>
        <label>
          Note (optional)
          <textarea rows={4} maxLength={4000} value={choices.note} onChange={(e) => f.set('note', e.target.value)} />
        </label>
        <p className="muted small">{OWN_WORDS_HINT}</p>
      </section>

      <div className="row">
        <button onClick={() => void f.makePreview()} disabled={f.busy !== null}>
          {f.busy === 'preview' ? 'Preparing…' : 'Preview'}
        </button>
        <button className="primary" onClick={() => void f.save()} disabled={!preview || f.busy !== null}>
          {f.busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        {!preview && <span className="muted">Preview the file first, then save it.</span>}
      </div>
      {f.error && <div className="error">{f.error}</div>}
      {f.offered && <p>{`${f.offered} was offered for saving. ${OFFERED_NOTE}`}</p>}

      {preview && (
        <section>
          <h3>Preview</h3>
          <p>File size: {formatBytes(preview.totalBytes)}, compressed.</p>
          <table className="small">
            <thead>
              <tr>
                <th>Section</th>
                <th>Rows</th>
                <th>Size before compression</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {preview.sections.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{s.rows}</td>
                  <td>{formatBytes(s.bytes)}</td>
                  <td>
                    <button onClick={() => void f.showRows(s.name)} disabled={f.busy !== null}>
                      Show first rows
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {f.firstRows && (
            <div>
              <div className="row">
                <b>First rows of {f.firstRows.section}</b>
                <button onClick={f.hideRows}>Hide</button>
              </div>
              {f.firstRows.rows.length === 0 ? <p className="muted">This section has no rows.</p> : <pre className="code">{JSON.stringify(f.firstRows.rows, null, 2)}</pre>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
