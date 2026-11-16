import type { useStakeholderPosition } from '../../logic/hooks.js';
import {
  CHANGE_LABELS,
  ELSEWHERE,
  isCurrentOwn,
  isFormerColleague,
  localToday,
  MOVED_ON_LABEL,
  NOT_LISTED,
  OWN_CHANGES,
  positionLine,
  STAKEHOLDER_TYPES,
  words,
  type PositionDraft,
} from '../../logic/stakeholders.js';
import type { OpenStakeholderView, StakeholderPlaces, StakeholderType } from '../../logic/types.js';
import { EvidenceList } from '../EvidenceList.js';

type P = ReturnType<typeof useStakeholderPosition>;

/**
 * The position of a stakeholder (positions design §10). An own stakeholder: the "Position" line and
 * "Change position" (left, moved, promoted, demoted). A former colleague, at a competitor or parked: the
 * line, what research last saw of the person's position, "Moved to another company" (another competitor,
 * a company not listed, or elsewhere) and "Returned". Nothing for a competitor's stakeholder that never
 * worked here. A change the server refused (for example 409: the name is in use where the person goes)
 * is said in the form, in the server's words. Every text is rendered as text.
 */
export function Position({ v, p, places }: { v: OpenStakeholderView; p: P; places: StakeholderPlaces }) {
  const former = isFormerColleague(v);
  const own = isCurrentOwn(v);
  if (!former && !own) return null;
  return (
    <>
      <div className="small">
        {p.error && <div className="error">{p.error}</div>}
        <div>{positionLine(v, p.positions)}</div>
        {v.publicPosition && (
          <div>
            {`What research last saw: ${v.publicPosition.text}`}
            <details>
              <summary>{`evidence (${v.publicPosition.evidence.length})`}</summary>
              <EvidenceList ids={v.publicPosition.evidence} />
            </details>
          </div>
        )}
      </div>
      {p.draft ? (
        <Form v={v} p={p} d={p.draft} places={places} />
      ) : (
        <div className="row small">
          {own && (
            <button type="button" className="link" onClick={() => p.open('change')}>
              Change position
            </button>
          )}
          {former && (
            <button type="button" className="link" onClick={() => p.open('movedOn')}>
              {MOVED_ON_LABEL}
            </button>
          )}
          {former && (
            <button type="button" className="link" onClick={() => p.open('returned')}>
              {CHANGE_LABELS.returned}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** The form of one change: what changed (an own stakeholder), the date, where to, and a note; why the server refused it, if it did. */
function Form({ v, p, d, places }: { v: OpenStakeholderView; p: P; d: PositionDraft; places: StakeholderPlaces }) {
  return (
    <fieldset className="form" aria-label={`position of ${v.id}`}>
      {d.form === 'change' && (
        <label>
          What changed
          <select value={d.change} onChange={(e) => p.setChange(e.target.value as PositionDraft['change'])}>
            {OWN_CHANGES.map((c) => (
              <option key={c} value={c} disabled={c === 'moved' && p.otherNodes.length === 0}>
                {CHANGE_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Date
        <input type="date" max={localToday()} value={d.date} onChange={(e) => p.set({ date: e.target.value })} />
      </label>
      {d.change === 'left' ? <Destination p={p} d={d} /> : <Place p={p} d={d} places={places} />}
      <label>
        Note
        <textarea maxLength={2000} value={d.note} onChange={(e) => p.set({ note: e.target.value })} />
      </label>
      {p.actionError && <div className="error">{p.actionError}</div>}
      <div className="row">
        <button type="button" className="primary" disabled={p.busy || !p.canSave} onClick={() => void p.save()}>
          Save
        </button>
        <button type="button" onClick={p.close}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

/** "New name": optional; the way out when the server answers that the name is in use where the person goes. */
function NewName({ p, d, placeholder }: { p: P; d: PositionDraft; placeholder: string }) {
  return (
    <label>
      New name
      <input maxLength={80} placeholder={placeholder} value={d.label} onChange={(e) => p.set({ label: e.target.value })} />
    </label>
  );
}

/**
 * Left, or moved on to another company: a competitor of the tree (for a former colleague not the one it
 * is at), a company not listed (it becomes a competitor) or elsewhere; and a new name for the stakeholder.
 */
function Destination({ p, d }: { p: P; d: PositionDraft }) {
  return (
    <>
      <label>
        Where to
        <select value={d.destination} onChange={(e) => p.set({ destination: e.target.value })}>
          {p.competitors.map((c) => (
            <option key={c.competitorId} value={c.competitorId}>
              {c.name}
            </option>
          ))}
          <option value={NOT_LISTED}>A company not listed</option>
          <option value={ELSEWHERE}>Elsewhere</option>
        </select>
      </label>
      {(d.destination === NOT_LISTED || d.destination === ELSEWHERE) && (
        <label>
          Company name
          <input
            maxLength={80}
            placeholder={d.destination === ELSEWHERE ? 'Optional' : ''}
            value={d.companyName}
            onChange={(e) => p.set({ companyName: e.target.value })}
          />
        </label>
      )}
      {d.destination === NOT_LISTED && (
        <label>
          Site
          <input maxLength={300} placeholder="Optional" value={d.site} onChange={(e) => p.set({ site: e.target.value })} />
        </label>
      )}
      <NewName
        p={p}
        d={d}
        placeholder={d.form === 'change' ? "Optional: the person's name, if this stakeholder is named by its role" : 'Optional: if the name is in use there'}
      />
      <label>
        Title there
        <input maxLength={300} placeholder="Optional" value={d.title} onChange={(e) => p.set({ title: e.target.value })} />
      </label>
    </>
  );
}

/** Moved, promoted, demoted, returned: the team or division, the type and the title; for a return also a new name. */
function Place({ p, d, places }: { p: P; d: PositionDraft; places: StakeholderPlaces }) {
  // A move goes to another node; a promotion or demotion may; a return names any node of the tree.
  const nodes = d.change === 'returned' ? places.nodes : p.otherNodes;
  return (
    <>
      {nodes.length > 0 && (
        <label>
          Team or division
          <select value={d.toWorkspaceId} onChange={(e) => p.set({ toWorkspaceId: e.target.value })}>
            {(d.change === 'promoted' || d.change === 'demoted') && <option value="">Stays here</option>}
            {nodes.map((n) => (
              <option key={n.workspaceId} value={n.workspaceId}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Type
        <select value={d.stakeholderType} onChange={(e) => p.set({ stakeholderType: e.target.value as StakeholderType })}>
          {STAKEHOLDER_TYPES.map((t) => (
            <option key={t} value={t}>
              {words(t)}
            </option>
          ))}
        </select>
      </label>
      {d.change === 'returned' && <NewName p={p} d={d} placeholder="Optional: if the name is in use there" />}
      <label>
        Title
        <input maxLength={300} placeholder="Optional" value={d.title} onChange={(e) => p.set({ title: e.target.value })} />
      </label>
    </>
  );
}
