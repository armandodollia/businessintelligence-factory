import { artifactUrl, useForm, useInterview } from '../logic/hooks.js';

export function Interview({ wsId }: { wsId: string }) {
  const iv = useInterview(wsId);
  const form = useForm({ text: '' });
  const send = async () => {
    const text = form.values.text;
    form.reset();
    // Put the text back when the server did not store the message.
    if (!(await iv.send(text))) form.set('text', text);
  };

  return (
    <div className="split">
      <div className="main">
        <h2>Interview</h2>
        {iv.error && <div className="error">{iv.error}</div>}
        <div className="transcript">
          {iv.turns.length === 0 && !iv.loading && (
            <p className="muted">Say hello — the interviewer will ask about your business.</p>
          )}
          {iv.turns.map((t) => (
            <div key={t.id} className={`turn ${t.role}`}>
              <span className="who">{t.role === 'user' ? 'You' : 'Interviewer'}</span>
              <div>{t.text}</div>
            </div>
          ))}
          {iv.sending && <div className="muted">interviewer is thinking…</div>}
        </div>
        <div className="composer">
          <textarea
            rows={3}
            value={form.values.text}
            onChange={(e) => form.set('text', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <button className="primary" disabled={iv.sending || !form.values.text.trim()} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>
      <aside>
        <h3>Coverage</h3>
        <ul className="plain">
          {Object.entries(iv.coverage).map(([topic, done]) => (
            <li key={topic}>
              {done ? '[x]' : '[ ]'} {topic.replace(/_/g, ' ')}
            </li>
          ))}
        </ul>
        <h3>Uploads (optional)</h3>
        <p className="muted">KPI exports, financials, decks, PDFs. Stored locally as evidence.</p>
        <input
          type="file"
          disabled={iv.uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void iv.upload(file);
            e.target.value = '';
          }}
        />
        {iv.uploading && <div className="muted">uploading…</div>}
        <ul className="plain">
          {iv.uploads.map((a) => (
            <li key={a.id}>
              <a href={artifactUrl(a.id)} target="_blank" rel="noreferrer">
                {a.title ?? a.path}
              </a>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
