import { shortDate } from '../logic/format.js';
import { useForm, useRequests } from '../logic/hooks.js';
import type { UserRequest } from '../logic/types.js';

/** Prominent banner of agent requests waiting on the user (register / login / captcha / approval). */
export function PendingRequests({ wsId }: { wsId: string }) {
  const { pending, resolve, resolving, error } = useRequests(wsId);
  if (pending.length === 0 && !error) return null;
  return (
    <section className="pending" aria-live="polite">
      <h3>
        Waiting on you ({pending.length})
      </h3>
      {error && <div className="error">{error}</div>}
      {pending.map((r) => (
        <RequestRow key={r.id} request={r} busy={resolving} resolve={resolve} />
      ))}
    </section>
  );
}

function RequestRow(props: {
  request: UserRequest;
  busy: boolean;
  resolve: (id: string, status: 'resolved' | 'denied', response?: string) => Promise<void>;
}) {
  const { request: r, busy, resolve } = props;
  const form = useForm({ response: '' });
  const response = form.values.response.trim() || undefined;
  const isApproval = r.kind === 'approval';
  return (
    <div className="request">
      <div>
        <span className="tag strong">{r.kind}</span> {r.site && <b>{r.site}</b>}{' '}
        <span className="muted">{shortDate(r.createdAt)}</span>
      </div>
      <div className="request-details">{r.details}</div>
      <div className="row">
        <input
          placeholder={isApproval ? 'note (optional)' : 'what you did / notes (optional)'}
          value={form.values.response}
          onChange={(e) => form.set('response', e.target.value)}
        />
        <button className="primary" disabled={busy} onClick={() => void resolve(r.id, 'resolved', response)}>
          {isApproval ? 'Approve' : 'Done'}
        </button>
        <button disabled={busy} onClick={() => void resolve(r.id, 'denied', response)}>
          {isApproval ? 'Deny' : "Can't / skip"}
        </button>
      </div>
    </div>
  );
}
