import { Fragment, useState } from 'react';
import { blendText, flowLabel, ignoredRulingsText, personaLabel, plural, reviewsText, scoreText, stopText, waitingText, winsText } from '../logic/flows.js';
import { useFlowChecklists, useFlowRanking, useFlowTypes } from '../logic/hooks.js';
import type { RankedFlowRow } from '../logic/types.js';
import { FlowDetail } from './FlowDetail.js';
import { ChecklistPanel } from './flows/ChecklistPanel.js';
import { FlowCompare } from './flows/FlowCompare.js';
import { FlowProposals } from './flows/FlowProposals.js';
import { OverrideList, RowBadges } from './flows/parts.js';
import { RowPanel, type RowMode } from './flows/RowPanel.js';

type Shown = { kind: 'ranking' } | { kind: 'flow'; flowId: string } | { kind: 'compare'; a: string; b: string };

/**
 * Flows (spec §12.2): flow types down the side with the proposals waiting on the user; for the
 * chosen type, the ranking with its explanation and the user's reactions and rulings, then its
 * checklists (`ChecklistPanel`, editable). A flow opens in `FlowDetail`; two flows open side by side
 * in `FlowCompare`.
 */
export function Flows({ wsId }: { wsId: string }) {
  const ft = useFlowTypes(wsId);
  const [picked, setPicked] = useState<string | null>(null);
  const [personaId, setPersonaId] = useState('');
  const [allVariants, setAllVariants] = useState(false);
  const [shown, setShown] = useState<Shown>({ kind: 'ranking' });
  const typeId =
    (picked && ft.types.some((t) => t.id === picked) ? picked : null) ??
    (ft.types.find((t) => t.status === 'active' && t.flowCount > 0) ?? ft.types.find((t) => t.status === 'active') ?? ft.types[0])?.id ??
    null;
  const fr = useFlowRanking(wsId, typeId, { ...(personaId ? { personaId } : {}), allVariants });
  const cl = useFlowChecklists(wsId, typeId);
  const typeName = ft.types.find((t) => t.id === typeId)?.name ?? 'this flow type';
  const back = () => setShown({ kind: 'ranking' });

  return (
    <div className="flows">
      <h2>Flows</h2>
      <p className="muted">
        How each company handles the jobs people come to do (signing up, signing in, paying…): walked step by step, checked against a checklist,
        and ranked.
      </p>
      {ft.error && <div className="error">{ft.error}</div>}
      <div className="flows-layout">
        <aside>
          <h3>Flow types</h3>
          {!ft.loading && ft.types.length === 0 && <p className="small muted">No flow types yet: they appear when research walks the flows.</p>}
          <ul className="plain">
            {ft.types.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className={`link${t.id === typeId ? ' current' : ''}`}
                  onClick={() => {
                    setPicked(t.id);
                    setShown({ kind: 'ranking' });
                  }}
                >
                  {t.name}
                </button>{' '}
                <span className="small muted">{plural(t.flowCount, 'flow')}</span> {t.status === 'proposed' && <span className="tag">proposed</span>}
              </li>
            ))}
          </ul>
          <FlowProposals
            ft={ft}
            onDecided={() => {
              void fr.reload();
              void cl.reload();
            }}
          />
        </aside>
        <div>
          {shown.kind === 'flow' && <FlowDetail key={shown.flowId} wsId={wsId} flowId={shown.flowId} flowTypes={ft.types} onBack={back} />}
          {shown.kind === 'compare' && <FlowCompare wsId={wsId} a={shown.a} b={shown.b} onBack={back} />}
          {shown.kind === 'ranking' && typeId && (
            <>
              <Ranking
                fr={fr}
                personaId={personaId}
                setPersonaId={setPersonaId}
                allVariants={allVariants}
                setAllVariants={setAllVariants}
                onOpen={(flowId) => setShown({ kind: 'flow', flowId })}
                onCompare={(a, b) => setShown({ kind: 'compare', a, b })}
              />
              <ChecklistPanel
                lists={{
                  ...cl,
                  // A saved checklist changes the scores: the ranking reloads too.
                  edit: async (...args: Parameters<typeof cl.edit>) => {
                    const ok = await cl.edit(...args);
                    if (ok) void fr.reload();
                    return ok;
                  },
                }}
                typeName={typeName}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Ranking({
  fr,
  personaId,
  setPersonaId,
  allVariants,
  setAllVariants,
  onOpen,
  onCompare,
}: {
  fr: ReturnType<typeof useFlowRanking>;
  personaId: string;
  setPersonaId: (id: string) => void;
  allVariants: boolean;
  setAllVariants: (on: boolean) => void;
  onOpen: (flowId: string) => void;
  onCompare: (a: string, b: string) => void;
}) {
  const [panel, setPanel] = useState<{ flowId: string; mode: RowMode } | null>(null);
  const r = fr.ranking;
  if (fr.error) return <div className="error">{fr.error}</div>;
  if (!r) return <div className="muted">loading…</div>;
  const rows = r.ranked;
  /** A proposed flow type: its flows are listed, not ranked, and take no reactions or rulings. */
  const unranked = !r.isRanked;
  const labelOf = (row: RankedFlowRow) => flowLabel(row.subject, row.flow, allVariants || !row.primary);
  const toggle = (flowId: string, mode: RowMode) => setPanel(panel?.flowId === flowId && panel.mode === mode ? null : { flowId, mode });
  const waiting = waitingText(r.pendingProposals);

  return (
    <div className="flow-ranking">
      <h3>{r.flowType.name}</h3>
      {r.flowType.definition && <div className="small muted">{r.flowType.definition}</div>}
      <div className="row wrap">
        {r.personas.length > 0 && (
          <label className="small">
            Judged by{' '}
            <select aria-label="persona filter" value={personaId} onChange={(e) => setPersonaId(e.currentTarget.value)}>
              <option value="">all personas</option>
              {r.personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {personaLabel(p)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="small inline">
          <input type="checkbox" checked={allVariants} onChange={(e) => setAllVariants(e.currentTarget.checked)} /> show every way through (not
          only each company's main one)
        </label>
      </div>
      {unranked && <div className="flag">Not ranked until you accept this flow type.</div>}
      {!unranked && r.noPersonas && (
        <div className="flag">No persona judgment: this part of the business has no usable persona yet, so the order rests on the checklist alone.</div>
      )}
      {personaId && <div className="small muted">Ranked on one persona's simulated verdicts only.</div>}
      {fr.actionError && <div className="error">{fr.actionError}</div>}
      {fr.notice && <div className="small">{fr.notice}</div>}
      {rows.length === 0 ? (
        <p className="muted">No flow of this type has been walked yet.</p>
      ) : (
        <table className="ranking">
          <thead>
            <tr>
              <th>#</th>
              <th>Flow</th>
              <th>Rank score</th>
              <th>Checklist</th>
              <th className="simulated">Personas (simulated)</th>
              <th>Reviews</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.flowId}>
                <tr data-flow={row.flowId}>
                  <td>{unranked ? '—' : row.position}</td>
                  <td>
                    <b>{labelOf(row)}</b>
                    <div className="small muted">{row.flow.name}</div>
                  </td>
                  <td>{scoreText(row.rankScore)}</td>
                  <td>{scoreText(row.checklist)}</td>
                  <td className="simulated">{winsText(row)}</td>
                  <td>{reviewsText(row.reviews)}</td>
                  <td>
                    {unranked ? (
                      row.partial && (
                        <div className="badges">
                          <span className="tag">partial</span>
                          <div className="small muted">{stopText(row.flow)}</div>
                        </div>
                      )
                    ) : (
                      <RowBadges row={row} ranked={rows} noPersonas={r.noPersonas} overrides={r.overrides} />
                    )}
                  </td>
                  <td className="small nowrap">
                    <button type="button" className="link" onClick={() => onOpen(row.flowId)}>
                      open
                    </button>
                    {rows.length > 1 && (
                      <>
                        {' · '}
                        <button type="button" className="link" onClick={() => toggle(row.flowId, 'compare')}>
                          compare
                        </button>
                      </>
                    )}
                    {!unranked && (
                      <>
                        {' · '}
                        <button type="button" className="link" onClick={() => toggle(row.flowId, 'react')}>
                          agree / disagree
                        </button>
                      </>
                    )}
                    {!unranked && rows.length > 1 && (
                      <>
                        {' · '}
                        <button type="button" className="link" onClick={() => toggle(row.flowId, 'override')}>
                          override
                        </button>
                      </>
                    )}
                  </td>
                </tr>
                {panel?.flowId === row.flowId && (
                  <tr className="row-panel">
                    <td colSpan={8}>
                      <RowPanel
                        key={panel.mode}
                        row={row}
                        mode={panel.mode}
                        others={rows.filter((o) => o.flowId !== row.flowId)}
                        labelOf={labelOf}
                        busy={fr.busy}
                        onReact={(reaction, reason) => fr.react(row.flowId, reaction, reason)}
                        onOverride={async (loser, reason) => {
                          const ok = await fr.override(row.flowId, loser, reason);
                          if (ok) setPanel(null);
                          return ok;
                        }}
                        onCompare={(other) => onCompare(row.flowId, other)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {!unranked && <p className="small muted">{blendText(r.coverage, r.noPersonas, r.flowType.name)}</p>}
      {ignoredRulingsText(r.ignoredOverrides).map((text) => (
        <div key={text} className="small">
          {text}
        </div>
      ))}
      {r.overrides.length > 0 && (
        <section>
          <h4>Your rulings</h4>
          <OverrideList overrides={r.overrides} actions={fr} />
        </section>
      )}
      {waiting && <p className="small">Waiting on you: {waiting}.</p>}
    </div>
  );
}
