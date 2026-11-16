import { formatValue } from '../../logic/format.js';
import type { useStakeholderPosition } from '../../logic/hooks.js';
import { BASIS_LABELS, words } from '../../logic/stakeholders.js';
import type { OpenStakeholderView } from '../../logic/types.js';
import { EvidenceList } from '../EvidenceList.js';

type Profile = OpenStakeholderView['profile'];

/**
 * The fields of a profile with confidence and evidence. With `basis` (by default: when a field has one),
 * a "Rests on" column says what each field rests on, and a recorded disagreement between what we knew
 * and what is public is shown under the value. Nothing for an empty profile. Every text is rendered as text.
 */
export function ProfileTable({ profile, basis }: { profile: Profile; basis?: boolean }) {
  const fields = Object.entries(profile);
  if (fields.length === 0) return null;
  const restsOn = basis ?? fields.some(([, f]) => f.basis !== undefined);
  return (
    <table>
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          <th>Confidence</th>
          {restsOn && <th>Rests on</th>}
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        {fields.map(([field, f]) => (
          <tr key={field}>
            <td>{words(field)}</td>
            <td>
              {f.value}
              {restsOn && f.conflict && <div className="small muted">{`Sources disagree: ${f.conflict}`}</div>}
            </td>
            <td>{formatValue(f.confidence)}</td>
            {restsOn && <td>{f.basis ? BASIS_LABELS[f.basis] : ''}</td>}
            <td>
              <details>
                <summary>{f.evidence.length}</summary>
                <EvidenceList ids={f.evidence} />
              </details>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The two layers of a former colleague (positions design §10), each in its own section: "What we knew"
 * (the profile as it was the day they left) and "What is public" (what research found on the web since).
 * Shown once loaded; the combined profile, written from both, is the card's own. Under "What is public"
 * a line says when the layer is not used (its research failed), used although its research was not
 * verified, or not combined yet.
 */
export function Layers({ v, p }: { v: OpenStakeholderView; p: ReturnType<typeof useStakeholderPosition> }) {
  if (!p.loaded) return null;
  return (
    <>
      <section aria-label={`what we knew about ${v.id}`}>
        <h4>What we knew</h4>
        {p.internalProfile ? <ProfileTable profile={p.internalProfile} basis={false} /> : <p className="small muted">Nothing stored.</p>}
      </section>
      <section aria-label={`what is public about ${v.id}`}>
        <h4>What is public</h4>
        {p.publicNotes.map((note) => (
          <p key={note} className="small muted">
            {note}
          </p>
        ))}
        {p.publicProfile ? <ProfileTable profile={p.publicProfile} basis={false} /> : <p className="small muted">Nothing found yet.</p>}
      </section>
    </>
  );
}
