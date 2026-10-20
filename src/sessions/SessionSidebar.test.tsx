// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionCatalog } from '@/sessions/catalog';
import { EMPTY_SIDEBAR_FILTER } from '@/sessions/filter';
import type { FilterOutcome, SidebarFilter } from '@/sessions/filter';
import { SessionSidebar } from '@/sessions/SessionSidebar';
import type { SessionSidebarProps } from '@/sessions/SessionSidebar';
import type { NoteRecord, RecordingRecord } from '@/storage/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function note(id: string, startedAt: number, sessionId: string | null, tags?: string[]): NoteRecord {
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
    ...(tags ? { tags } : {}),
  };
}

function rec(id: string): RecordingRecord {
  return {
    id,
    sessionId: null,
    noteId: null,
    title: `rec ${id}`,
    startedAt: 5,
    endedAt: null,
    durationMs: 1,
    mimeType: 'audio/webm',
    byteLength: 1,
    transcript: null,
  };
}

const catalog = buildSessionCatalog(
  [
    note('a', Date.UTC(2026, 0, 3, 12), 's1', ['math']),
    note('b', Date.UTC(2026, 0, 2, 12), 's1'),
    note('c', Date.UTC(2026, 0, 1, 12), 's2'),
    note('u1', 20, null),
  ],
  [rec('r1')],
);

