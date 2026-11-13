/**
 * Knowledge view (design §17; knowledge store KS-7). Markup only: state and actions come from
 * `useKnowledgeView`. Stored text is rendered as plain text, never as HTML; evidence is shown as
 * untrusted text with its artifact id; upload-derived items are marked with why the export leaves
 * them out.
 */
import {
  formatBytes, itemFields, itemPart, parseEvidence, useKnowledgeView,
  type EvidenceText, type FactRow, type KnowledgeScope, type SearchHit, type UploadMark,
} from '../logic/knowledge.js';

type View = ReturnType<typeof useKnowledgeView>;

export function Knowledge({ wsId }: { wsId: string }) {
  const k = useKnowledgeView(wsId);
  return (
    <div className="knowledge">
      <h2>Knowledge</h2>
      <ScopeToggle k={k} />
      {k.stats && (
        <p className="muted small">
          {k.stats.facts.usable} usable facts ({k.stats.facts.stale} stale, {k.stats.facts.candidate} unverified updates, {k.stats.facts.conflicts} conflicts),{' '}
          {k.stats.artifacts} documents, {k.stats.entities} entities, {k.stats.openMergeSuggestions} merge suggestions
        </p>
      )}
      {k.actionError && <div className="error">{k.actionError}</div>}
      {k.notice && <div className="muted">{k.notice}</div>}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          k.runSearch();
        }}
      >
        <input aria-label="search the knowledge store" value={k.query} onChange={(e) => k.setQuery(e.currentTarget.value)} placeholder="Search facts, documents, entities…" />
        <button type="submit">Search</button>
      </form>
      {k.searchError && <div className="error">{k.searchError}</div>}
      {k.search && <SearchResults k={k} />}

      <div className="split">
        <section>
          {k.itemId && <ItemDetail k={k} />}
          {!k.itemId && k.entityId && <EntityCard k={k} />}
          {!k.itemId && !k.entityId && <p className="muted">Pick an entity or a search hit to see its card and evidence.</p>}
        </section>
        <section>
          <h3>Entities ({k.entities.length})</h3>
          {k.entitiesError && <div className="error">{k.entitiesError}</div>}
          <ul className="links">
            {k.entities.map((e) => (
              <li key={e.id}>
                <button className="link" onClick={() => k.openEntity(e.id)}>
                  {e.name}
                </button>{' '}
                <span className="tag">{e.kind}</span>
                <span className="muted small">{e.facts} facts</span> <Source source={e.source} />
                <Upload mark={e} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <MergeSuggestions k={k} />
      <FactLists k={k} />
      <Changes k={k} />
      <Storage k={k} />
    </div>
  );
}

function ScopeToggle({ k }: { k: View }) {
  return (
    <fieldset className="row scope-toggle">
      {(['node', 'tree'] as KnowledgeScope[]).map((s) => (
        <label key={s}>
          <input type="radio" name="knowledge-scope" checked={k.scope === s} onChange={() => k.setScope(s)} /> {k.scopeLabels[s]}
        </label>
      ))}
    </fieldset>
  );
}

function Source({ source }: { source?: string | undefined }) {
  return source ? <span className="tag">from {source}</span> : null;
}

/** Visible marker of an upload-derived item, with why the export leaves it out by default. */
function Upload({ mark }: { mark: UploadMark & { flags?: string[] } }) {
  if (!mark.upload && !mark.flags?.includes('upload')) return null;
  return (
    <span className="upload-mark">
      <span className="tag upload">upload-derived</span>
      {mark.uploadWhy && <span className="muted small"> excluded from export by default: {mark.uploadWhy}</span>}
    </span>
  );
}

/** Evidence as plain, untrusted text (never HTML). */
function Evidence({ e }: { e: EvidenceText }) {
  return (
    <div className="evidence-text">
      <div className="muted small">evidence{e.artifactId ? ` from ${e.artifactId}` : ''} (untrusted text)</div>
      <pre>{e.text}</pre>
    </div>
  );
}

function SearchResults({ k }: { k: View }) {
  const r = k.search!;
  return (
    <section>
      <h3>
        Results for “{r.query}” ({SCOPE_TEXT[r.scope]}){r.relaxed ? ' — no exact match, showing any-word matches' : ''}
      </h3>
      {r.hits.length === 0 && <p className="muted">no matches</p>}
      {r.hits.map((h) => (
        <Hit key={`${h.kind}:${h.id}`} h={h} open={() => k.openItem(h.id)} />
      ))}
      {(r.notes ?? []).map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}
    </section>
  );
}

const SCOPE_TEXT: Record<KnowledgeScope, string> = { node: 'this part of the business', tree: 'whole business' };

function Hit({ h, open }: { h: SearchHit; open: () => void }) {
  return (
    <div className="card">
      <span className="tag">{h.type ?? h.kind}</span>{' '}
      <button className="link" onClick={open}>
        {h.title ?? h.id}
      </button>{' '}
      <Source source={h.source} />
      {(h.flags ?? []).filter((f) => f !== 'upload').map((f) => (
        <span key={f} className="tag">
          {f}
        </span>
      ))}
      {h.entity && <span className="muted small"> · {h.entity.name}</span>}
      <Upload mark={h} />
      {h.snippet && <Evidence e={parseEvidence(h.snippet)} />}
    </div>
  );
}

function EntityCard({ k }: { k: View }) {
  if (k.cardError) return <div className="error">{k.cardError}</div>;
  const c = k.card;
  if (!c) return <div className="muted">loading…</div>;
  return (
    <div className="card">
      <h3>
        {c.entity?.name} <span className="tag">{c.entity?.kind}</span> {c.entity && <span className="muted small">home {c.entity.home}</span>}
      </h3>
      {c.entity?.upload && <Upload mark={{ upload: true }} />}
      {c.entity?.aliases && <p className="muted small">also known as {c.entity.aliases.join(', ')}</p>}
      <ul className="card-lines">
        {c.lines.map((l, i) => (
          <li key={i}>
            <CardLine text={typeof l === 'string' ? l : l.text} open={k.openItem} />
          </li>
        ))}
      </ul>
      {c.truncated && <p className="muted small">{c.more ?? 0} more lines left out</p>}
    </div>
  );
}

/** A card line; `[id]` references become buttons that open the item. Text stays plain text. */
function CardLine({ text, open }: { text: string; open: (id: string) => void }) {
  const parts = text.split(/(\[(?:fnd|art|chk|ent|cmp|per|sym|hyp|rec)_[A-Za-z0-9]+\])/);
  return (
    <>
      {parts.map((p, i) =>
        /^\[[a-z]+_[A-Za-z0-9]+\]$/.test(p) ? (
          <button key={i} className="link" onClick={() => open(p.slice(1, -1))}>
            {p}
          </button>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function ItemDetail({ k }: { k: View }) {
  if (k.itemError) return <div className="error">{k.itemError}</div>;
  const it = k.item;
  if (!it) return <div className="muted">loading…</div>;
  const isFact = it.kind === 'fact';
  return (
    <div className="card">
      <div className="row">
        <button className="link" onClick={k.closeItem}>
          ← back
        </button>
        <span className="tag">{String(it.kind ?? 'item')}</span> <b>{String(it.id ?? k.itemId)}</b> <Source source={it.source} />
      </div>
      <Upload mark={{ ...(it.upload ? { upload: true as const } : {}), ...(it.uploadWhy ? { uploadWhy: it.uploadWhy } : {}) }} />
      <dl className="fields">
        {itemFields(it).map((f) => (
          <div key={f.key}>
            <dt>{f.key.replace(/_/g, ' ')}</dt>
            <dd>{f.evidence ? <Evidence e={f.evidence} /> : f.value}</dd>
          </div>
        ))}
      </dl>
      {isFact && it.lifecycle === 'current' && (
        <button disabled={k.busy} onClick={() => void k.retractFact(String(it.id))}>
          Retract this fact
        </button>
      )}
      {isFact && it.lifecycle === 'current' && (
        <div className="row">
          <label>
            Duplicate of (fact id){' '}
            <input value={k.duplicateOf} onChange={(e) => k.setDuplicateOf(e.target.value)} placeholder="fnd_…" />
          </label>
          <button disabled={k.busy || !k.duplicateOf.trim()} onClick={() => void k.retractAsDuplicate(String(it.id))}>
            Retract as a duplicate
          </button>
        </div>
      )}
      <ul className="item-parts">
        {(it.items ?? []).map((raw, i) => {
          const p = itemPart(raw);
          return (
            <li key={i}>
              <span className="tag">{p.label}</span>
              {p.text && <span> {p.text}</span>} <Source source={p.source} />
              {p.outside && <span className="muted small"> (outside this part of the business: switch to whole business)</span>}
              {p.open && (
                <button className="link" onClick={() => k.openItem(p.open!)}>
                  open
                </button>
              )}
              {p.label === 'unverified update' && p.open && (
                <button disabled={k.busy} onClick={() => void k.acceptReplacement(p.open!)}>
                  Apply this update
                </button>
              )}
              {(p.evidence ?? []).map((e, j) => (
                <Evidence key={j} e={e} />
              ))}
            </li>
          );
        })}
      </ul>
      {(it.notes ?? []).map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}
    </div>
  );
}

function MergeSuggestions({ k }: { k: View }) {
  if (!k.suggestions.length) return null;
  return (
    <section>
      <h3>Merge suggestions ({k.suggestions.length})</h3>
      {k.suggestions.map((s) => (
        <div key={s.id} className="card">
          “{s.entity.name}” <span className="tag">{s.entity.kind}</span> may be the same as “{s.candidate.name}” <span className="tag">{s.candidate.kind}</span>{' '}
          <span className="muted small">similarity {s.score}</span> <Upload mark={s} />
          <div className="row">
            <button disabled={k.busy} onClick={() => void k.acceptSuggestion(s.id)}>
              Merge
            </button>
            <button disabled={k.busy} onClick={() => void k.rejectSuggestion(s.id)}>
              Not the same
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function FactList({ title, rows, k, action }: { title: string; rows: FactRow[]; k: View; action?: { label: string; run: (id: string) => void } }) {
  return (
    <section>
      <h3>
        {title} ({rows.length})
      </h3>
      {rows.length === 0 && <p className="muted">none</p>}
      {rows.map((f) => (
        <div key={f.id} className="card">
          <button className="link" onClick={() => k.openItem(f.id)}>
            {f.claim}
          </button>{' '}
          {f.entity && <span className="muted small">{f.entity.name} · </span>}
          <span className="muted small">
            v{f.version} {f.lifecycle} · {f.status} · confirmed {f.lastConfirmedAt ? f.lastConfirmedAt.slice(0, 10) : 'never'} · age {f.ageDays} / ttl {f.ttlDays} days
          </span>{' '}
          <Source source={f.source} />
          <Upload mark={f} />
          {action && (
            <button disabled={k.busy} onClick={() => action.run(f.id)}>
              {action.label}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

function FactLists({ k }: { k: View }) {
  return (
    <div className="split even">
      <FactList title="Stale facts" rows={k.stale?.facts ?? []} k={k} />
      <div>
        <FactList title="Conflicts" rows={k.conflicts?.conflicts ?? []} k={k} />
        <FactList title="Unverified updates" rows={k.conflicts?.unverifiedUpdates ?? []} k={k} action={{ label: 'Apply', run: (id) => void k.acceptReplacement(id) }} />
      </div>
    </div>
  );
}

function Changes({ k }: { k: View }) {
  const changes = k.changes?.changes ?? [];
  return (
    <section>
      <h3>Recent changes ({changes.length})</h3>
      {changes.length === 0 && <p className="muted">nothing changed recently</p>}
      <ul className="links">
        {changes.map((c, i) => (
          <li key={i}>
            <span className="tag">{String(c.change ?? 'change')}</span> {changeText(c)} {c.upload === true && <span className="tag upload">upload-derived</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function changeText(c: Record<string, unknown>): string {
  const claim = (v: unknown) => (v && typeof v === 'object' && 'claim' in v ? String((v as { claim: unknown }).claim) : '');
  if (c.change === 'replaced') return `${claim(c.from)} → ${claim(c.to)}`;
  return String(c.claim ?? c.id ?? c.artifact_id ?? '');
}

function Storage({ k }: { k: View }) {
  return (
    <section>
      <h3>Storage</h3>
      {!k.gcOpen && <button onClick={() => k.setGcOpen(true)}>Show storage report</button>}
      {k.gcError && <div className="error">{k.gcError}</div>}
      {k.gc && (
        <div>
          <p className="muted small">
            {k.gc.totals.files.count} stored files ({formatBytes(k.gc.totals.files.bytes)}): {k.gc.totals.referenced.count} still referenced,{' '}
            {k.gc.totals.tooRecent.count} younger than {k.gc.minAgeDays} days, {k.gc.totals.reclaimable.count} unreferenced ({formatBytes(k.gc.totals.reclaimable.bytes)} reclaimable);{' '}
            {k.gc.totals.pruned} pruned earlier{k.gc.totals.missing ? `, ${k.gc.totals.missing} missing` : ''}.
            {k.gc.olderExtractorTexts > 0 && ` ${k.gc.olderExtractorTexts} texts were extracted by an older extractor version.`}
          </p>
          <p className="muted small">Nothing is removed automatically. Pruning removes only the stored file; the description and extracted text stay.</p>
          {k.gc.byNode.map((n) => (
            <div key={n.workspaceId} className="muted small">
              {n.workspaceId}: {n.count} files, {formatBytes(n.bytes)}
            </div>
          ))}
          <ul className="links">
            {k.gc.candidates.map((c) => (
              <li key={c.artifactId}>
                <label>
                  <input type="checkbox" checked={k.selected.includes(c.artifactId)} onChange={() => k.toggleSelected(c.artifactId)} /> {c.title ?? c.artifactId}
                </label>{' '}
                <span className="tag">{c.kind}</span>
                <span className="muted small">
                  {formatBytes(c.bytes)} · last captured {c.lastCapturedAt.slice(0, 10)} ({c.ageDays} days) · {c.workspaceId}
                </span>
                {c.uploadDerived && <span className="tag upload">upload-derived</span>}
              </li>
            ))}
          </ul>
          {k.gc.moreCandidates > 0 && <p className="muted small">{k.gc.moreCandidates} more not listed</p>}
          <button disabled={k.busy || k.selected.length === 0} onClick={() => void k.pruneSelected()}>
            Prune {k.selected.length} selected file(s)
          </button>
        </div>
      )}
    </section>
  );
}
