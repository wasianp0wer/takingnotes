# S5 — Tags: feature spec

Source requirements: `docs/spec-phase3.md` (K3, K36–K38), `docs/architecture.md`
§8 (foundations contract, §8.2 repository functions, §8.4 mount points),
`docs/assumptions.md` (A35).

## Goal

Let the owner tag a note and use those tags to narrow the sidebar's note list.
A note after a week of use is otherwise findable only by scrolling a flat,
newest-first list. Tags are the owner's own grouping (a term's seminars, a
course), entered free-form and reused via autocomplete once they exist.

⚑ The one rule that must hold under any filter state: the note currently
being written (`state.activeNoteId`) is never silently dropped from the
sidebar by a tag filter. Pen input always lands in the active note, wherever
the sidebar happens to be scrolled or filtered; if the owner cannot find it in
the list, they cannot get back to it to check it, and nothing told them why.

## What the foundations already guarantee (read from the code)

- `src/storage/notes.ts` (Wave 1, off limits to edit):
  - `normalizeTags(input: readonly string[]): string[]` — trims, lowercases,
    dedupes, drops blanks, preserves first-seen order.
  - `tagsOf(note: NoteRecord): readonly string[]` — `note.tags ?? []`. The
    return type is `readonly`; nothing may cast that away.
  - `setNoteTags(id: string, tags: readonly string[]): Promise<NoteRecord>` —
    the one writer; normalizes before calling `updateNote`.
  - `listTagVocabulary(): Promise<string[]>` — every distinct tag across all
    notes, sorted, derived by scanning `listNotes()` on each call (A35).
