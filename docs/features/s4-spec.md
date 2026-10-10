# S4 — Typed pages (feature spec)

Product source: `docs/spec-phase3.md` §6 (K32–K35) and A38. Contract:
`docs/architecture.md` §8 (§8.2 for the storage functions this unit consumes,
§8.4 for the `NoteToolbar.actions` mount point). This document pins down the
details those leave open and lists the tests S4 ships.

## 1. Goal

"Add the ability to type notes instead of write them, in case the Huion x10
dies." A typed page is a first-class page like an ink one: it has a
`pageIndex`, it shows up in page navigation, and — because its text is
mirrored into `transcript` (K33) — search and gap analysis read it through
the one field they already know about. Nothing downstream needs to learn a
second text path.

The one rule that needs care (K34, A38): **a pen point arriving while the
active page is typed opens a new live page**, not ink into the typed one. The
pad coming back to life mid-note is the entire reason this feature exists.

## 2. What already exists (Wave 1 foundations)

Read from the code, not assumed:

- `src/storage/types.ts`: `PageSource = 'rom' | 'live' | 'typed'`;
  `PageRecord.text?: string` (absent on ink pages).
- `src/storage/pages.ts` (off limits to edit — S4 only calls these):
  - `isTypedPage(page): boolean` — `page.source === 'typed'`.
  - `createTypedPage({ noteId, pageIndex, text?, capturedAt? }): Promise<PageRecord>`
    — creates a page with `source: 'typed'`, `strokes: []`,
    `devicePageNum: null`, `finalizedAt: null` (open, exactly like a fresh live
    page), then calls `setPageText` to fill it.
  - `setPageText(id, text): Promise<PageRecord>` — writes `page.text` and
    mirrors it into `page.transcript`: non-blank text becomes a `'done'`
    transcript (`model: TYPED_MODEL` = `'typed'`,
    `promptVersion: TYPED_PROMPT_VERSION` = `'typed/1'`); blank text leaves
    `transcript: null`. Throws if the page is not a typed page.
  - `pageEndedAt(page): number` — latest stroke `endedAt`, falling back to
    `capturedAt`. For a typed page (no strokes, ever) this is always
    `capturedAt`.
- `src/capture/engine.ts` (`createCaptureEngine`), the piece this unit
  extends. Two structures carry its whole design, per its own header comment:
  - **The buffer**: the in-memory tail of ink for the page currently being
    written. `buffer.pageId` is the id of whatever live page the buffer
    belongs to, or `null` before that page's record exists yet.
  - **The op chain** (`enqueue`): every database write is serialized, so two
    calls arriving in the same tick can't both read stale state and both
    "win". `noteOpen`/`openerSeq` are **synchronous** flags, flipped before
    any `await`, read by `handlePen` and by the public methods' own
    synchronous preambles — never off the published `state` object, which is
    only current once an op has actually run.
- `src/notes/NoteToolbar.tsx` §8.4 mount point: `actions?: ReactNode`,
  rendered in the button row before page navigation. S4 owns this slot.
- `src/triage/useScratchpad.ts`: the house autosave pattern — debounce a
  write, track "dirty" as `pendingTextRef !== persistedRef` (not a boolean),
  flush on unmount, surface (not swallow) a failed write.

## 3. Decisions implemented

- **K32**: a note mixes handwritten and typed pages freely, in any order,
  including a resumed note. (Already true of the storage layer — `pageIndex`
  doesn't care what `source` a page has. S4's job is to make the engine and
  UI create and show typed pages correctly alongside live ones.)
- **K33**: a typed page's transcript is written by `setPageText` the moment
  its text changes — already shipped (§2). S4 never writes
  `page.transcript` directly.
- **K34** ⚑: pen input while the active page is typed opens a new live page.
  See §4.3.
- **K35**: typed text is autosaved on a debounce, following `useScratchpad`'s
  pattern; the editor is reachable from the toolbar as "Type page".
- **A38**: a typed page never holds ink and an ink page never holds typed
  text. Enforced two ways: (a) the engine's ink `buffer` is never attached to
  a typed page's id (§4.1), so even a defensive `setPageStrokes` call could
  never land on one; (b) K34 moves ink to a fresh page instead of the typed
  one the instant it would otherwise land there.

## 4. Engine design (`src/capture/engine.ts`, `src/capture/types.ts`)

### 4.1 A second synchronous flag: `activeTypedPageId`

The existing `buffer` only ever tracks an **ink** page: `buffer.pageId` is set
once a live page's record exists, and is `null` before that (or when nothing
is open). A typed page is tracked separately, by a new closure variable
mirroring `noteOpen`'s own discipline — flipped synchronously, read
synchronously, never derived from the published `state` object:

