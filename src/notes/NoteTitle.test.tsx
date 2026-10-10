import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NoteTitle } from '@/notes/NoteTitle';
import { createNote, getNote } from '@/storage/notes';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(noteId: string, title: string) {
  act(() => {
    root.render(<NoteTitle noteId={noteId} title={title} />);
  });
}

async function act2(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn();
  });
}

function textButton(): HTMLButtonElement {
  const found = container.querySelector('button');
  if (!found) throw new Error('no title button');
  return found;
}

function input(): HTMLInputElement {
  const found = container.querySelector('input');
  if (!found) throw new Error('no title input');
  return found;
}

async function type(el: HTMLInputElement, value: string) {
  await act2(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!
      .set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function keyDown(el: HTMLElement, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  // `renameNote` goes through fake-indexeddb, which schedules with
  // setImmediate rather than microtasks - a bare dispatch does not give the
  // commit's own await chain time to settle, and under load a couple of
  // rounds is not always enough either.
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('NoteTitle', () => {
  it('renders the current title as plain text', async () => {
    const note = await createNote({ title: 'Lecture 3', deviceId: 'huion', pageBaseline: 0 });
    render(note.id, note.title);

    expect(container.textContent).toContain('Lecture 3');
    expect(container.querySelector('input')).toBeNull();
  });

  it('clicking the title opens an input seeded with the current title', async () => {
    const note = await createNote({ title: 'Lecture 3', deviceId: 'huion', pageBaseline: 0 });
    render(note.id, note.title);

    await act2(() => textButton().click());

    expect(input().value).toBe('Lecture 3');
  });

  it('committing a changed, non-blank title calls renameNote and returns to text display', async () => {
    const note = await createNote({ title: 'Lecture 3', deviceId: 'huion', pageBaseline: 0 });
    render(note.id, note.title);
    await act2(() => textButton().click());

    await type(input(), 'The French Revolution');
    await keyDown(input(), 'Enter');

    // Back to plain text, not the edit input - the parent (NotesView) is the
    // one that re-renders with the new title once `useNotesData` picks up
    // the write, which is a controlled-component concern, not this one's.
    expect(container.querySelector('input')).toBeNull();
    const updated = await getNote(note.id);
    expect(updated?.title).toBe('The French Revolution');
    expect(updated?.titleSource).toBe('manual');
  });

  it('committing unchanged text is a no-op - no write happens', async () => {
    const note = await createNote({ title: 'Lecture 3', deviceId: 'huion', pageBaseline: 0 });
    render(note.id, note.title);
    await act2(() => textButton().click());

    await keyDown(input(), 'Enter');

    expect(container.querySelector('input')).toBeNull();
    const updated = await getNote(note.id);
    // titleSource was never touched - still the default, not 'manual'.
    expect(updated?.titleSource).toBeUndefined();
  });

  it('committing blank text reverts the draft and shows an inline error, without calling renameNote', async () => {
    const note = await createNote({ title: 'Lecture 3', deviceId: 'huion', pageBaseline: 0 });
    render(note.id, note.title);
    await act2(() => textButton().click());

    await type(input(), '   ');
    await keyDown(input(), 'Enter');

    // Stays open (so the person can fix it or cancel), with the draft
    // reverted and an inline error - not a silent revert-and-close, which
    // would leave no explanation for why nothing happened.
    expect(input().value).toBe('Lecture 3');
    expect((container.textContent ?? '').toLowerCase()).toContain('blank');
    const updated = await getNote(note.id);
    expect(updated?.title).toBe('Lecture 3');
    expect(updated?.titleSource).toBeUndefined();
  });

  it('Escape cancels back to the original title without writing', async () => {
    const note = await createNote({ title: 'Lecture 3', deviceId: 'huion', pageBaseline: 0 });
    render(note.id, note.title);
    await act2(() => textButton().click());

    await type(input(), 'Something else entirely');
    await keyDown(input(), 'Escape');

    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('Lecture 3');
    const updated = await getNote(note.id);
    expect(updated?.title).toBe('Lecture 3');
    expect(updated?.titleSource).toBeUndefined();
  });

  it('shows an error and stays open to retry when renameNote rejects', async () => {
    // A note id that does not exist makes `renameNote` reject (storage.notes'
    // own `updateNote` throws "Note not found").
    render('missing-note', 'Lecture 3');
    await act2(() => textButton().click());

    await type(input(), 'New title');
    await keyDown(input(), 'Enter');

    expect(container.querySelector('input')).not.toBeNull();
    expect(container.textContent).toContain('Note not found');
  });
});
