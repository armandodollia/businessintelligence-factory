import { useState } from 'react';
import {
  blendText,
  CHECK_ANSWER_WORDS,
  correctableAnswers,
  flowLabel,
  personaLabel,
  scoreText,
  SOURCE_WORDS,
  STAGE_WORDS,
  stopText,
  STRENGTH_WORDS,
} from '../logic/flows.js';
import { formatValue, safeHref, shortDate } from '../logic/format.js';
import { useFlow } from '../logic/hooks.js';
import type { CheckAnswer, FlowDetailView, FlowReaction, FlowTypeRow } from '../logic/types.js';
import { ExternalLink, OverrideList, ReasonBox, reasonOf, StepStrip } from './flows/parts.js';

type Detail = ReturnType<typeof useFlow>;
type Verdict = FlowDetailView['verdicts'][number];
type Check = FlowDetailView['checks'][number];

/**
 * One flow and everything behind its position (spec §10.5): the scores and how they combine, the
 * steps as a strip, the checks with their answers and evidence, the reviews, the personas'
 * simulated verdicts (those not part of the score apart) and the user's rulings.
 */
export function FlowDetail({ wsId, flowId, flowTypes, onBack }: { wsId: string; flowId: string; flowTypes: FlowTypeRow[]; onBack: () => void }) {
  const f = useFlow(wsId, flowId);
  const d = f.detail;
  const back = (
    <button type="button" className="link" onClick={onBack}>
      ← back to the ranking
    </button>
  );
  if (f.error) {
    return (
      <div>
        {back}
        <div className="error">{f.error}</div>
      </div>
    );
  }
  if (!d) return <div className="muted">loading…</div>;
  const stepAnchor = (seq: number) => `flow-${d.flow.id}-step-${seq}`;

  return (
    <div className="flow-detail">
      {back}
      <h3>
        {d.subject.name} — {d.flow.name}
      </h3>
      <div className="small">
        {d.flow.variant && <span className="tag">{d.primary ? `main way: ${d.flow.variant}` : `other way: ${d.flow.variant}`}</span>}
        {d.partial && (
          <>
            <span className="tag">partial</span> <span className="muted">{stopText(d.flow)}</span>{' '}
          </>
        )}
        {!d.current && <span className="tag">earlier version</span>}
        {d.upload && <span className="tag upload">rests on material you uploaded</span>}
        <span className="muted">
          version {d.flow.version} · first seen {shortDate(d.flow.firstSeenAt)}
        </span>
      </div>
      <div>Goal: {d.flow.goal}</div>
      {d.flow.entryUrl && (
        <div className="small">
          Starts at{' '}
          <ExternalLink url={d.flow.entryUrl} />
        </div>
      )}
      {f.actionError && <div className="error">{f.actionError}</div>}
      {f.notice && <div className="small">{f.notice}</div>}

      <section>
        <h4>Why it is here</h4>
        <div>
          Checklist score <b>{scoreText(d.checklist)}</b> · personas (simulated){' '}
          <b>{d.persona === undefined ? 'no comparison' : scoreText(d.persona)}</b>
        </div>
        <div className="small muted">
          {d.persona === undefined
            ? 'No comparison: no persona verdict counts for this flow, so its position rests on the checklist alone.'
            : d.checklist === undefined
              ? 'Decided by personas: no check is answered yet, so its position rests on the personas’ simulated judgment alone.'
              : blendText(d.coverage, false, 'this flow type')}
        </div>
      </section>

      <section>
        <h4>Steps</h4>
        <StepStrip steps={d.steps} anchorOf={stepAnchor} />
        {d.flow.notable && <div className="small">Anything else notable: {d.flow.notable}</div>}
      </section>

      <section>
        <h4>Checks</h4>
        {d.checks.length === 0 && <p className="small muted">No check answered yet.</p>}
        {d.checks.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Question</th>
                <th>Answer</th>
                <th>Rests on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.checks.map((c) => (
                <CheckRow key={`${c.checklistId}:${c.itemKey}`} c={c} f={f} stepAnchor={stepAnchor} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4>Reviews ({d.mentions.length})</h4>
        {d.mentions.length === 0 && <p className="small muted">No review found for this flow.</p>}
        {d.mentions.map((m) => (
          <div key={m.id} className="feedback" data-mention={m.id}>
            <blockquote className="evidence-text">
              <pre>{m.quote}</pre>
            </blockquote>
            <div className="small muted">
              {SOURCE_WORDS[m.sourceType] ?? m.sourceType}
              {m.sourceUrl && (
                <>
                  {' '}
                  ·{' '}
                  <ExternalLink url={m.sourceUrl}>{safeHref(m.sourceUrl) ? 'source' : `source: ${m.sourceUrl}`}</ExternalLink>
                </>
              )}
              {m.publishedAt && ` · ${shortDate(m.publishedAt)}`} · {m.polarity}
              {m.rating !== undefined && ` · rated ${m.rating}`} ·{' '}
              {m.counted ? 'counted in the review numbers' : 'not counted (too old, or not clearly about this flow)'}
            </div>
            {m.checkKey && <div className="small muted">About the check: {questionOf(d, m.checkKey)}</div>}
            <NotAboutThis mentionId={m.id} d={d} f={f} flowTypes={flowTypes} />
          </div>
        ))}
      </section>

      <section>
        <h4>What the personas said (simulated)</h4>
        <p className="small muted">These are simulated judgments by personas, not evidence.</p>
        {d.verdicts.length === 0 && <p className="small muted">No comparison: no persona has judged this flow.</p>}
        {f.counted.map((v) => (
          <VerdictCard key={v.id} v={v} f={f} />
        ))}
        {f.uncounted.length > 0 && (
          <details className="uncounted">
            <summary>
              {f.uncounted.length} verdict{f.uncounted.length === 1 ? '' : 's'} not part of the score (the other flow is not in the current ranking)
            </summary>
            {f.uncounted.map((v) => (
              <VerdictCard key={v.id} v={v} f={f} />
            ))}
          </details>
        )}
      </section>

      <section>
        <h4>Your rulings</h4>
        {d.overrides.length === 0 && <p className="small muted">No ruling on this flow.</p>}
        <OverrideList overrides={d.overrides} actions={f} />
      </section>
    </div>
  );
}

function CheckRow({ c, f, stepAnchor }: { c: Check; f: Detail; stepAnchor: (seq: number) => string }) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<CheckAnswer>(c.answer);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const jump = (seq: number) => document.getElementById(stepAnchor(seq))?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  const save = async () => {
    const ok = await f.correctCheck({ checklistId: c.checklistId, itemKey: c.itemKey, answer, ...(note.trim() ? { note: note.trim() } : {}) }, reasonOf(reason));
    if (ok) setOpen(false);
  };
  return (
    <>
      <tr data-check={c.itemKey}>
        <td>
          {c.question}
          <div className="small muted">{c.scored ? 'counts in the score' : 'a fact for the personas, not scored'}</div>
        </td>
        <td>
          {CHECK_ANSWER_WORDS[c.answer]}
          {c.value !== undefined && <span className="muted"> ({formatValue(c.value)})</span>}
          {c.origin === 'user' && <div className="small muted">corrected by you</div>}
          {c.note && <div className="small">{c.note}</div>}
        </td>
        <td className="small">
          {c.stepRefs.map((seq) => (
            <button key={seq} type="button" className="link" onClick={() => jump(seq)}>
              step {seq}
            </button>
          ))}
          {c.stepRefs.length > 0 && c.mentionRefs.length > 0 && ' · '}
          {c.mentionRefs.length > 0 && <span>{`${c.mentionRefs.length} review${c.mentionRefs.length === 1 ? '' : 's'}`}</span>}
          {c.stepRefs.length === 0 && c.mentionRefs.length === 0 && <span className="muted">—</span>}
        </td>
        <td>
          <button type="button" className="link" onClick={() => setOpen(!open)}>
            correct
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4}>
            <div className="row wrap">
              <label className="small">
                The right answer{' '}
                <select aria-label="corrected answer" value={answer} onChange={(e) => setAnswer(e.currentTarget.value as CheckAnswer)}>
                  {[...new Set([c.answer, ...correctableAnswers(c.scored)])].map((a) => (
                    <option key={a} value={a}>
                      {CHECK_ANSWER_WORDS[a]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Note <input aria-label="note" maxLength={2000} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
              </label>
            </div>
            <ReasonBox value={reason} onChange={setReason} />
            <button type="button" disabled={f.busy} onClick={() => void save()}>
              Save answer
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

function VerdictCard({ v, f }: { v: Verdict; f: Detail }) {
  const [reason, setReason] = useState('');
  const d = f.detail!;
  const self = d.flow.id;
  const opponent = v.opponent.subject ? flowLabel(v.opponent.subject, v.opponent, false) : (v.opponent.name ?? 'another flow');
  const winnerId = v.winner === 'tie' ? null : v.winner === 'a' ? v.flowAId : v.flowBId;
  const outcome =
    winnerId === null
      ? `a tie with ${opponent}`
      : `${STRENGTH_WORDS[v.strength]} prefers ${winnerId === self ? `this flow over ${opponent}` : `${opponent} over this flow`}`;
  const react = (reaction: FlowReaction) =>
    void f.reactToVerdict(v.id, reaction, reasonOf(reason)).then((ok) => {
      if (ok) setReason('');
    });
  return (
    <div className="card simulated" data-verdict={v.id}>
      <div>
        <span className="tag">simulated</span> <b>{personaLabel(v.persona)}</b> {outcome}
      </div>
      <div className="small muted">
        {STAGE_WORDS[v.stage]} · confidence {Math.round(v.confidence * 100)}%
      </div>
      <div className="small">{v.reason}</div>
      <details>
        <summary className="small">agree / disagree</summary>
        <ReasonBox value={reason} onChange={setReason} />
        <div className="row">
          <button type="button" disabled={f.busy} onClick={() => react('agree')}>
            Agree
          </button>
          <button type="button" disabled={f.busy} onClick={() => react('disagree')}>
            Disagree
          </button>
        </div>
      </details>
    </div>
  );
}

const questionOf = (d: FlowDetailView, key: string) => d.checks.find((c) => c.itemKey === key)?.question ?? key;

type Target = 'no_flow' | 'other_check' | 'other_type';

/**
 * "Not about this": the user says a review is not about this flow (it stays on its subject only),
 * is about another check of this flow, or is about another flow type, with an optional reason.
 */
function NotAboutThis({ mentionId, d, f, flowTypes }: { mentionId: string; d: FlowDetailView; f: Detail; flowTypes: FlowTypeRow[] }) {
  const [target, setTarget] = useState<Target>('no_flow');
  const [checkKey, setCheckKey] = useState('');
  const [typeKey, setTypeKey] = useState('');
  const [reason, setReason] = useState('');
  const ownType = flowTypes.find((t) => t.id === d.flow.flowTypeId);
  const checks = [...new Map(d.checks.map((c) => [c.itemKey, c.question])).entries()];
  const otherTypes = flowTypes.filter((t) => t.id !== d.flow.flowTypeId);
  const input: { flowTypeKey?: string; checkKey?: string } | null =
    target === 'no_flow'
      ? {}
      : target === 'other_check'
        ? ownType && checkKey
          ? { flowTypeKey: ownType.key, checkKey }
          : null
        : typeKey
          ? { flowTypeKey: typeKey }
          : null;
  const choice = (value: Target, label: string, disabled = false) => (
    <label className="inline small">
      <input type="radio" name={`about-${mentionId}`} value={value} checked={target === value} disabled={disabled} onChange={() => setTarget(value)} />
      {label}
    </label>
  );
  return (
    <details className="small" data-attribution={mentionId}>
      <summary>not about this</summary>
      <div className="row wrap">
        {choice('no_flow', 'not about this flow')}
        {choice('other_check', 'about a different check', !ownType || checks.length === 0)}
        {choice('other_type', 'about a different flow type', otherTypes.length === 0)}
      </div>
      {target === 'other_check' && (
        <select aria-label="which check" value={checkKey} onChange={(e) => setCheckKey(e.currentTarget.value)}>
          <option value="">choose a check…</option>
          {checks.map(([key, question]) => (
            <option key={key} value={key}>
              {question}
            </option>
          ))}
        </select>
      )}
      {target === 'other_type' && (
        <select aria-label="which flow type" value={typeKey} onChange={(e) => setTypeKey(e.currentTarget.value)}>
          <option value="">choose a flow type…</option>
          {otherTypes.map((t) => (
            <option key={t.id} value={t.key}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <ReasonBox value={reason} onChange={setReason} />
      <button
        type="button"
        disabled={f.busy || input === null}
        onClick={() =>
          input &&
          void f.correctAttribution(mentionId, input, reasonOf(reason)).then((ok) => {
            if (ok) setReason('');
          })
        }
      >
        Save
      </button>
    </details>
  );
}
