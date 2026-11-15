import { useState, type ReactNode } from 'react';
import { REASON_MAX, rowBadges, stopText } from '../../logic/flows.js';
import { safeHref, shortDate } from '../../logic/format.js';
import { artifactUrl } from '../../logic/hooks.js';
import type { FlowStep, RankedFlowRow, ServedOverride } from '../../logic/types.js';

/** The optional free-text reason every reaction carries (the server caps it at 2,000 characters). */
export function ReasonBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="reason-box">
      <span className="small muted">Why? (optional)</span>
      <textarea aria-label="reason" rows={2} maxLength={REASON_MAX} value={value} onChange={(e) => onChange(e.currentTarget.value)} />
      {value.length > REASON_MAX - 200 && (
        <span className="small muted">
          {value.length.toLocaleString('en-US')} / {REASON_MAX.toLocaleString('en-US')} characters
        </span>
      )}
    </label>
  );
}

/** A served address as a link when it is http(s), else as plain text (never a script link). */
export function ExternalLink({ url, children }: { url: string; children?: ReactNode }) {
  const href = safeHref(url);
  if (!href) return <span className="muted">{children ?? url}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children ?? url}
    </a>
  );
}

/** The trimmed reason, or undefined when none was written. */
export const reasonOf = (text: string): string | undefined => text.trim() || undefined;

/** Badges of one ranking row, with the stop reason of a partial flow and the reasons of the user's rulings. */
export function RowBadges({ row, ranked, noPersonas, overrides }: { row: RankedFlowRow; ranked: RankedFlowRow[]; noPersonas: boolean; overrides: ServedOverride[] }) {
  const badges = rowBadges(row, ranked, noPersonas);
  const reasons = overrides.filter((o) => (row.overriddenBy ?? []).includes(o.id) && o.reason).map((o) => o.reason!);
  return (
    <div className="badges">
      {badges.map((b) => (
        <span key={b} className={`tag${b === 'decided by personas' ? ' simulated' : ''}`}>
          {b}
        </span>
      ))}
      {row.partial && <div className="small muted">{stopText(row.flow)}</div>}
      {reasons.map((r, i) => (
        <div key={i} className="small">
          Your reason: {r}
        </div>
      ))}
    </div>
  );
}

/** One step: its screenshot, what was done, what was observed and what it asked for. */
export function StepCard({ step, anchor }: { step: FlowStep; anchor?: string }) {
  return (
    <div className="flow-step" id={anchor}>
      <div className="small muted">Step {step.seq}</div>
      {step.artifactId ? (
        <a href={artifactUrl(step.artifactId)} target="_blank" rel="noopener noreferrer" className="thumb">
          <img src={artifactUrl(step.artifactId)} alt={`screenshot of step ${step.seq}`} loading="lazy" />
        </a>
      ) : (
        <div className="small muted">no screenshot</div>
      )}
      <dl>
        <dt>What was done</dt>
        <dd>{step.action}</dd>
        <dt>What we saw</dt>
        <dd>{step.observation}</dd>
        {step.asked.length > 0 && (
          <>
            <dt>What it asked for</dt>
            <dd>{step.asked.join(', ')}</dd>
          </>
        )}
        {step.error && (
          <>
            <dt>Error</dt>
            <dd>{step.error}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** The steps of a flow as a strip, in order. */
export function StepStrip({ steps, anchorOf }: { steps: FlowStep[]; anchorOf?: (seq: number) => string }) {
  if (steps.length === 0) return <p className="muted">No steps recorded.</p>;
  return (
    <ol className="flow-steps" aria-label="steps">
      {[...steps]
        .sort((a, b) => a.seq - b.seq)
        .map((s) => (
          <li key={s.seq}>
            <StepCard step={s} {...(anchorOf ? { anchor: anchorOf(s.seq) } : {})} />
          </li>
        ))}
    </ol>
  );
}

type OverrideActions = {
  busy: boolean;
  revokeOverride: (id: string, reason?: string) => Promise<boolean>;
  confirmOverride: (id: string, keep: boolean, reason?: string) => Promise<boolean>;
};

/**
 * The user's rulings ("this one is better than that one"), named as the server serves them. A ruling
 * whose flow was walked again asks whether it still holds (keep / drop); any ruling can be removed.
 */
export function OverrideList({ overrides, actions }: { overrides: ServedOverride[]; actions: OverrideActions }) {
  if (overrides.length === 0) return null;
  return (
    <div className="overrides">
      {overrides.map((o) => (
        <OverrideItem key={o.id} o={o} actions={actions} />
      ))}
    </div>
  );
}

function OverrideItem({ o, actions }: { o: ServedOverride; actions: OverrideActions }) {
  const [reason, setReason] = useState('');
  return (
    <div className={o.needsConfirm ? 'pending' : 'card'} data-override={o.id}>
      <div>
        <b>{o.winnerName}</b> is better than <b>{o.loserName}</b>{' '}
        <span className="small muted">your ruling, {shortDate(o.createdAt)}</span>
      </div>
      {o.reason && <div className="small">Your reason: {o.reason}</div>}
      {o.needsConfirm ? (
        <div>
          <div>Still holds? One of these flows was walked again since you ruled.</div>
          <ReasonBox value={reason} onChange={setReason} />
          <div className="row">
            <button type="button" disabled={actions.busy} onClick={() => void actions.confirmOverride(o.id, true, reasonOf(reason))}>
              Keep
            </button>
            <button type="button" disabled={actions.busy} onClick={() => void actions.confirmOverride(o.id, false, reasonOf(reason))}>
              Drop
            </button>
          </div>
        </div>
      ) : (
        <details>
          <summary className="small">Remove this ruling</summary>
          <ReasonBox value={reason} onChange={setReason} />
          <button type="button" disabled={actions.busy} onClick={() => void actions.revokeOverride(o.id, reasonOf(reason))}>
            Remove ruling
          </button>
        </details>
      )}
    </div>
  );
}