```ts
let activeTypedPageId: string | null = null;
```

Invariant maintained throughout: `activeTypedPageId !== null` implies
`noteOpen === true`, and whenever it is non-null, `buffer.pageId` is `null`
(the ink buffer stays "parked" — nothing ever flushes ink onto a typed page,
because nothing ever points it there). Exactly one of "the active page is the
buffer's live page" or "the active page is `activeTypedPageId`" is true
whenever a note is open.

It is set in `newTypedPage()` (§4.2) and cleared — by whichever function is
closing out the current active page — in `closeNote()`, `newPage()`, and the
new `startLivePageAfterTyping()` (§4.3). Those three are exactly the places
that already close out the ink `buffer`'s current page, so the typed case is
added alongside each, not as a new code path.

### 4.2 `newTypedPage(): Promise<string | null>`

Added to `CaptureEngine` (`src/capture/types.ts`) and implemented on the
engine's serial op chain, mirroring `newPage`'s shape exactly:

```ts
/**
 * Finalizes the active page and makes a new *typed* page the active page
 * (K32, K35). No active note -> no-op, resolves null, matching `newPage`'s
 * own rule (A7): starting a note at all (pen input, or "New note") is a
 * precondition, same as the existing "New page" button's own disablement.
 */
newTypedPage(): Promise<string | null>;
```

Implementation, on the chain:

1. Synchronously: `closeBuffer()` (ends any stroke in progress onto the
   outgoing page exactly as a manual page turn would, if the outgoing page is
   live), capture-and-clear `activeTypedPageId`.
2. On the chain: close whichever page was active — `closeOldPage` handles the
   live case (returns its id for the `pageFinalized` emission below); a new
   `finalizeTypedPage(id)` handles the typed case (`finalizePage(id, now())`,
   **no** `pageFinalized` emission — see §4.4 for why).
3. Create the new page via `createTypedPage({ noteId, pageIndex, capturedAt: now() })`.
4. `activeTypedPageId = page.id`; publish state (`activePageId`, `pageIndex`
   advance by one, same as `newPage`).
5. Emit `pageFinalized` for the outgoing page only if it was live.

### 4.3 K34 — pen input while the active page is typed

`handlePen` already has one synchronous decision made off `segmenter.current()`
and `noteOpen`:

```ts
if (segmenter.current() !== null && !noteOpen) void startNote();
```

A second, mutually exclusive branch is added:

```ts
if (segmenter.current() !== null) {
  if (!noteOpen) void startNote();
  else if (activeTypedPageId !== null) startLivePageAfterTyping();
}
```

