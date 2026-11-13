import { workspaceLabel } from '../logic/format.js';
import { useWorkspace } from '../logic/hooks.js';
import { href, useHashRoute, WORKSPACE_PAGES, workspaceHref, type WorkspacePage } from '../logic/router.js';
import { BusinessMap } from './BusinessMap.js';
import { Competitors } from './Competitors.js';
import { DecisionLog } from './DecisionLog.js';
import { Findings } from './Findings.js';
import { Interview } from './Interview.js';
import { Knowledge } from './Knowledge.js'; // knowledge store KS-7
import { Lessons } from './Lessons.js'; // learning loop WP-E
import { Experiments } from './Experiments.js'; // learning loop WP-F
import { PendingRequests } from './PendingRequests.js';
import { Personas } from './Personas.js';
import { Research } from './Research.js';
import { ReviewQueue } from './ReviewQueue.js';
import { Schedule } from './Schedule.js';
import { Settings } from './Settings.js';
import { Strategy } from './Strategy.js';
import { Usage } from './Usage.js';
import { Workspaces } from './Workspaces.js';

export function App() {
  const route = useHashRoute();
  return (
    <div className="app">
      <header>
        <a className="brand" href={href({ name: 'workspaces' })}>
          Business Intelligence Factory
        </a>
        <nav>
          <a href={href({ name: 'workspaces' })} className={route.name === 'workspaces' ? 'current' : ''}>
            Workspaces
          </a>
          <a href={href({ name: 'settings' })} className={route.name === 'settings' ? 'current' : ''}>
            Settings
          </a>
        </nav>
      </header>
      <main>
        {route.name === 'workspaces' && <Workspaces />}
        {route.name === 'settings' && <Settings />}
        {route.name === 'workspace' && <WorkspaceShell key={route.wsId} wsId={route.wsId} page={route.page} />}
      </main>
    </div>
  );
}

function WorkspaceShell({ wsId, page }: { wsId: string; page: WorkspacePage }) {
  const { workspace, parent } = useWorkspace(wsId);
  return (
    <div>
      <div className="ws-head">
        {parent && (
          <a className="muted" href={workspaceHref(parent.id)}>
            {parent.name} ›{' '}
          </a>
        )}
        <b>{workspace ? workspaceLabel(workspace) : wsId}</b>
        {workspace?.scope?.description && <div className="muted small">{workspace.scope.description}</div>}
      </div>
      <nav className="tabs">
        {WORKSPACE_PAGES.map((p) => (
          <a key={p.page} href={workspaceHref(wsId, p.page)} className={p.page === page ? 'current' : ''}>
            {p.label}
          </a>
        ))}
      </nav>
      {page !== 'research' && <PendingRequests wsId={wsId} />}
      <Page wsId={wsId} page={page} />
    </div>
  );
}

function Page({ wsId, page }: { wsId: string; page: WorkspacePage }) {
  switch (page) {
    case 'map':
      return <BusinessMap wsId={wsId} />;
    case 'interview':
      return <Interview wsId={wsId} />;
    case 'personas':
      return <Personas wsId={wsId} />;
    case 'research':
      return <Research wsId={wsId} />;
    case 'findings':
      return <Findings wsId={wsId} />;
    case 'competitors':
      return <Competitors wsId={wsId} />;
    case 'strategy':
      return <Strategy wsId={wsId} />;
    case 'review':
      return <ReviewQueue wsId={wsId} />;
    case 'decisions':
      return <DecisionLog wsId={wsId} />;
    case 'schedule':
      return <Schedule wsId={wsId} />;
    case 'usage':
      return <Usage wsId={wsId} />;
    case 'knowledge': // knowledge store KS-7
      return <Knowledge wsId={wsId} />;
    case 'lessons': // learning loop WP-E
      return <Lessons wsId={wsId} />;
    case 'experiments': // learning loop WP-F
      return <Experiments wsId={wsId} />;
  }
}
