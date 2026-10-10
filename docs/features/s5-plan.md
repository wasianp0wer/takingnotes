# S5 Tags Implementation Plan

**Goal:** tag editing on a note (`TagEditor`, mounted at `NoteToolbar.meta`)
and a tag filter bar for the sidebar (`TagFilterBar`, mounted at
`NoteList.filter`), with AND/OR filtering in `useNotesData`, never silently
hiding the note currently being written.

**Spec:** `docs/features/s5-spec.md` — read "Design" and "Behavioural rules"
before starting any task.

## Global constraints

- Work only in this worktree, branch `wave2/s5-tags`. Never push, never touch
  `main`, never bare `git stash`.
- Create/edit only: `src/notes/tagFilter.ts` (new), `src/notes/TagEditor.tsx`
  (new), `src/notes/TagFilterBar.tsx` (new), `src/notes/useNotesData.ts`
  (extend), `src/notes/NotesView.tsx` (extend), plus each new file's
  `*.test.ts(x)`. Do **not** edit `src/storage/notes.ts`, `src/notes/NoteList.tsx`,
  `src/notes/NoteToolbar.tsx`, `src/capture/**`, `src/audio/**`, `src/triage/**`.
- Import alias `@/` = `src/`. Tests sit beside sources.
- No `@testing-library/react`. Component tests: `createRoot` + `act`, under
  happy-dom, the `buttons()` / `buttonByText()` / `click()` helpers copied from
  `src/notes/NotesView.test.tsx`.
- Tags are read/written only through `normalizeTags`, `tagsOf`, `setNoteTags`,
  `listTagVocabulary` from `@/storage/notes`. No new writer.
- Commands before every commit: `npm test`, `npx tsc -b`, `npm run lint`,
  `npm run build`. All four pass.
- Mutation-check every new test: after it's green, break the implementation
  (comment out the key line / invert a condition), confirm the test goes red,
  then revert. Note any test that did not catch its mutation in the final
  report rather than silently leaving it.
- Commit after each task. Message ends with a blank line then
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## Task 1 — `matchesTagFilter` (pure)

**Files:** create `src/notes/tagFilter.ts`, `src/notes/tagFilter.test.ts`.

- [ ] Write the failing test first:

```ts
import { describe, expect, it } from 'vitest';
import { matchesTagFilter } from '@/notes/tagFilter';

describe('matchesTagFilter', () => {
  it('matches everything when nothing is selected', () => {
    expect(matchesTagFilter([], [], 'and')).toBe(true);
    expect(matchesTagFilter(['history'], [], 'or')).toBe(true);
  });

  it('AND requires every selected tag', () => {
    expect(matchesTagFilter(['seminar', 'week-3'], ['seminar', 'week-3'], 'and')).toBe(true);
    expect(matchesTagFilter(['seminar'], ['seminar', 'week-3'], 'and')).toBe(false);
  });

  it('OR requires at least one selected tag', () => {
    expect(matchesTagFilter(['seminar'], ['seminar', 'week-3'], 'or')).toBe(true);
    expect(matchesTagFilter(['lecture'], ['seminar', 'week-3'], 'or')).toBe(false);
  });

  it('a note with no tags never matches a non-empty selection', () => {
    expect(matchesTagFilter([], ['seminar'], 'or')).toBe(false);
    expect(matchesTagFilter([], ['seminar'], 'and')).toBe(false);
  });
});
```

