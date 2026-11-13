// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingRequests } from '../../web/src/views/PendingRequests.js';

const question = {
  id: 'ureq_esc',
  workspaceId: 'ws_1',
  agentRunId: 'arun_esc',
  taskId: 'tsk_1',
  kind: 'escalation',
  details: 'Which source should the re-run trust?',
  status: 'pending',
  createdAt: '2026-11-13T00:00:00.000Z',
  optionsJson: { options: ['Pricing page', 'Uploaded quotes', 'Skip pricing'], recommended: 0, rationale: 'The price was not verified.' },
};

class NoopEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

let calls: Array<{ method: string; path: string; body?: unknown }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const body = method === 'GET' ? [question] : { ...question, status: method === 'POST' ? 'resolved' : 'pending' };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('EventSource', NoopEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('escalation questions', () => {
  it('shows the options with the recommended one preselected and posts the chosen option', async () => {
    render(<PendingRequests wsId="ws_1" />);
    expect(await screen.findByText('Which source should the re-run trust?')).toBeTruthy();
    expect(screen.getByText('The price was not verified.')).toBeTruthy();
    expect(screen.getByText('recommended')).toBeTruthy();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    // No generic approve/deny buttons on a question.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();

    await act(async () => {
      fireEvent.click(radios[1]!);
    });
    fireEvent.change(screen.getByPlaceholderText('note (optional)'), { target: { value: 'use the Q3 quote' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/requests/ureq_esc/escalation-answer', body: { choice: 1, note: 'use the Q3 quote' } });
    expect(screen.queryByText('Which source should the re-run trust?')).toBeNull();
  });

  it('dismisses a question through the generic request route', async () => {
    render(<PendingRequests wsId="ws_1" />);
    await screen.findByText('Which source should the re-run trust?');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/requests/ureq_esc', body: { status: 'denied' } });
  });
});
