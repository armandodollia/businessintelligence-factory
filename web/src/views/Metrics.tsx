import { shortDate } from '../logic/format.js';
import {
  CHARTED_METRICS, GROUP_BY_OPTIONS, chartGeometry, formatMetric, lessonsEffectRows, outcomeColumns, seriesOf, useExportSummaryOnDemand, useMetrics,
  type ChartedMetric, type MetricsFilter, type MetricsGroupBy, type MetricsPoint, type MetricsReport,
} from '../logic/metrics.js';
import { formatRate, formatTokens, formatUsd } from '../logic/usage.js';

/** Learning loop WP-G: metrics over time and per role / task type / prompt version / model. */
export function Metrics({ wsId }: { wsId: string }) {
  const m = useMetrics(wsId);
  const r = m.report;
  return (
    <div className="metrics">
      <h2>Metrics</h2>
      <Filters filter={m.filter} onChange={m.setFilter} />
      {m.error && <div className="error">{m.error}</div>}
      {!r && m.loading && <p className="muted">Loading metrics…</p>}
      {r && (
        <>
          <p className="muted small">
            {r.scope === 'tree' ? `Whole business (${r.workspaceIds.length} part${r.workspaceIds.length === 1 ? '' : 's'})` : 'This part only'}
            {' · '}
            {r.experiments.included
              ? 'experiment and audit runs included'
              : `${r.experiments.excludedRuns} experiment / audit run${r.experiments.excludedRuns === 1 ? '' : 's'} left out`}
            {' · '}times are when the work was done (the agent run's start)
          </p>
          <Kpis r={r} />
          <section>
            <h3>Over time</h3>
            <div className="metric-charts">
              {CHARTED_METRICS.map((c) => (
                <LineChart key={c.id} metric={c} points={r.series} />
              ))}
            </div>
            <SeriesTable points={r.series} />
          </section>
          <GroupTable r={r} />
          <Failures r={r} />
          <OutcomeLabels r={r} />
          {/* --- WP-E slot: lessons effect per rule and prompt version --- */}
          <LessonsSlot lessons={r.lessons} />
          {/* --- end WP-E slot --- */}
          <KnowledgeSection r={r} />
        </>
      )}
      <ExportExclusions wsId={wsId} />
    </div>
  );
}

function Filters({ filter, onChange }: { filter: MetricsFilter; onChange: (p: Partial<MetricsFilter>) => void }) {
  return (
    <div className="row wrap">
      <label className="inline">
        Scope
        <select value={filter.scope} onChange={(e) => onChange({ scope: e.target.value as MetricsFilter['scope'] })}>
          <option value="tree">Whole business</option>
          <option value="node">This part only</option>
        </select>
      </label>
      <label className="inline">
        Group by
        <select value={filter.groupBy} onChange={(e) => onChange({ groupBy: e.target.value as MetricsGroupBy })}>
          {GROUP_BY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="inline">
        Per
        <select value={filter.bucket} onChange={(e) => onChange({ bucket: e.target.value as MetricsFilter['bucket'] })}>
          <option value="day">Day</option>
          <option value="week">Week</option>
        </select>
      </label>
      <label className="inline">
        From
        <input type="date" value={filter.since} onChange={(e) => onChange({ since: e.target.value })} />
      </label>
      <label className="inline">
        To
        <input type="date" value={filter.until} onChange={(e) => onChange({ until: e.target.value })} />
      </label>
      <label className="inline">
        <input type="checkbox" checked={filter.includeExperiments} onChange={(e) => onChange({ includeExperiments: e.target.checked })} />
        Include experiment and audit runs
      </label>
    </div>
  );
}

function Kpis({ r }: { r: MetricsReport }) {
  const t = r.totals;
  const tiles: Array<[string, string, string]> = [
    ['Review pass rate', formatRate(t.passRate), `${t.verified} of ${t.tasks} tasks`],
    ['First-round pass', formatRate(t.firstRoundPassRate), ''],
    ['Rounds to pass', formatMetric(t.meanRounds, 'rounds'), `${t.reviewIssues} review issues`],
    ['Run failures', formatRate(t.failureRate), `${t.failedRuns} of ${t.runs} runs · ${t.rateLimitedAttempts} rate-limited attempts`],
    ['Cost', formatUsd(t.costUsd), `${formatTokens(t.totalTokens)} tokens`],
    ['Rating agreement', formatRate(t.agreeRate), `${t.ratings} ratings`],
    ['Outcomes', String(t.outcomes), 'labelled decisions'],
  ];
  return (
    <div className="kpis">
      {tiles.map(([label, value, sub]) => (
        <div key={label} className="kpi">
          <div className="kpi-label">{label}</div>
          <div className="kpi-value">{value}</div>
          {sub && <div className="kpi-sub">{sub}</div>}
        </div>
      ))}
    </div>
  );
}

const BOX = { width: 320, height: 120, pad: 8 };

function LineChart({ metric, points }: { metric: ChartedMetric; points: MetricsPoint[] }) {
  const g = chartGeometry(seriesOf(points, metric.id), metric.kind, BOX);
  const first = points[0]?.bucket;
  const last = points.at(-1)?.bucket;
  return (
    <figure className="metric-chart">
      <figcaption>
        <b>{metric.label}</b> <span className="chart-note">{metric.note}</span>
      </figcaption>
      <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label={`${metric.label} over time`} preserveAspectRatio="none">
        {[0, 0.5, 1].map((f) => {
          const y = BOX.pad + f * (BOX.height - 2 * BOX.pad);
          return <line key={f} className={f === 1 ? 'chart-axis' : 'chart-grid'} x1={0} x2={BOX.width} y1={y} y2={y} />;
        })}
        {g.path && <path className="chart-line" d={g.path} />}
        {g.dots.map((d) => (
          <g key={d.bucket}>
            <circle className="chart-dot" cx={d.x} cy={d.y} r={4} />
            <circle className="chart-hit" cx={d.x} cy={d.y} r={10}>
              <title>{`${d.bucket}: ${formatMetric(d.value, metric.kind)}`}</title>
            </circle>
          </g>
        ))}
      </svg>
      <div className="chart-axis-labels">
        <span>{first ?? ''}</span>
        <span>
          0 – {formatMetric(g.yMax, metric.kind)}
          {g.dots.length === 0 && ' · no data'}
        </span>
        <span>{last !== first ? last : ''}</span>
      </div>
    </figure>
  );
}

function SeriesTable({ points }: { points: MetricsPoint[] }) {
  return (
    <details>
      <summary className="small">Series as a table</summary>
      <table>
        <thead>
          <tr>
            <th>From</th>
            <th>Runs</th>
            <th>Tasks</th>
            {CHARTED_METRICS.map((c) => (
              <th key={c.id}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.bucket}>
              <td className="nowrap">{p.bucket}</td>
              <td>{p.runs}</td>
              <td>{p.tasks}</td>
              {CHARTED_METRICS.map((c) => (
                <td key={c.id}>{formatMetric(p[c.id] as number | null, c.kind)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function GroupTable({ r }: { r: MetricsReport }) {
  const label = GROUP_BY_OPTIONS.find((o) => o.value === r.groupBy)?.label ?? r.groupBy;
  return (
    <section>
      <h3>By {label.toLowerCase()}</h3>
      {r.groups.length === 0 && <p className="muted">No agent work in this window.</p>}
      {r.groups.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{label}</th>
              <th>First seen</th>
              <th>Runs</th>
              <th>Failed</th>
              <th>Tasks</th>
              <th>Pass</th>
              <th>1st-round pass</th>
              <th>Rounds</th>
              <th>Issues</th>
              <th>Ratings</th>
              <th>Agree</th>
              <th>Mean Δ</th>
              <th>Outcomes</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {r.groups.map((g) => (
              <tr key={g.key}>
                <td>{g.key}</td>
                <td className="nowrap">{g.firstSeen ? shortDate(g.firstSeen) : '—'}</td>
                <td>{g.runs}</td>
                <td>{g.failedRuns}</td>
                <td>{g.tasks}</td>
                <td>{formatRate(g.passRate)}</td>
                <td>{formatRate(g.firstRoundPassRate)}</td>
                <td>{formatMetric(g.meanRounds, 'rounds')}</td>
                <td>{g.reviewIssues}</td>
                <td>{g.ratings}</td>
                <td>{formatRate(g.agreeRate)}</td>
                <td>{g.meanDelta === null ? '—' : g.meanDelta.toFixed(2)}</td>
                <td>{g.outcomes}</td>
                <td>{formatUsd(g.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Failures({ r }: { r: MetricsReport }) {
  return (
    <div className="split even">
      <section>
        <h3>Run failures by reason</h3>
        {r.failuresByReason.length === 0 ? (
          <p className="muted">No failed runs.</p>
        ) : (
          <table>
            <tbody>
              {r.failuresByReason.map((f) => (
                <tr key={f.reason}>
                  <td>{f.reason}</td>
                  <td>{f.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h3>Review issues by class</h3>
        {r.reviewIssuesByClass.length === 0 ? (
          <p className="muted">No review issues.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Class</th>
                <th>Issues</th>
                <th>Tasks</th>
              </tr>
            </thead>
            <tbody>
              {r.reviewIssuesByClass.map((c) => (
                <tr key={c.class}>
                  <td>{c.class}</td>
                  <td>{c.issues}</td>
                  <td>{c.tasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function OutcomeLabels({ r }: { r: MetricsReport }) {
  const cols = outcomeColumns(r);
  return (
    <section>
      <h3>Outcome labels</h3>
      {cols.length === 0 ? (
        <p className="muted">No decision outcomes in this window.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{GROUP_BY_OPTIONS.find((o) => o.value === r.groupBy)?.label}</th>
              {cols.map((l) => (
                <th key={l}>{l}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {r.groups
              .filter((g) => g.outcomes > 0)
              .map((g) => (
                <tr key={g.key}>
                  <td>{g.key}</td>
                  {cols.map((l) => (
                    <td key={l}>{g.outcomeCounts[l] ?? 0}</td>
                  ))}
                  <td>{g.outcomes}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// --- WP-E slot: lessons effect per rule and prompt version ----------------------------------------
function LessonsSlot({ lessons }: { lessons: MetricsReport['lessons'] }) {
  const rows = lessonsEffectRows(lessons);
  return (
    <section data-testid="lessons-slot">
      <h3>Lessons effect per rule and prompt version</h3>
      {rows.length === 0 && <p className="muted">No lesson rules in this business yet.</p>}
      {rows.map((r) => (
        <div key={r.key} className="card">
          <div>
            <span className="tag">{r.role}</span>
            <span className="tag">{r.tag}</span>
            <span className="tag">{r.label}</span>
            {r.text}
          </div>
          <div className="small muted">{r.verdict}</div>
          {r.versions.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Prompt version</th>
                  <th>Rule</th>
                  <th>Tasks</th>
                  <th>With this category</th>
                  <th>Pass rate</th>
                  <th>Rating agreement</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {r.versions.map((v) => (
                  <tr key={v.promptVersion}>
                    <td className="small">{v.promptVersion}</td>
                    <td>{v.rule}</td>
                    <td>{v.tasks}</td>
                    <td>{v.hits}</td>
                    <td>{v.passRate}</td>
                    <td>{v.agreeRate}</td>
                    <td>{v.cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </section>
  );
}
// --- end WP-E slot --------------------------------------------------------------------------------

function KnowledgeSection({ r }: { r: MetricsReport }) {
  const k = r.knowledge;
  const ret = k.retrieval;
  return (
    <section>
      <h3>Knowledge</h3>
      <p>
        {k.store.facts.current} current facts ({formatRate(k.freshness.staleShare)} stale) · {k.store.artifacts} artifacts ·{' '}
        {k.store.chunks} chunks
        {k.store.fileBytes !== null && ` · ${formatTokens(k.store.fileBytes)}B of files`}
      </p>
      <p>
        Agent retrieval: {ret.retrievals} reads in {ret.runs} runs · hit rate {formatRate(ret.hitRate)} · zero-result searches{' '}
        {formatRate(ret.zeroResultRate)} · {formatRate(k.retrievedShare)} of input tokens were retrieved knowledge
      </p>
      <p className="muted small">
        Human reads (not agent context): {ret.user.reads} ({ret.user.searches} searches, {ret.user.zeroResultSearches} with no result)
      </p>
      {k.byGroup.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{GROUP_BY_OPTIONS.find((o) => o.value === r.groupBy)?.label}</th>
              <th>Runs</th>
              <th>Reads</th>
              <th>Hit rate</th>
              <th>Zero-result</th>
              <th>Tokens / run</th>
            </tr>
          </thead>
          <tbody>
            {k.byGroup.map((g) => (
              <tr key={g.key}>
                <td>{g.key}</td>
                <td>{g.runs}</td>
                <td>{g.retrievals}</td>
                <td>{formatRate(g.hitRate)}</td>
                <td>{formatRate(g.zeroResultRate)}</td>
                <td>{formatTokens(g.retrievedTokensPerRun)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ExportExclusions({ wsId }: { wsId: string }) {
  const s = useExportSummaryOnDemand(wsId);
  return (
    <section>
      <h3>Training export exclusions</h3>
      <p className="muted small">Computing this runs the whole export, so it is done only when you ask.</p>
      <button disabled={s.busy} onClick={() => void s.compute()}>
        Compute export exclusions
      </button>
      {s.error && <div className="error">{s.error}</div>}
      {s.view && (
        <div className="card">
          <div>{s.view.headline}</div>
          {s.view.causes.length > 0 && (
            <ul className="small">
              {s.view.causes.map((c) => (
                <li key={c.cause}>{c.text}</li>
              ))}
            </ul>
          )}
          {s.view.includeHint && <div className="muted small">{s.view.includeHint}</div>}
        </div>
      )}
    </section>
  );
}
