/** Hash router: `#/`, `#/settings`, `#/w/<workspaceId>/<page>`. */
import { useEffect, useState } from 'react';

export const WORKSPACE_PAGES = [
  { page: 'map', label: 'Business map' },
  { page: 'interview', label: 'Interview' },
  { page: 'personas', label: 'Audience & Personas' },
  { page: 'research', label: 'Research' },
  { page: 'findings', label: 'Findings & Evidence' },
  { page: 'competitors', label: 'Competitors' },
  { page: 'strategy', label: 'Strategy' },
  { page: 'review', label: 'Review queue' },
  { page: 'decisions', label: 'Decision log' },
  { page: 'schedule', label: 'Schedule' },
] as const;

export type WorkspacePage = (typeof WORKSPACE_PAGES)[number]['page'];

export type Route =
  | { name: 'workspaces' }
  | { name: 'settings' }
  | { name: 'workspace'; wsId: string; page: WorkspacePage };

const PAGES = new Set<string>(WORKSPACE_PAGES.map((p) => p.page));

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'w' && parts[1]) {
    const page = parts[2] && PAGES.has(parts[2]) ? (parts[2] as WorkspacePage) : 'map';
    return { name: 'workspace', wsId: parts[1], page };
  }
  return { name: 'workspaces' };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'workspaces':
      return '#/';
    case 'settings':
      return '#/settings';
    case 'workspace':
      return `#/w/${encodeURIComponent(route.wsId)}/${route.page}`;
  }
}

export const workspaceHref = (wsId: string, page: WorkspacePage = 'map') =>
  href({ name: 'workspace', wsId, page });

export function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
