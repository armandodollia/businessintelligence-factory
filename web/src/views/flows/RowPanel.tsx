import { useState } from 'react';
import type { FlowReaction, RankedFlowRow } from '../../logic/types.js';
import { ReasonBox, reasonOf } from './parts.js';

export type RowMode = 'react' | 'override' | 'compare';

/**
 * The panel under a ranking row: agree / disagree with its position, rule that it is better than
 * another flow, or pick a flow to compare it with. Each reaction carries an optional reason.
 */
export function RowPanel({
  row,
  mode,
  others,
  labelOf,
  busy,
  onReact,
  onOverride,
  onCompare,
}: {
  row: RankedFlowRow;
  mode: RowMode;
  others: RankedFlowRow[];
  labelOf: (r: RankedFlowRow) => string;
  busy: boolean;
  onReact: (reaction: FlowReaction, reason?: string) => Promise<boolean>;
  onOverride: (loserFlowId: string, reason?: string) => Promise<boolean>;
  onCompare: (otherFlowId: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const name = labelOf(row);
  const pick = (aria: string) => (
    <select aria-label={aria} value={other} onChange={(e) => setOther(e.currentTarget.value)}>
      <option value="">choose a flow…</option>
      {others.map((o) => (
        <option key={o.flowId} value={o.flowId}>
          {o.position}. {labelOf(o)}
        </option>
      ))}
    </select>
  );
  if (mode === 'compare') {
    return (
      <div className="row wrap" data-panel="compare">
        Compare <b>{name}</b> with {pick('compare with')}
        <button type="button" disabled={!other} onClick={() => onCompare(other)}>
          Compare
        </button>
      </div>
    );
  }
  if (mode === 'override') {
    return (
      <div data-panel="override">
        <div className="row wrap">
          <b>{name}</b> is better than {pick('better than')}
        </div>
        <div className="small muted">Your ruling always wins over the scores. A new ruling on the same two flows replaces the earlier one.</div>
        <ReasonBox value={reason} onChange={setReason} />
        <button
          type="button"
          disabled={busy || !other}
          onClick={() =>
            void onOverride(other, reasonOf(reason)).then((ok) => {
              if (ok) setReason('');
            })
          }
        >
          Save ruling
        </button>
      </div>
    );
  }
  const react = (reaction: FlowReaction) =>
    void onReact(reaction, reasonOf(reason)).then((ok) => {
      if (ok) setReason('');
    });
  return (
    <div data-panel="react">
      <div>
        Is position {row.position} right for <b>{name}</b>?
      </div>
      <ReasonBox value={reason} onChange={setReason} />
      <div className="row">
        <button type="button" disabled={busy} onClick={() => react('agree')}>
          Agree
        </button>
        <button type="button" disabled={busy} onClick={() => react('disagree')}>
          Disagree
        </button>
      </div>
    </div>
  );
}
