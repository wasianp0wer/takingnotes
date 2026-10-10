import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResumeButton } from '@/notes/ResumeButton';
import { resetResumeLockForTests } from '@/notes/resumeLock';
import type { NoteRecord } from '@/storage/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetResumeLockForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetResumeLockForTests();
});

function note(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'note-1',
    title: 'Lecture 3',
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
    sessionId: null,
    ...overrides,
  };
}

function fakeEngine(impl?: (noteId: string) => Promise<{ sessionId: string; noteId: string }>) {
  const resumeNote = vi.fn(
    impl ?? (async (noteId: string) => ({ sessionId: 'session-1', noteId })),
  );
  return { resumeNote };
}

function renderOne(props: Partial<Parameters<typeof ResumeButton>[0]> = {}) {
  const engine = props.engine ?? fakeEngine();
  act(() => {
    root.render(
      <ResumeButton
        note={note()}
        engine={engine}
        activeNoteId={null}
        sessionLocked={false}
        {...props}
      />,
    );
  });
  return engine;
}

function button(): HTMLButtonElement | null {
  return container.querySelector('button');
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ResumeButton', () => {
  it('renders nothing for the active note', () => {
    renderOne({ note: note({ id: 'active-note' }), activeNoteId: 'active-note' });
    expect(button()).toBeNull();
  });

  it('renders nothing for a legacy note', () => {
    renderOne({ note: note({ legacy: true }) });
    expect(button()).toBeNull();
  });

  it('calls resumeNote(note.id) on click for any other note', async () => {
    const engine = fakeEngine();
    renderOne({ engine, note: note({ id: 'other-note' }) });

    await click(button()!);

    expect(engine.resumeNote).toHaveBeenCalledWith('other-note');
  });

  it('is disabled while sessionLocked is true', () => {
    renderOne({ sessionLocked: true });
    expect(button()!.disabled).toBe(true);
  });

  it('is disabled while the shared resume lock is pending, including for a different instance than the one clicked', async () => {
    let release: (() => void) | null = null;
    const slowEngine = fakeEngine(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ sessionId: 's', noteId: 'note-1' });
        }),
    );

    // Two separate component instances, as the sidebar (one per note) and
    // the interrupted banner would each mount their own.
    const other = document.createElement('div');
    document.body.appendChild(other);
    const otherRoot = createRoot(other);

    act(() => {
      root.render(
        <ResumeButton
          note={note({ id: 'note-1' })}
          engine={slowEngine}
          activeNoteId={null}
          sessionLocked={false}
        />,
      );
    });
    act(() => {
      otherRoot.render(
        <ResumeButton
          note={note({ id: 'note-2' })}
          engine={slowEngine}
          activeNoteId={null}
          sessionLocked={false}
        />,
      );
    });

    expect(button()!.disabled).toBe(false);
    expect(other.querySelector('button')!.disabled).toBe(false);

    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(button()!.disabled).toBe(true);
    expect(other.querySelector('button')!.disabled).toBe(true);

    await act(async () => {
      (release as (() => void) | null)?.();
    });

    expect(button()!.disabled).toBe(false);
    expect(other.querySelector('button')!.disabled).toBe(false);

    act(() => otherRoot.unmount());
    other.remove();
  });

  it('shows an error on a rejected resumeNote and clears the lock so the next click works', async () => {
    let shouldFail = true;
    const engine = fakeEngine(async (noteId) => {
      if (shouldFail) throw new Error('Note not found: note-1');
      return { sessionId: 's', noteId };
    });
    renderOne({ engine });

    await click(button()!);

    expect(container.textContent).toContain('Note not found: note-1');
    expect(button()!.disabled).toBe(false);

    shouldFail = false;
    await click(button()!);

    expect(engine.resumeNote).toHaveBeenCalledTimes(2);
  });
});