- `src/storage/types.ts`: `NoteRecord.tags?: string[]`, absent reads as `[]`.
- `src/notes/NoteList.tsx` (off limits): exposes `filter?: ReactNode` rendered
  above the list, and `rowActions?: (note) => ReactNode` (S1's slot, not
  mine). Its empty state is the fixed string `"No notes yet — write on the pad
  to start one."` — not reachable or reworded by S5 (§8.4's note to me).
- `src/notes/NoteToolbar.tsx` (off limits): exposes `meta?: ReactNode`
  rendered directly under the title/title-slot.
- `src/notes/NotesView.tsx` (shared, mine to extend, not to redesign): owns
  `selectedNoteId`, reads `{ notes, pages }` from `useNotesData`, and composes
  `NoteList` + `NoteToolbar`. `notes` is passed straight through to
  `NoteList`'s `notes` prop; nothing today filters it.
- `src/notes/useNotesData.ts` (mine): `useNotesData(selectedNoteId, queue)`
  calls `listNotes()` on four triggers (`activeNoteId`, `activePageId`,
  `pageIndex`, a `revision` counter bumped by the transcription queue) and
  returns `{ notes, pages }`. **Only `NotesView.tsx` consumes this hook** —
  checked by grep before changing its return shape, per Wave 1's post-mortem
  about a changed return value silently breaking untouched call sites.
- `src/capture/CaptureContext.ts` / `useCaptureState()`: gives `activeNoteId`,
  the id `resumeNote`/`startNote`/pen input writes into. This is the note the
  ⚑ rule protects.
- House component-test pattern (no `@testing-library/react`): `createRoot` +
  `act`, `container.querySelector`, the `buttons()` / `buttonByText()` /
  `click()` helpers from `NotesView.test.tsx`.

## Decisions implemented

- **K3 (UI half)** — tags are displayed exactly as normalized (lowercase,
  trimmed); there is no separate display form to keep in sync. Editing
  surfaces this directly: what the owner sees in a chip is what is stored.
- **K36** — tags attach to notes only. `TagEditor` writes through
  `setNoteTags(noteId, …)`; nothing here touches `SessionRecord` or
  `RecordingRecord` or `TaskRecord`.
- **K37** — the sidebar filter bar (`TagFilterBar`, mounted at
  `NoteList.filter`) shows every tag in the vocabulary as a toggleable chip,
  and an AND/OR mode toggle once two or more tags are selected (with zero or
  one tag selected the two modes agree, so the toggle only appears where the
  choice is live — it is still legible by inspection at any time the owner has
  something selected).
- **K38** — `TagEditor` mounts at `NoteToolbar.meta`, under the title/title
  slot. It does not reorder `listNotes()`'s result; sort order is untouched.
- **A35** — `TagFilterBar`'s autocomplete source is `listTagVocabulary()`,
  called by `useNotesData` on the same reload triggers it already uses (no
  new cache, no new store).

## Design

### `src/notes/tagFilter.ts` — pure matching (new)

```ts
export type TagFilterMode = 'and' | 'or';

export function matchesTagFilter(
  tags: readonly string[],
  selected: readonly string[],
  mode: TagFilterMode,
): boolean;
```

- `selected.length === 0` → `true` always: no filter selected means nothing is
  excluded. This is what keeps the list showing everything before the owner
  has touched the filter bar.
- `mode === 'and'` → every selected tag must be present in `tags`.
- `mode === 'or'` → at least one selected tag must be present in `tags`.
- Case/whitespace are not re-normalized here: both `tags` (from `tagsOf`) and
  `selected` (built only from vocabulary entries, themselves already
  normalized) are already normalized by the time they reach this function, so
  it does a plain `Array.includes` — no silent double-normalization to debug
  later when `normalizeTags`'s rules change.

### `src/notes/useNotesData.ts` — filtering (extended, existing file)

Adds tag-filter state and derives the sidebar's visible set, without changing
the meaning of the `pages` result or of `notes` for existing callers besides
the one addition below.

```ts
export interface NotesData {
  /** Every note, newest first — unchanged meaning from before S5. */
  notes: NoteRecord[];
  /**
   * `notes`, narrowed by the tag filter, with the active note always present
   * even when it does not match (⚑). This is what the sidebar renders.
   */
  visibleNotes: NoteRecord[];
  pages: PageRecord[];
  tagFilter: {
    vocabulary: string[];
    selected: string[];
    mode: TagFilterMode;
    /** notes.length - visibleNotes.length: never counts the active note. */
    hiddenCount: number;
    /** True iff the active note exists, a filter is active, and it would not match. */
    activeNoteExempted: boolean;
    toggleTag: (tag: string) => void;
    setMode: (mode: TagFilterMode) => void;
    clear: () => void;
  };
  /** Forces a reload outside the four existing triggers — used after a tag write. */
  refresh: () => void;
}
```

- `notes` keeps its old meaning deliberately: `NotesView`'s existing selection
  /fallback/follow-the-active-note logic (`notes.find`, `notes[0]`) is **not**
  touched, so a note that the filter hides from the sidebar is still
  selectable, viewable and editable — only its sidebar *row* disappears. This
  is what stops a filter from taking away a note the owner already has open,
  as a side effect of a filter picked for a different reason.
- `visibleNotes = notes.filter(n => n.id === activeNoteId || matchesTagFilter(tagsOf(n), selected, mode))`.
  The `n.id === activeNoteId` clause is the ⚑ rule's implementation: the active
  note's row is never removed by the filter. Filtering, not reordering: a note
  kept this way stays at its `listNotes()` position.
- `hiddenCount = notes.length - visibleNotes.length`. Because the active note
  is always in `visibleNotes`, it is never counted as hidden, even when it
  would not otherwise match — it is exempted, not hidden-but-shown-anyway.
- `activeNoteExempted`: `true` when there is an active note, at least one tag
  is selected, and that note's own tags do not satisfy `matchesTagFilter`.
  This is the "say plainly" half of the ⚑ rule for the one case where
  "kept visible" and "matches the filter" disagree — `TagFilterBar` turns this
  into a sentence.
- `vocabulary` comes from `listTagVocabulary()`, fetched on the same effect
  (and same dependency list) that already calls `listNotes()`, so a tag typed
  moments ago on another note shows up in autocomplete as soon as the next
  reload trigger fires.
- `toggleTag`/`setMode`/`clear` are plain `useState` setters (filter state is
  view-local, not persisted — reopening the app always starts unfiltered).
  `toggleTag` adds the tag if absent, removes it if present.
- `refresh()` bumps a second internal counter folded into the same dependency
  list as `revision`. Needed because a tag write (`setNoteTags`) is not one of
  the four existing reload triggers — a note's tags can change with no new
  page, no queue event, and no active-note change at all.

### `src/notes/TagEditor.tsx` — inline tag editing (new), mounts at `NoteToolbar.meta`

```ts
export interface TagEditorProps {
  noteId: string;
  tags: readonly string[];
  onChanged: () => void;
}
```

- Renders each tag as a chip with a labelled remove button
  (`aria-label="Remove tag {tag}"`); removing calls
  `setNoteTags(noteId, tags.filter(t => t !== tag))` then `onChanged()`.
- A text input plus "Add tag" button (and Enter in the input does the same).
  On submit: trims the input; empty submits are ignored; otherwise calls
  `setNoteTags(noteId, [...tags, raw])` — normalization and de-duplication are
  `setNoteTags`'s job, not re-implemented here — then clears the input and
  calls `onChanged()`. The "Add tag" button and the input are both disabled
  while a write (add or remove) is outstanding, so a slow `setNoteTags` cannot
  be raced by a second click into two overlapping writes.
- `NotesView` renders this only when a note is selected (mirrors how `title`
  and the plain-title fallback already work) — there is nothing to tag with no
  note.

### `src/notes/TagFilterBar.tsx` — sidebar filter (new), mounts at `NoteList.filter`

```ts
export interface TagFilterBarProps {
  vocabulary: string[];
  selected: string[];
  mode: TagFilterMode;
  hiddenCount: number;
  activeNoteExempted: boolean;
  onToggleTag: (tag: string) => void;
  onModeChange: (mode: TagFilterMode) => void;
  onClear: () => void;
}
```

- Renders nothing (`null`) when `vocabulary` is empty and nothing is selected
  — a brand-new library has no tags to filter by, and an empty filter bar is
  just noise above the list.
- Every vocabulary tag renders as a toggle button (`aria-pressed` reflecting
  membership in `selected`); clicking calls `onToggleTag(tag)`.
- The AND/OR toggle (two buttons, `aria-pressed` on the active one) renders
  only when `selected.length > 1` — exactly the condition under which AND and
  OR can disagree (K37: "the choice needs to be legible" is satisfied by
  showing it whenever there is a choice to make, and not cluttering the bar
  before there is one).
- A status line renders when `hiddenCount > 0` or `activeNoteExempted`:
  - `hiddenCount > 0` → `"{n} note{s} hidden by this filter."` plus a "Clear
    filter" button (`onClear`) — the fix for the ⚑-adjacent trap called out in
    `architecture.md` §8.4: `NoteList`'s empty state says "No notes yet", which
    would read as "you have no notes" rather than "no notes match", if two
    hundred notes are filtered down to zero with no explanation sitting above
    that empty list. This status line is that explanation, and it is `S5`'s
    inside its own slot.
  - `activeNoteExempted` → `"The note you're writing doesn't match this filter
    — shown anyway."` — the ⚑ rule's "say plainly" half, for the one case
    where the active note is visible but would not otherwise qualify.
- "Clear filter" calls `onClear` (`tagFilter.clear()`), which resets both
  `selected` to `[]` and `mode` to its default — not just `selected`, so a
  forgotten AND/OR choice from an earlier session of filtering does not
  silently narrow the very next filter the owner builds.

### `src/notes/NotesView.tsx` — wiring (existing file, minimal diff)

- `visibleNotes` (not `notes`) is passed to `NoteList`'s `notes` prop.
- `NoteList`'s `filter` prop becomes `<TagFilterBar {...tagFilter-derived props} />`.
- `NoteToolbar`'s `meta` prop becomes
  `selectedNote ? <TagEditor noteId={selectedNote.id} tags={tagsOf(selectedNote)} onChanged={refresh} /> : undefined`.
- Every other read of `notes` (selection fallback, `selectedNote = notes.find(...)`,
  the active-note-follow effect) keeps using the hook's `notes`, unchanged —
  per the design note above, filtering must not remove the owner's ability to
  view or edit a note that just stopped appearing in the sidebar.

## Behavioural rules

1. Selecting zero tags shows every note; this is the resting state and must
   round-trip (toggle a tag on then off returns to showing everything).
2. AND with two or more tags shows exactly the notes carrying every one of
   them; OR shows the union. Switching the mode with the same selection must
   change which notes are visible whenever AND and OR actually disagree for
   that selection (asserted in tests by naming which notes are shown and which
   are not — not just by count).
3. ⚑ The active note's sidebar row is present under every filter state. When
   the active note does not match the current filter, the filter bar states
   this in words; it is never just silently included with no explanation and
   never just silently dropped.
4. A filter that matches nothing still leaves `NoteList` with an empty list,
   and its fixed "No notes yet" string is not S5's to change (§8.4). The
   filter bar's own "N notes hidden" + "Clear filter" sits above that empty
   list and is what keeps "no notes match" distinguishable from "you have no
   notes" — satisfied by construction, since the status line's visibility
   condition (`hiddenCount > 0`) exactly covers "the filter is hiding
   something".
5. Tags are edited only through `setNoteTags`; nothing in `src/notes/` computes
   a tag list by hand and writes it with a different function.
6. Removing the last tag from a note is a normal edit (`setNoteTags(id, [])`),
   not a special case — an untagged note is a valid note.
7. The vocabulary autocompletes only tags that exist on at least one note
   right now; a tag removed from every note it was on disappears from the
   filter bar on the next reload (it was never cached).

## Assumptions

- **S5-A1**: Tag-filter state (`selected`, `mode`) is view-local
  (`useState` inside `useNotesData`), not persisted to `settingKeys.ts` or
  IndexedDB. Reopening the app, or navigating away from Notes and back inside
  one session (the component unmounts either way, since `NotesView` holds the
  state), resets the filter to unfiltered. The spec does not ask for a
  remembered filter, and persisting view state the owner didn't ask to keep
  would be a second thing to go stale.
- **S5-A2**: The AND/OR mode's default is `'or'`. Chosen because building up a
  selection one click at a time under OR only ever widens the result, which
  matches how a chip-toggle UI is actually used (click tags one at a time);
  under AND, each additional click can narrow the list to nothing with no
  warning until the owner explicitly asks for the narrower behaviour. The
  owner can switch to AND once there are two or more tags selected to see the
  effect compared against OR.
- **S5-A3**: `visibleNotes` (not `notes`) is the only thing S5 changes about
  what reaches `NoteList`. `selectedNote` resolution, the default-selection
  fallback, and the active-note-follow effect in `NotesView` all keep reading
  the hook's unfiltered `notes`, so a filter can hide a row without also
  taking away the ability to view or tag that note through whatever currently
  has it open (the toolbar, the canvas). This is a deliberate reading of the
  ⚑ rule: filtering is scoped to "what shows in the list", never to "what the
  rest of the view can reach".
- **S5-A4**: `TagFilterBar` renders nothing when the vocabulary is empty and
  nothing is selected, rather than an always-visible empty bar. A first-run
  library with no tags yet has nothing to filter by; showing the bar anyway
  would just be chrome with no function, and it reappears the moment the
  first tag exists (the vocabulary is scanned fresh each reload, A35).
