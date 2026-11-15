import { flowLabel, personaLabel, STAGE_WORDS, stopText, STRENGTH_WORDS } from '../../logic/flows.js';
import { useFlowCompare } from '../../logic/hooks.js';
import type { FlowCompareSide, FlowStep } from '../../logic/types.js';
import { StepCard } from './parts.js';

/** Two flows of one type side by side, step by step, with the personas' simulated verdicts on the pair. */
export function FlowCompare({ wsId, a, b, onBack }: { wsId: string; a: string; b: string; onBack: () => void }) {
  const { compare, loading, error } = useFlowCompare(wsId, a, b);
  const back = (
    <button type="button" className="link" onClick={onBack}>
      ← back to the ranking
    </button>
  );
  if (error) {
    return (
      <div>
        {back}
        <div className="error">{error}</div>
      </div>
    );
  }
  if (loading || !compare) return <div className="muted">loading…</div>;
  const sides = [compare.a, compare.b];
  const nameOf = (id: string) => {
    const s = sides.find((x) => x.flow.id === id);
    return s ? flowLabel(s.subject, s.flow, !s.primary) : 'another version';
  };
  const byStep = (s: FlowCompareSide) => new Map<number, FlowStep>(s.steps.map((st) => [st.seq, st]));
  const left = byStep(compare.a);
  const right = byStep(compare.b);
  const seqs = [...new Set([...left.keys(), ...right.keys()])].sort((x, y) => x - y);
  return (
    <div className="flow-compare">
      {back}
      <h3>
        {compare.flowType.name}: {nameOf(compare.a.flow.id)} and {nameOf(compare.b.flow.id)}
      </h3>
      <table>
        <thead>
          <tr>
            {sides.map((s) => (
              <th key={s.flow.id}>
                {flowLabel(s.subject, s.flow, true)} <span className="small muted">({s.steps.length} steps)</span>
                {s.partial && (
                  <>
                    {' '}
                    <span className="tag">partial</span> <span className="small muted">{stopText(s.flow)}</span>
                  </>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {seqs.map((seq) => (
            <tr key={seq}>
              {[left, right].map((m, i) => {
                const st = m.get(seq);
                return <td key={i}>{st ? <StepCard step={st} /> : <span className="small muted">no step {seq}</span>}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <h4>What the personas said about this pair (simulated)</h4>
      {compare.verdicts.length === 0 && <p className="small muted">No persona has judged this pair.</p>}
      {compare.verdicts.map((v) => (
        <div key={v.id} className="card simulated">
          <span className="tag">simulated</span> <b>{personaLabel(v.persona)}</b>:{' '}
          {v.winner === 'tie'
            ? 'a tie'
            : `${STRENGTH_WORDS[v.strength]} prefers ${nameOf(v.winner === 'a' ? v.flowAId : v.flowBId)}`}{' '}
          <span className="small muted">({STAGE_WORDS[v.stage]})</span>
          <div className="small">{v.reason}</div>
        </div>
      ))}
      {compare.overrides.map((o) => (
        <div key={o.id} className="card">
          Your ruling: <b>{o.winnerName}</b> is better than <b>{o.loserName}</b>
          {o.reason && <div className="small">Your reason: {o.reason}</div>}
          {o.needsConfirm && <div className="small">Waiting for you to say whether it still holds (see the ranking).</div>}
        </div>
      ))}
    </div>
  );
}
