import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteList } from '@/notes/NoteList';
import type { NoteRecord } from '@/storage/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function note(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'n1',
    title: 'Lecture 1',
    status: 'complete',
    deviceId: 'huion',
    deviceType: 'huion',
    deviceName: null,
    startedAt: 1_000,
    endedAt: 2_000,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
    sessionId: 's1',
    ...overrides,
  };
}

async function render(ui: ReactElement): Promise<void> {
  await act(async () => {
    root.render(ui);
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) {
    throw new Error(
      `no button with text ${JSON.stringify(text)}; have ${JSON.stringify(
        buttons().map((b) => b.textContent?.trim()),
      )}`,
    );
  }
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('NoteList', () => {
  it('renders each note and reports selection', async () => {
    const onSelect = vi.fn();
    await render(
      <NoteList
        notes={[note({ id: 'a', title: 'Alpha' }), note({ id: 'b', title: 'Beta' })]}
        selectedNoteId="a"
        activeNoteId={null}
        onSelect={onSelect}
      />,
    );

    await click(buttonByText('Beta'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('marks the selected note for assistive tech', async () => {
    await render(
      <NoteList
        notes={[note({ id: 'a', title: 'Alpha' })]}
        selectedNoteId="a"
        activeNoteId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(buttonByText('Alpha').getAttribute('aria-current')).toBe('true');
  });

  it('renders the filter slot above the list', async () => {
    await render(
      <NoteList
        notes={[]}
        selectedNoteId={null}
        activeNoteId={null}
        onSelect={vi.fn()}
        filter={<div data-testid="filter-slot">filter</div>}
      />,
    );

    expect(container.querySelector('[data-testid="filter-slot"]')).not.toBeNull();
  });

  it('renders row actions per note', async () => {
    await render(
      <NoteList
        notes={[note({ id: 'a', title: 'Alpha' })]}
        selectedNoteId={null}
        activeNoteId={null}
        onSelect={vi.fn()}
        rowActions={(n) => <button type="button">Resume {n.title}</button>}
      />,
    );

    expect(buttonByText('Resume Alpha')).toBeTruthy();
  });

  it('badges the active, legacy and interrupted states', async () => {
    await render(
      <NoteList
        notes={[
          note({ id: 'a', title: 'Active' }),
          note({ id: 'b', title: 'Old', legacy: true }),
          note({ id: 'c', title: 'Broken', status: 'interrupted' }),
        ]}
        selectedNoteId={null}
        activeNoteId="a"
        onSelect={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('Recording');
    expect(container.textContent).toContain('Legacy');
    expect(container.textContent).toContain('Interrupted');
  });

  it('shows the empty state when there are no notes', async () => {
    await render(
      <NoteList notes={[]} selectedNoteId={null} activeNoteId={null} onSelect={vi.fn()} />,
    );

    expect(container.textContent).toContain('write on the pad to start one');
  });
});
