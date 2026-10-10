import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { useNotesData } from '@/notes/useNotesData';
import { createNote, setNoteTags } from '@/storage/notes';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';
import type { TranscriptionQueue } from '@/transcription/queue';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;

const queue: TranscriptionQueue = {
  start: async () => {},
  enqueue: async () => true,
  retry: async () => true,
  subscribe: () => () => {},
  idle: async () => {},
  stop: () => {},
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
});

function Host({ selectedNoteId }: { selectedNoteId: string | null }) {
  const data = useNotesData(selectedNoteId, queue);
  return (
    <div>
      <div data-testid="visible">{data.visibleNotes.map((n) => n.title).join(',')}</div>
      <div data-testid="hidden-count">{data.tagFilter.hiddenCount}</div>
      <div data-testid="exempted">{String(data.tagFilter.activeNoteExempted)}</div>
      <div data-testid="vocabulary">{data.tagFilter.vocabulary.join(',')}</div>
      <div data-testid="mode">{data.tagFilter.mode}</div>
      {data.tagFilter.vocabulary.map((tag) => (
        <button key={tag} type="button" onClick={() => data.tagFilter.toggleTag(tag)}>
          toggle {tag}
        </button>
      ))}
      <button
        type="button"
        onClick={() => data.tagFilter.setMode(data.tagFilter.mode === 'and' ? 'or' : 'and')}
      >
        flip mode
      </button>
      <button type="button" onClick={data.tagFilter.clear}>
        clear
      </button>
    </div>
  );
}

async function render(selectedNoteId: string | null = null): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={engine}>
        <Host selectedNoteId={selectedNoteId} />
      </CaptureProvider>,
    );
  });
  await settle();
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
}

function buttonByText(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('useNotesData tag filter', () => {
  it('shows every note when nothing is selected', async () => {
    const a = await createNote({ title: 'Alpha', deviceId: 'huion', pageBaseline: 0 });
    await createNote({ title: 'Beta', deviceId: 'huion', pageBaseline: 0 });
    await setNoteTags(a.id, ['seminar']);

    await render();

    expect(text('visible')).toBe('Beta,Alpha');
    expect(text('hidden-count')).toBe('0');
  });

  it('OR widens, AND narrows, for the same two-tag selection', async () => {
    const a = await createNote({ title: 'Alpha', deviceId: 'huion', pageBaseline: 0 });
    const b = await createNote({ title: 'Beta', deviceId: 'huion', pageBaseline: 0 });
    const c = await createNote({ title: 'Gamma', deviceId: 'huion', pageBaseline: 0 });
    await setNoteTags(a.id, ['seminar']);
    await setNoteTags(b.id, ['lecture']);
    await setNoteTags(c.id, ['seminar', 'lecture']);

    await render();
    await click(buttonByText('toggle seminar'));
    await click(buttonByText('toggle lecture'));

    // default mode is 'or' (S5-A2): union of seminar/lecture is all three.
    expect(text('visible').split(',').sort()).toEqual(['Alpha', 'Beta', 'Gamma'].sort());

    await click(buttonByText('flip mode'));
    expect(text('mode')).toBe('and');
    // AND: only Gamma carries both.
    expect(text('visible')).toBe('Gamma');
    expect(text('hidden-count')).toBe('2');
  });

  it('⚑ keeps the active note visible and says so when it does not match', async () => {
    const other = await createNote({ title: 'Other', deviceId: 'huion', pageBaseline: 0 });
    await setNoteTags(other.id, ['seminar']);

    await act(async () => {
      await engine.startNote({ title: 'Live note' });
    });
    await settle();

    await render();
    await click(buttonByText('toggle seminar'));

    expect(text('visible').split(',')).toContain('Live note');
    expect(text('exempted')).toBe('true');
    // Other matches the filter and stays, Live note is force-included - nothing hidden.
    expect(text('hidden-count')).toBe('0');
  });

  it('clear resets both the selection and the mode', async () => {
    const a = await createNote({ title: 'Alpha', deviceId: 'huion', pageBaseline: 0 });
    await setNoteTags(a.id, ['seminar']);

    await render();
    await click(buttonByText('toggle seminar'));
    await click(buttonByText('flip mode'));
    await click(buttonByText('clear'));

    expect(text('mode')).toBe('or');
    expect(text('hidden-count')).toBe('0');
  });

  it('the vocabulary autocompletes from tags already in use', async () => {
    const a = await createNote({ title: 'Alpha', deviceId: 'huion', pageBaseline: 0 });
    await setNoteTags(a.id, ['Seminar', 'Week-3']);

    await render();

    expect(text('vocabulary')).toBe('seminar,week-3');
  });
});
