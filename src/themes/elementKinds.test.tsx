// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionCatalog } from '@/sessions/catalog';
import { EMPTY_SIDEBAR_FILTER } from '@/sessions/filter';
import { SessionSidebar } from '@/sessions/SessionSidebar';
import { createEvent } from '@/storage/events';
import { createTask } from '@/storage/tasks';
import type { NoteRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';
import { flush, waitFor } from '@/triage/testing';
import { TriageView } from '@/triage/TriageView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;

function note(id: string, startedAt: number, sessionId: string | null, tags: string[]): NoteRecord {
  return {
    id,
    title: `title ${id}`,
    status: 'complete',
    deviceId: 'd',
    deviceType: 'huion',
    deviceName: null,
    startedAt,
    endedAt: null,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
    sessionId,
    tags,
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  await resetDatabase();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const classesOf = (el: Element) => [...el.querySelectorAll('*')].flatMap((e) => [...e.classList]);

async function mountTriage() {
  await createEvent({ title: 'Quiz', kind: 'event', startsAt: Date.now() + DAY });
  await createTask({
    title: 'Read ch. 3',
    dueAt: Date.now() + 2 * DAY,
    required: true,
    estimatedMinutes: 30,
    source: 'manual',
  });
  act(() => root.render(<TriageView />));
  await waitFor(() => expect(host.textContent).toContain('Read ch. 3'));
  await waitFor(() => expect(host.textContent).toContain('Quiz'));
  await flush();
}

function mountSidebar() {
  const catalog = buildSessionCatalog([note('a', Date.UTC(2026, 0, 3, 12), 's1', ['math'])], []);
  act(() =>
    root.render(
      <SessionSidebar
        outcome={{
          sessions: catalog.sessions,
          uncategorized: catalog.uncategorized,
          error: null,
          pending: false,
        }}
        selectedKey={null}
        activeNoteId={null}
        filter={EMPTY_SIDEBAR_FILTER}
        onFilterChange={vi.fn()}
        advancedOpen={false}
        onAdvancedOpenChange={vi.fn()}
        vocabulary={['math']}
        onSelect={vi.fn()}
      />,
    ),
  );
}

describe('element-kind colour classes and square corners', () => {
  it('Triage headings, agenda dates and task dates use the element-kind classes', async () => {
    await mountTriage();
    const headings = [...host.querySelectorAll('h2, h3')];
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h.classList.contains('text-heading')).toBe(true);
    const agenda = host.querySelector('[aria-label="Agenda"]')!;
    expect(agenda.querySelector('h3')!.classList.contains('text-heading')).toBe(true);
    expect(agenda.querySelector('.text-date')).not.toBeNull();
    const row = host.querySelector('[data-task-id]')!;
    expect(row.querySelector('.text-date')).not.toBeNull();
  });

  it('the sidebar marks headings, dates and tags', () => {
    mountSidebar();
    expect(host.querySelector('h2.text-heading')).not.toBeNull();
    expect(host.querySelector('.text-date')).not.toBeNull();
    const tags = [...host.querySelectorAll('[data-entry-key] .text-tag')];
    expect(tags.map((t) => t.textContent)).toContain('math');
  });

  it('no element in Triage or the sidebar uses rounded-md, -lg or -xl', async () => {
    await mountTriage();
    expect(classesOf(host).filter((c) => /^rounded-(md|lg|xl)$/.test(c))).toEqual([]);
    mountSidebar();
    expect(classesOf(host).filter((c) => /^rounded-(md|lg|xl)$/.test(c))).toEqual([]);
  });
});
