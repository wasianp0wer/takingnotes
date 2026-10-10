import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TagEditor } from '@/notes/TagEditor';
import { createNote, getNote, setNoteTags } from '@/storage/notes';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * How many of the next `setNoteTags` calls fail, so a test can fail one
 * specific write without disarming the countdown by hand and racing it.
 * Same shape and same reason as `src/capture/engine.test.ts`'s
 * `failNoteWrites`.
 */
const hooks = vi.hoisted(() => ({ failSetNoteTags: 0 }));

vi.mock('@/storage/notes', async () => {
  const actual = await vi.importActual<typeof import('@/storage/notes')>('@/storage/notes');
  return {
    ...actual,
    setNoteTags: (id: Parameters<typeof actual.setNoteTags>[0], tags: readonly string[]) => {
      if (hooks.failSetNoteTags > 0) {
        hooks.failSetNoteTags -= 1;
        return Promise.reject(new Error('tag write failed'));
      }
      return actual.setNoteTags(id, tags);
    },
  };
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  hooks.failSetNoteTags = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}
function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) {
    throw new Error(
      `no button ${text}; have ${JSON.stringify(buttons().map((b) => b.textContent?.trim()))}`,
    );
  }
  return found;
}
function input(): HTMLInputElement {
  const found = container.querySelector('input');
  if (!found) throw new Error('no input');
  return found;
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
// React patches `HTMLInputElement.prototype.value` to track the last value it
// rendered; setting `el.value` directly goes through that patched setter, so
// React sees no change and never fires `onChange`. The native setter (grabbed
// before any patching) is what `TranscriptionSettings.test.tsx` uses for the
// same reason.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)!.set!;

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/**
 * Lets queued microtasks and timers run. Several rounds, not one: a tag write
 * is an IndexedDB round trip and fake-indexeddb resolves on timers, so a
 * single tick is marginal - enough when this file runs alone, not enough
 * under full-suite contention, where it produced an intermittent failure in
 * the two tests that await a write. Matches `NotesView.test.tsx`'s own
 * `settle(rounds = 4)` for the same reason.
 */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('TagEditor', () => {
  it('renders existing tags as removable chips', async () => {
    const onChanged = vi.fn();
    await act(async () => {
      root.render(<TagEditor noteId="n1" tags={['seminar', 'week-3']} onChanged={onChanged} />);
    });

    expect(container.textContent).toContain('seminar');
    expect(container.textContent).toContain('week-3');
    expect(container.querySelector('button[aria-label="Remove tag seminar"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Remove tag week-3"]')).not.toBeNull();
  });

  it('adds a tag through setNoteTags and reports the change', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
    const onChanged = vi.fn();
    await act(async () => {
      root.render(<TagEditor noteId={note.id} tags={[]} onChanged={onChanged} />);
    });

    await type(input(), 'Seminar');
    await click(buttonByText('Add tag'));
    await settle();

    expect(onChanged).toHaveBeenCalled();
    expect((await getNote(note.id))?.tags).toEqual(['seminar']);
    expect(input().value).toBe('');
  });

  it('adds a tag on Enter in the input', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
    const onChanged = vi.fn();
    await act(async () => {
      root.render(<TagEditor noteId={note.id} tags={[]} onChanged={onChanged} />);
    });

    await type(input(), 'thesis');
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect((await getNote(note.id))?.tags).toEqual(['thesis']);
  });

  it('removes a tag through setNoteTags and reports the change', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
    await setNoteTags(note.id, ['seminar', 'week-3']);
    const onChanged = vi.fn();
    await act(async () => {
      root.render(
        <TagEditor noteId={note.id} tags={['seminar', 'week-3']} onChanged={onChanged} />,
      );
    });

    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove tag seminar"]',
    );
    if (!removeButton) throw new Error('no remove button');
    await click(removeButton);
    await settle();

    expect(onChanged).toHaveBeenCalled();
    expect((await getNote(note.id))?.tags).toEqual(['week-3']);
  });

  it('ignores a blank submission', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
    const onChanged = vi.fn();
    await act(async () => {
      root.render(<TagEditor noteId={note.id} tags={[]} onChanged={onChanged} />);
    });

    await type(input(), '   ');
    await click(buttonByText('Add tag'));
    await settle();

    expect(onChanged).not.toHaveBeenCalled();
    expect((await getNote(note.id))?.tags ?? []).toEqual([]);
  });

  it('a failing write on add leaves the draft intact, saves nothing, and shows a message', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
    const onChanged = vi.fn();
    await act(async () => {
      root.render(<TagEditor noteId={note.id} tags={[]} onChanged={onChanged} />);
    });

    hooks.failSetNoteTags = 1;
    await type(input(), 'thesis');
    await click(buttonByText('Add tag'));
    await settle();

    expect(onChanged).not.toHaveBeenCalled();
    expect((await getNote(note.id))?.tags ?? []).toEqual([]);
    // The typed text must survive a failed write - it is the owner's only copy.
    expect(input().value).toBe('thesis');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save");
  });

  it('a failing write on remove leaves the chip and shows a message', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
    await setNoteTags(note.id, ['seminar']);
    const onChanged = vi.fn();
    await act(async () => {
      root.render(<TagEditor noteId={note.id} tags={['seminar']} onChanged={onChanged} />);
    });

    hooks.failSetNoteTags = 1;
    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove tag seminar"]',
    );
    if (!removeButton) throw new Error('no remove button');
    await click(removeButton);
    await settle();

    expect(onChanged).not.toHaveBeenCalled();
    expect((await getNote(note.id))?.tags).toEqual(['seminar']);
    // The chip must still be backed by a tag that is actually still on the note.
    expect(container.querySelector('button[aria-label="Remove tag seminar"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save");
  });
});