`startLivePageAfterTyping()` is **not** `newPage`'s pattern reused verbatim:
`newPage`/`newTypedPage` call `closeBuffer()`, which force-ends whatever
stroke is open **onto the outgoing page** — correct for a deliberate page
turn, where the stroke in progress belongs to the page being left. Here the
opposite is true: the stroke that is open is the one that just triggered this
transition (the pad's first point back), and by A38 it must land on the *new*
page, never the typed one being left. So this function does not call
`closeBuffer()` at all — it leaves `buffer` as it is (already parked,
`pageId: null`, and about to receive exactly this stroke) and only clears
`activeTypedPageId`:

```ts
function startLivePageAfterTyping(): void {
  const typedId = activeTypedPageId;
  activeTypedPageId = null; // before any await - same discipline as noteOpen
  const b = buffer;         // same object; the open stroke belongs to it

  void enqueue(async () => {
    if (typedId !== null) await finalizeTypedPage(typedId);
    const noteId = state.activeNoteId;
    if (noteId === null) return; // note closed meanwhile; nothing to attach to
    const pageIndex = state.pageIndex + 1;
    const buffered = [...b.strokes];
    const page = await createPage({
      noteId, pageIndex, devicePageNum: null, source: 'live',
      strokes: buffered, capturedAt: now(),
    });
    b.pageId = page.id;
    if (b.strokes.length === buffered.length) b.dirty = false;
    setState({ ...state, activePageId: page.id, pageIndex });
    void flushBuffer(b);
  });
}
```

`activeTypedPageId` is cleared **before** the first point of the new stroke
can be processed again (it's synchronous, same tick), so the second and later
points of that same down-stroke see `activeTypedPageId === null` and take
neither branch — exactly the same one-shot discipline `noteOpen` already
relies on for auto-start.

### 4.4 Why `recover()` and `resumeNote()` need one small change

Both already scan a note's pages and finalize any that were left open,
pushing every finalized id into a list they emit `pageFinalized` for
afterwards:

```ts
for (const page of pages) {
  if (isPageFinalized(page)) continue;
  await finalizePage(page.id, pageEndedAt(page));
  finalized.push(page.id);
}
```

Neither loop knows about typed pages — they finalize and queue *every*
non-finalized page. If a typed page were ever left open when a note is
interrupted (app closed while it was the active page, before S4 existed to
finalize it on the way out), `recover()` would finalize it correctly but then
also emit `pageFinalized` for it. The transcription queue's
`subscribePageFinalized` handler (`src/transcription/queue.ts`) does not
filter by source — it unconditionally calls `markPending`, which **overwrites
the typed page's `'done'` transcript with `'pending'`** and later tries to run
a handwriting-transcription job against a page with no render and no strokes.
That is a direct violation of K33 ("this is what makes transcription skip
it"), and it would be caused by code S4 isn't even touching directly
(`transcription/queue.ts` is Wave 1's, out of scope to edit).

The fix is confined to the two loops, inside `engine.ts`:

```ts
async function finalizeLeftOpen(page: PageRecord): Promise<string | null> {
  await finalizePage(page.id, pageEndedAt(page));
  return isTypedPage(page) ? null : page.id;
}
```

used in place of the two statements above; `finalized.push(id)` only when the
returned id is non-null. This makes `recover()`/`resumeNote()` correct
regardless of *how* a typed page was left open, not only for the paths S4
closes it through in §4.1–4.3 — defense in depth for a rule flagged ⚑ in the
spec.

(In practice, after §4.1–4.3 land, a typed page's `finalizedAt` is always set
by the time either loop would see it, because every path that stops it being
the active page finalizes it on the way out. This change is the belt to that
suspenders — it also makes the invariant failure-safe for a future unit that
creates a typed page some other way.)

### 4.5 What does *not* change

- `openNote` (shared by `startNote`/`startSession`) always creates a **live**
  page 0. S4 does not add a "start fresh by typing" mode — `newTypedPage`
  requires an existing note, mirroring `newPage`'s own A7 no-op. See §6 for
  why this is a deliberate, scoped choice, not an oversight.
- `resumeNote`'s new page is always live (K11's own contract: appends after
  the last page). Unaffected.
- `closeOldPage` is untouched; it already no-ops (`return null`) when
  `old.pageId === null`, which is always true when the outgoing page was
  typed (§4.1's invariant), so it already does the right nothing.

## 5. UI design

### 5.1 `src/notes/TypedPageEditor.tsx` (new)

A debounced-autosave textarea bound to one page's text, following
`useScratchpad`'s pattern (dirty = `pendingTextRef.current !== persistedRef.current`,
flush on unmount, a visible (not swallowed) error on a failed write — "a
failed write must not lose the owner's typing"). It cannot reuse
`useScratchpad` itself (that hook is hardwired to the single
`triage.scratchpad` setting key); it is a parallel, per-page implementation
writing through `setPageText(pageId, text)` instead.

```ts
export interface TypedPageEditorProps {
  pageId: string;
  /** Seeds local state once; the parent remounts this component per page
   *  (key={page.id}), the same pattern TranscriptPanel/GapPanel already use,
   *  so a stale `initialText` from a previous page is never a concern. */
  initialText: string;
}
```

Internals: `pendingTextRef`/`persistedRef`/`editedRef`/`mountedRef`/`errorRef`
exactly as `useScratchpad`, a 500 ms debounce, and `writeNow` chained on its
own `writeQueueRef` so out-of-order writes to the same page can't happen. The
load step `useScratchpad` has (read the setting on mount) is replaced by
`initialText` being used directly — there is nothing to read, since the
caller already has the `PageRecord`.

### 5.2 `src/notes/NotesView.tsx` (shared mount point)

Per §8.4, S4 edits `NotesView` itself (not `NoteToolbar`/`NoteList`) to:

1. Swap the canvas: when `isTypedPage(viewedPage)`, render
   `<TypedPageEditor key={viewedPage.id} pageId={viewedPage.id} initialText={viewedPage.text ?? ''} />`
   instead of `<InkCanvas .../>`.
2. Mount a "Type page" button into `NoteToolbar`'s `actions` slot, disabled
   when there is no active note (mirrors `PageTurnControls`'s own "New page"
   disablement — same precondition, §4.5), guarded against a double-click the
   same way (`pending` state + an in-flight ref), calling
   `engine.newTypedPage()`.
3. **Not rendering `<TranscriptPanel>` for a typed page.** This is S4's own
   call, not explicitly spec'd: `TranscriptPanel` shows "Transcribed when the
   page is finished" for `isActivePage && !isPageFinalized(page)`, which is
   true of a typed page the moment it's created and stays true for as long as
   it's the active page being typed into — wrong, since a typed page's
   "transcription" is already complete the instant its text is non-blank.
   Showing the panel at all would just duplicate the editor's own content.
   `GapPanel` is left mounted unconditionally (unchanged): it already
   degrades correctly for a strokeless page (`speechWindowForPage` returns
   `null` when `page.strokes` is empty, which is always true of a typed
   page), the same way it already does for a ROM/legacy page with no
   timestamps — nothing new to implement there.

A typed page's editor is shown (and editable) regardless of whether that page
is the currently *active* one or an older page the user has navigated back
to — K32's "any order" extends to editing, consistent with `setPageText`
itself placing no such restriction, and with the engine's `newTypedPage`
being about to-be-written text, not the UI's own navigation.

## 6. S4's own assumptions

- **S4-A1**: `newTypedPage()` requires an active note (no-op → `null`
  otherwise), the same precondition `newPage`'s A7 already enforces for the
  on-screen "New page" button. The spec's "in case the pad dies" scenario is
  about a note already in progress; starting a *brand new* note by typing
  (no pen input at all, ever) is out of scope for this wave, and would have
  required teaching `openNote` a second first-page shape purely for a
  scenario the owner didn't ask for. "New note" (pen, or the existing button)
  followed by "Type page" covers it in two clicks.
- **S4-A2**: `TranscriptPanel` is not rendered for a typed page (§5.2.3) — a
  judgement call to avoid a wrong, confusing status message, not something
  `docs/spec-phase3.md` states directly.
- **S4-A3**: a typed page's editor is reachable (and editable) for any typed
  page the user navigates to, not only the active one. Nothing in K32/K35
  restricts this, and restricting it would need new, unspecified UI state.
- **S4-A4**: `recover()`/`resumeNote()`'s finalize-loops are made
  source-aware (§4.4) as defense in depth for A38, independent of whether the
  three engine paths in §4.1–4.3 already prevent an unfinalized typed page
  from reaching them in practice.

## 7. Tests S4 ships

`src/capture/engine.test.ts` (append):
- `newTypedPage` creates a typed page, advances `pageIndex`, finalizes the
  outgoing live page and emits `pageFinalized` for it.
- `newTypedPage` from an already-typed active page finalizes the old typed
  page **without** emitting `pageFinalized` for it.
- `newTypedPage` is a no-op (`null`) with no active note.
- Pen input while the active page is typed opens a new live page: the typed
  page keeps `strokes: []`; the new page is live and holds the ink.
- The stroke that triggers the transition is not split — all its points land
  on the new live page, not partly on the old one.
- `recover()` finalizes a typed page left open by a crash without emitting
  `pageFinalized` for it (and still emits for a live one in the same batch).
- `resumeNote()`'s finalize loop does the same for a note whose last page was
  typed and left open.

`src/notes/TypedPageEditor.test.tsx` (new): loads `initialText`, debounces a
write through `setPageText`, flushes on unmount, surfaces (doesn't swallow) a
failed write.

`src/notes/NotesView.test.tsx` (append): "Type page" creates and shows a
typed page; typing into it round-trips through `setPageText`; a typed page
renders without `TranscriptPanel`'s "not yet transcribed" messaging; a note
with both a live and a typed page navigates between them correctly.

Every new test is mutation-checked (break the implementation, confirm red,
revert) before being considered done.

## 8. Known limitations

### 8.1 A failed debounced write *and* a failed flush-on-unmount lose the edit, silently

`TypedPageEditor` surfaces a failed debounced write as a visible error while
it's mounted (§5.1), and its unmount cleanup retries whatever's still dirty
so navigating away doesn't normally lose it. But if **both** fail — the
debounced write rejects, the owner navigates to another page before a retry
succeeds, and the unmount-triggered retry of that same pending text *also*
rejects — there is no third attempt. `showError` is a no-op once
`mountedRef.current` is `false` (setting React state on an unmounted
component is itself a bug to avoid), so nothing visible records the second
failure, and the next time that page is opened it seeds `initialText` from
whatever was last durably persisted - silently dropping the edit between the
two failures.

This mirrors a risk `useScratchpad` already carries (its own unmount flush
has the identical shape), so it isn't something this unit introduced. It is
recorded here because the brief's promise for this component was stronger
than the scratchpad's: "a failed write must not silently discard what was
typed." Under the specific double-failure condition above, it can. Not fixed
in this round — a retry mechanism or a navigation guard is a larger design
question (how many retries, with what backoff, blocking navigation on a
failed save or not) than a scoped fix belongs in. Pinned by a test
(`TypedPageEditor.test.tsx`, "known limitation: a failed debounced write
followed by a failed unmount flush loses the edit without a trace") so a
future change to this behavior - fixing it, or changing the component in a
way that happens to touch it - is a deliberate decision, not an accidental
regression nothing would catch.