- [ ] Run it, confirm it fails (module doesn't exist yet).
- [ ] Implement:

```ts
export type TagFilterMode = 'and' | 'or';

/**
 * S5-K37: AND narrows to notes carrying every selected tag, OR widens to any.
 * `tags` and `selected` are assumed already normalized (both ultimately come
 * from `tagsOf` / the vocabulary) - this is a plain membership check, not a
 * second normalization pass.
 */
export function matchesTagFilter(
  tags: readonly string[],
  selected: readonly string[],
  mode: TagFilterMode,
): boolean {
  if (selected.length === 0) return true;
  return mode === 'and'
    ? selected.every((tag) => tags.includes(tag))
    : selected.some((tag) => tags.includes(tag));
}
```

- [ ] Run, confirm green.
- [ ] Mutation-check: flip `every`↔`some` for one case, confirm the AND/OR
      tests go red; flip the `selected.length === 0` guard to `> 0`, confirm
      the first test goes red. Revert both.
- [ ] `npx tsc -b && npm run lint`.
- [ ] Commit: `feat(notes): add pure AND/OR tag-filter matching`.

---

## Task 2 — `useNotesData` grows a tag filter

**Files:** edit `src/notes/useNotesData.ts`; create `src/notes/useNotesData.test.tsx`
(a thin host component, since the hook isn't exported standalone-testable
without React — see "Test harness" below).

**Test harness** (no hook-testing library available): a tiny host component
renders the hook's output into the DOM as text/attributes the test can read,
following the project's "test through a component" convention.

```tsx
// src/notes/useNotesData.test.tsx
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
      <button type="button" onClick={() => data.tagFilter.setMode(data.tagFilter.mode === 'and' ? 'or' : 'and')}>
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
    const b = await createNote({ title: 'Beta', deviceId: 'huion', pageBaseline: 0 });
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
```

- [ ] Run, confirm every new test fails (hook has no `visibleNotes`/`tagFilter`
      yet - a type error is an acceptable "fails").
- [ ] Implement in `useNotesData.ts`:
  - Add `TagFilterMode` import from `@/notes/tagFilter`, plus `matchesTagFilter`.
  - Add `useState<string[]>([])` for `selected`, `useState<TagFilterMode>('or')`
    for `mode`, `useState<string[]>([])` for `vocabulary`, and a `refreshNonce`
    counter (`useState(0)`).
  - Fetch vocabulary in the same effect that calls `listNotes()` (or a sibling
    effect with the same dependency array plus `refreshNonce`), via
    `listTagVocabulary()` from `@/storage/notes`.
  - `activeNoteId` already destructured from `useCaptureState()`.
  - Compute (not in state - derived each render):
    ```ts
    const visibleNotes = notes.filter(
      (n) => n.id === activeNoteId || matchesTagFilter(tagsOf(n), selected, mode),
    );
    const hiddenCount = notes.length - visibleNotes.length;
    const activeNote = activeNoteId ? notes.find((n) => n.id === activeNoteId) ?? null : null;
    const activeNoteExempted =
      activeNote !== null &&
      selected.length > 0 &&
      !matchesTagFilter(tagsOf(activeNote), selected, mode);
    ```
  - `toggleTag = (tag) => setSelected((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])`.
  - `clear = () => { setSelected([]); setMode('or'); }`.
  - `refresh = () => setRefreshNonce((n) => n + 1)`; add `refreshNonce` to both
    existing reload effects' dependency arrays.
  - Return `{ notes, visibleNotes, pages, tagFilter: {...}, refresh }`.
- [ ] Run, confirm green.
- [ ] Mutation-check each test individually:
  - "shows every note when nothing selected": temporarily make `visibleNotes`
    always `[]`; confirm it goes red; revert.
  - "OR widens, AND narrows": swap the default mode to `'and'`; confirm the
    first assertion (still OR before flipping) goes red; revert.
  - "⚑ keeps the active note visible": remove the `n.id === activeNoteId`
    clause from the filter; confirm "Live note" drops out of `visible` and the
    test goes red; revert.
  - "clear resets both": make `clear` only reset `selected`; confirm `mode`
    assertion goes red; revert.
  - "vocabulary autocompletes": break `listTagVocabulary` call (return `[]`
    hardcoded); confirm red; revert.
- [ ] `npx tsc -b && npm run lint`.
- [ ] Commit: `feat(notes): filter the notes list by AND/OR tag selection`.

---

## Task 3 — `TagFilterBar`

**Files:** create `src/notes/TagFilterBar.tsx`, `src/notes/TagFilterBar.test.tsx`.

- [ ] Write the failing test:

```tsx
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TagFilterBar } from '@/notes/TagFilterBar';

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

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}
function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button ${text}; have ${buttons().map((b) => b.textContent)}`);
  return found;
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('TagFilterBar', () => {
  it('renders nothing when there is no vocabulary and no selection', async () => {
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={[]}
          selected={[]}
          mode="or"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toBe('');
  });

  it('toggles a tag by calling onToggleTag', async () => {
    const onToggleTag = vi.fn();
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar', 'lecture']}
          selected={['seminar']}
          mode="or"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={onToggleTag}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });

    expect(buttonByText('seminar').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText('lecture').getAttribute('aria-pressed')).toBe('false');

    await click(buttonByText('lecture'));
    expect(onToggleTag).toHaveBeenCalledWith('lecture');
  });

  it('shows the AND/OR toggle only once two or more tags are selected', async () => {
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar', 'lecture']}
          selected={['seminar']}
          mode="or"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    expect(container.textContent).not.toContain('Match all');

    const onModeChange = vi.fn();
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar', 'lecture']}
          selected={['seminar', 'lecture']}
          mode="or"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={onModeChange}
          onClear={vi.fn()}
        />,
      );
    });
    expect(buttonByText('Match any').getAttribute('aria-pressed')).toBe('true');
    await click(buttonByText('Match all'));
    expect(onModeChange).toHaveBeenCalledWith('and');
  });

  it('states the hidden count and offers Clear filter', async () => {
    const onClear = vi.fn();
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar']}
          selected={['seminar']}
          mode="or"
          hiddenCount={3}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={onClear}
        />,
      );
    });
    expect(container.textContent).toContain('3 notes hidden by this filter');
    await click(buttonByText('Clear filter'));
    expect(onClear).toHaveBeenCalled();
  });

  it('states plainly when the active note is shown despite not matching', async () => {
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar']}
          selected={['seminar']}
          mode="or"
          hiddenCount={0}
          activeNoteExempted
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("doesn't match this filter");
  });
});
```

- [ ] Run, confirm it fails (`TagFilterBar` module missing).
- [ ] Implement `TagFilterBar.tsx` per the spec's "Design" section (tag
      toggle buttons, AND/OR toggle gated on `selected.length > 1`, status
      line gated on `hiddenCount > 0 || activeNoteExempted`, singular "1 note
      hidden" vs plural).
- [ ] Run, confirm green.
- [ ] Mutation-check:
  - Empty-render test: remove the early-`null` guard; confirm it goes red
    (renders a non-empty wrapper); revert.
  - Toggle test: change the click handler to call `onToggleTag('seminar')`
    unconditionally (hardcode the arg); confirm "called with 'lecture'" goes
    red; revert.
  - AND/OR gating test: change the gate to `selected.length > 0`; confirm the
    "not.toContain('Match all')" assertion (at one selected tag) goes red;
    revert.
  - Hidden-count test: hardcode the status line to always read "0 notes
    hidden"; confirm red; revert.
  - Exempted test: remove the `activeNoteExempted` branch; confirm red; revert.
- [ ] `npx tsc -b && npm run lint`.
- [ ] Commit: `feat(notes): add the sidebar tag filter bar`.

---

## Task 4 — `TagEditor`

**Files:** create `src/notes/TagEditor.tsx`, `src/notes/TagEditor.test.tsx`.

- [ ] Write the failing test:

```tsx
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TagEditor } from '@/notes/TagEditor';
import { createNote, getNote, setNoteTags } from '@/storage/notes';
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

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}
function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button ${text}; have ${buttons().map((b) => b.textContent)}`);
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
async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    // input clears after a successful add
    expect(input().value).toBe('');
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

    await click(container.querySelector('button[aria-label="Remove tag seminar"]')!);
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
});
```