function outcomeOf(extra: Partial<FilterOutcome> = {}): FilterOutcome {
  return { sessions: catalog.sessions, uncategorized: catalog.uncategorized, error: null, pending: false, ...extra };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(over: Partial<SessionSidebarProps> = {}) {
  const props: SessionSidebarProps = {
    outcome: outcomeOf(),
    selectedKey: null,
    activeNoteId: null,
    filter: EMPTY_SIDEBAR_FILTER,
    onFilterChange: vi.fn(),
    advancedOpen: false,
    onAdvancedOpenChange: vi.fn(),
    vocabulary: ['math', 'physics'],
    onSelect: vi.fn(),
    ...over,
  };
  act(() => root.render(<SessionSidebar {...props} />));
  return props;
}

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const q = <T extends Element>(sel: string) => host.querySelector(sel) as T;
const byText = (sel: string, text: string) =>
  [...host.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === text)!;

function advancedFilter(patch: Partial<SidebarFilter['advanced']>): SidebarFilter {
  return { ...EMPTY_SIDEBAR_FILTER, advanced: { ...EMPTY_SIDEBAR_FILTER.advanced, ...patch } };
}

describe('SessionSidebar list', () => {
  it('typing in the quick input reports an updated quick filter', () => {
    const p = mount();
    typeInto(q<HTMLInputElement>('input[aria-label="Filter sessions"]'), 'abc');
    expect(p.onFilterChange).toHaveBeenCalledWith({ ...EMPTY_SIDEBAR_FILTER, quick: 'abc' });
  });

  it('shows group headings with counts', () => {
    mount();
    const text = host.textContent ?? '';
    expect(text).toContain('Sessions · 3');
    expect(text).toContain('Uncategorized · 2');
  });

  it('renders an empty group heading with 0', () => {
    mount({ outcome: outcomeOf({ sessions: [] }) });
    expect(host.textContent).toContain('Sessions · 0');
  });

  it('renders entries with title, date and tags in their element-kind classes', () => {
    mount();
    const btn = q<HTMLButtonElement>('button[data-entry-key="note:a"]');
    expect(btn.textContent).toContain('title a');
    expect(btn.querySelector('.text-date')?.textContent).toBeTruthy();
    expect(btn.querySelector('.text-tag')?.textContent).toContain('math');
    expect(btn.querySelector('.text-session-title')?.textContent).toBe('title a');
  });

  it('marks only the selected entry with aria-current', () => {
    mount({ selectedKey: 'note:b' });
    expect(q('button[data-entry-key="note:b"]').getAttribute('aria-current')).toBe('true');
    expect(q('button[data-entry-key="note:a"]').getAttribute('aria-current')).toBeNull();
  });

  it('shows an orphan recording by its title and selects it on click', () => {
    const p = mount();
    const btn = q<HTMLButtonElement>('button[data-entry-key="recording:r1"]');
    expect(btn.textContent).toContain('rec r1');
    act(() => btn.click());
    expect(p.onSelect).toHaveBeenCalledWith('recording:r1');
  });

  it('shows a regex error in an alert and keeps the list', () => {
    mount({ outcome: outcomeOf({ error: 'Invalid regex' }) });
    expect(q('[role="alert"]').textContent).toContain('Invalid regex');
    expect(host.querySelectorAll('button[data-entry-key]').length).toBe(5);
  });

  it('shows Searching text… while pending', () => {
    mount({ outcome: outcomeOf({ pending: true }) });
    expect(host.textContent).toContain('Searching text…');
  });
});

describe('Advanced filter panel', () => {
  it('toggle reports the opposite open state and exposes aria-expanded', () => {
    const p = mount();
    const toggle = q<HTMLButtonElement>('button[aria-expanded]');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(q('[data-slot="advanced-panel"]')).toBeNull();
    act(() => toggle.click());
    expect(p.onAdvancedOpenChange).toHaveBeenCalledWith(true);
  });

  it('when open shows every control', () => {
    mount({ advancedOpen: true });
    expect(q<HTMLButtonElement>('button[aria-expanded]').getAttribute('aria-expanded')).toBe('true');
    for (const label of ['From date', 'To date', 'Title contains', 'Text contains']) {
      expect(q(`input[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(byText('button', 'math')).toBeDefined();
    expect(byText('button', 'physics')).toBeDefined();
    expect(byText('button', 'Any tag')).toBeDefined();
    expect(byText('button', 'All tags')).toBeDefined();
    expect(host.textContent).toContain('Has recording');
    expect(host.textContent).toContain('Has typed page');
    for (const s of ['Active', 'Interrupted', 'Complete']) expect(byText('button', s)).toBeDefined();
    expect(q('[role="switch"][aria-label="Regex"]')).not.toBeNull();
    expect(byText('button', 'Clear')).toBeDefined();
  });

  it('date, text and checkbox edits report advanced changes', () => {
    const p = mount({ advancedOpen: true });
    typeInto(q('input[aria-label="From date"]'), '2026-01-02');
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ from: '2026-01-02' }));
    typeInto(q('input[aria-label="Title contains"]'), 'x');
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ title: 'x' }));
    act(() => q<HTMLInputElement>('input[aria-label="Has recording"]').click());
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ hasRecording: true }));
    act(() => q<HTMLInputElement>('input[aria-label="Has typed page"]').click());
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ hasTypedPage: true }));
  });

  it('clearing a date reports null', () => {
    const p = mount({ advancedOpen: true, filter: advancedFilter({ to: '2026-01-02' }) });
    typeInto(q('input[aria-label="To date"]'), '');
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ to: null }));
  });

  it('tag chips toggle tags and the any/all control sets the mode', () => {
    const p = mount({ advancedOpen: true });
    act(() => byText('button', 'physics').click());
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ tags: ['physics'] }));
    act(() => byText('button', 'Any tag').click());
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ tagMode: 'or' }));
  });

  it('a selected tag chip is pressed and clicking it removes the tag', () => {
    const p = mount({ advancedOpen: true, filter: advancedFilter({ tags: ['math'] }) });
    const chip = byText('button', 'math');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    act(() => chip.click());
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ tags: [] }));
  });

  it('status choices toggle statuses', () => {
    const p = mount({ advancedOpen: true, filter: advancedFilter({ statuses: ['active'] }) });
    act(() => byText('button', 'Complete').click());
    expect(p.onFilterChange).toHaveBeenLastCalledWith(
      advancedFilter({ statuses: ['active', 'complete'] }),
    );
    act(() => byText('button', 'Active').click());
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ statuses: [] }));
  });

  it('the Regex switch toggles regex', () => {
    const p = mount({ advancedOpen: true });
    act(() => q<HTMLButtonElement>('[role="switch"][aria-label="Regex"]').click());
    expect(p.onFilterChange).toHaveBeenLastCalledWith(advancedFilter({ regex: true }));
  });

  it('Clear resets to EMPTY_SIDEBAR_FILTER (quick text included)', () => {
    const p = mount({
      advancedOpen: true,
      filter: { quick: 'keep?', advanced: { ...EMPTY_SIDEBAR_FILTER.advanced, title: 'x', regex: true } },
    });
    act(() => byText('button', 'Clear').click());
    expect(p.onFilterChange).toHaveBeenCalledWith(EMPTY_SIDEBAR_FILTER);
  });
});
