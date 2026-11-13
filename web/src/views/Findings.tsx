import { shortDate } from '../logic/format.js';
import { useFindings } from '../logic/hooks.js';
import type { Symptom } from '../logic/types.js';
import { CriteriaRatings } from './CriterionRating.js';
import { EvidenceList } from './EvidenceList.js';

export function Findings({ wsId }: { wsId: string }) {
  const f = useFindings(wsId);
  return (
    <div>
      <h2>Findings & Evidence</h2>
      {f.error && <div className="error">{f.error}</div>}
      {f.loading && <div className="muted">loading…</div>}

      <div className="split even">
        <SymptomList wsId={wsId} title="What's going badly" items={f.symptoms} />
        <SymptomList wsId={wsId} title="What's going well" items={f.strengths} />
      </div>

      <h3>Findings ({f.findings.length})</h3>
      {f.findings.map((x) => (
        <div key={x.id} className="card">
          <div>
            <b>{x.subject}</b> <span className={`status ${x.status}`}>{x.status}</span>{' '}
            <span className="muted">{shortDate(x.createdAt)}</span>
          </div>
          <p>{x.claim}</p>
          <CriteriaRatings workspaceId={wsId} targetType="finding" targetId={x.id} criteria={x.criteria} />
          <EvidenceList ids={x.evidence} />
        </div>
      ))}
    </div>
  );
}

function SymptomList({ wsId, title, items }: { wsId: string; title: string; items: Symptom[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {items.length === 0 && <p className="muted">none yet</p>}
      {items.map((s) => (
        <div key={s.id} className="card">
          <b>{s.title}</b>
          <p className="muted">{s.detail}</p>
          <CriteriaRatings workspaceId={wsId} targetType="symptom" targetId={s.id} criteria={s.criteria} />
          {s.evidence.length > 0 && <EvidenceList ids={s.evidence} />}
        </div>
      ))}
    </section>
  );
}