- [ ] Run, confirm it fails.
- [ ] Implement `TagEditor.tsx` per the spec: chips with remove buttons, a
      controlled text input plus "Add tag" button, Enter-to-submit, a
      `saving` flag disabling the input/button while the write is in flight,
      clear-on-success.
- [ ] Run, confirm green.
- [ ] Mutation-check:
  - "renders existing tags": rename the `aria-label` template (drop the tag
    name); confirm the chip-remove-button assertion goes red; revert.
  - "adds a tag": skip calling `onChanged()` after a successful write; confirm
    red; revert. Separately: don't clear the input; confirm the
    `input().value` assertion goes red; revert.
  - "removes a tag": pass the wrong filter (e.g. keep all tags) to
    `setNoteTags` on remove; confirm the persisted-tags assertion goes red;
    revert.
  - "ignores a blank submission": remove the blank-guard; confirm `onChanged`
    gets called and the test goes red; revert.
- [ ] `npx tsc -b && npm run lint`.
- [ ] Commit: `feat(notes): add inline tag editing for the selected note`.

---

## Task 5 — Wire both components into `NotesView`

**Files:** edit `src/notes/NotesView.tsx`. Extend `src/notes/NotesView.test.tsx`
with new cases (additive only — every existing case must keep passing
unmodified, since `architecture.md` §8.4 and the P1 plan both call out that
file's existing assertions as load-bearing for other units).

- [ ] Write the failing tests, appended to `NotesView.test.tsx`'s `describe`
      block, written against the components as designed:

```tsx
  it('filters the sidebar by tag and keeps the active note visible (⚑)', async () => {
    const tagged = await seedNote({ title: 'Tagged seminar' });
    await setNoteTags(tagged.id, ['seminar']);
    await seedNote({ title: 'Untagged note' });

    await render();
    await click(buttonByText('New note')); // starts and activates a fresh, untagged note

    await click(buttonByText('seminar')); // the filter chip

    expect(container.textContent).toContain('Tagged seminar');
    expect(container.textContent).not.toContain('Untagged note');
    // The just-started note is untagged and would not match "seminar", but
    // it is the active note, so its row must still be present (⚑).
    expect(container.textContent).toContain('Note '); // engine default title prefix
    expect(container.textContent).toContain("doesn't match this filter");
  });

  it('tagging a note through the toolbar updates the sidebar vocabulary', async () => {
    const note = await seedNote({ title: 'Needs a tag' });
    await render();
    await click(buttonByText(note.title));

    const input = container.querySelector('input[placeholder="Add a tag"]') as HTMLInputElement;
    await act(async () => {
      input.value = 'thesis';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonByText('Add tag'));
    await settle();

    expect(container.textContent).toContain('thesis');
    // The filter bar's chip for the new tag.
    expect(buttonByText('thesis')).toBeTruthy();
  });
```

  (Import `setNoteTags` from `@/storage/notes` at the top of the test file
  alongside the existing `createNote`/`createPage`/`setPageTranscript`
  import.)

- [ ] Run, confirm both new tests fail (no filter chips / no tag editor exist
      in the rendered tree yet).
- [ ] Implement the `NotesView.tsx` wiring exactly as the spec's "Design"
      section describes:
  - Destructure `visibleNotes`, `tagFilter`, `refresh` from `useNotesData`'s
    result alongside the existing `notes`, `pages`.
  - `<NoteList notes={visibleNotes} ... filter={<TagFilterBar vocabulary={tagFilter.vocabulary} selected={tagFilter.selected} mode={tagFilter.mode} hiddenCount={tagFilter.hiddenCount} activeNoteExempted={tagFilter.activeNoteExempted} onToggleTag={tagFilter.toggleTag} onModeChange={tagFilter.setMode} onClear={tagFilter.clear} />} />`
  - `<NoteToolbar ... meta={selectedNote ? <TagEditor noteId={selectedNote.id} tags={tagsOf(selectedNote)} onChanged={refresh} /> : undefined} />`
  - Import `tagsOf` from `@/storage/notes`.
  - Leave every other line (selection fallback, `selectedNote = notes.find(...)`,
    page navigation) untouched - they keep reading `notes`, per spec S5-A3.
- [ ] Run the full `NotesView.test.tsx` file, confirm **all** cases (old and
      new) pass.
- [ ] Mutation-check the two new tests:
  - Filter test: pass `notes` (not `visibleNotes`) to `NoteList`; confirm the
    "not.toContain('Untagged note')" assertion goes red (everything shows, no
    filtering happened); revert. Then remove the `n.id === activeNoteId`
    force-include clause in the hook (already mutation-checked in Task 2, but
    re-confirm it is this integration test, not just the hook test, that would
    catch a regression here too): confirm the "contains 'Note '" assertion
    goes red; revert.
  - Tagging test: don't call `refresh()` from `TagEditor`'s `onChanged`;
    confirm the new tag fails to appear as a filter chip (stale vocabulary);
    revert.
- [ ] `npx tsc -b`, `npm run lint`, `npm run build`, full `npm test`.
- [ ] Commit: `feat(notes): mount tag editing and the tag filter bar in NotesView`.

---

## Task 6 — Final verification pass

- [ ] Re-run `npm test` in full; confirm the total test count is the Task 1-5
      baseline (1145 at Wave 1 handoff) plus every test added here, and that
      no previously-passing test file changed its pass/fail status.
- [ ] `npx tsc -b`, `npm run lint`, `npm run build` - all clean.
- [ ] Re-read `docs/spec-phase3.md` K36-K38 and A35 against the final diff;
      confirm each is satisfied by something concrete in the diff (cite file
      and line in the report).
- [ ] Re-read the ⚑ rule and confirm, by naming the specific test, that it is
      covered twice: once at the hook level (Task 2's test 3) and once at the
      full `NotesView` integration level (Task 5's first new test).
- [ ] Write `docs/features/s5-report.md`: status, files touched, commits,
      test/typecheck/lint/build results, decisions implemented, any mutation
      that did not get caught, concerns. Commit it.
