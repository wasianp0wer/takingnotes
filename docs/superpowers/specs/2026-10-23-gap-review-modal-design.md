# Gap review modal and note-wide Find gaps — design

Date: 2026-10-23. Branch: `sessions-ui`.

## Why

Two things about gap suggestions get in the way today:

1. **Two buttons that look the same.** "Find gaps" (this page) and "Find gaps in note" sit side by side in `GapPanel` (`src/notes/GapPanel.tsx`), and the difference between them is confusing. One button that always covers the whole note is enough.
2. **Review is scattered, and nothing becomes notes.** Suggestions are accepted or rejected one by one in each page's panel, every click is saved at once, and accepted text only appears in a "From the recording" list under that page. The user wants to review everything in one place, be free to change their mind, and end up with the accepted points as real notes: a typed page they can read and edit like any other.

## Goals

- One **Find gaps** button that always runs `analyzeNote` over every page of the note.
- When proposed suggestions exist, a **Review suggestions** button opens a modal listing every proposed suggestion in the note.
- In the modal each suggestion can be set to Accept or Reject and changed freely. Nothing is written to storage until **Submit**.
- Submit:
  - saves the accepted/rejected decisions;
  - leaves undecided suggestions `proposed`, so they appear again next time;
  - closes the modal;
  - when at least one suggestion was accepted, appends **one new typed page** at the end of the note holding the accepted suggestions.
- Each accepted suggestion on that page shows its text, its supporting recording quote, and **the time range in the recording the quote came from**.

## Non-goals

- No per-page gap run. `analyzePage` stays in the analyzer (tests and internals use it), but the UI no longer calls it.
- No editing of suggestion text inside the modal. The user edits the typed page afterwards.
- No audio playback or seek links from the timestamps. They are text.
- Draft choices are not persisted across app restarts.

## Anti-goals

These would make the change a failure even if it technically worked:

- **Wrong timestamps.** A time range that points somewhere other than where the quote was said is worse than a coarser but honest range. When a precise range cannot be found, fall back to the page's speech window. Never make up a range.
- **Asking the model for timestamps.** Small local models (Gemma via Ollama) get numbers wrong. Timing must come from data the app already holds: transcript segments and the time span of each chunk.
- **Losing work.** Closing the modal (Esc, X or clicking outside) must not throw away in-progress choices, and Submit must not silently drop undecided suggestions.
- **A feedback loop.** The generated typed page must not be gap-analyzed itself. It has no strokes, so `speechWindowForPage` returns `null` and eligibility already skips it. Keep it that way, and cover it with a test.

## Decided with the user

### Find gaps
- Only one button, labelled "Find gaps". It runs `analyzer.analyzeNote(noteId)`.
- It is enabled when the note has any finished recording (`noteHasRecording`, today's "Find gaps in note" gate) and no run is in flight.
- "Find gaps in note" is removed.
- The per-page skip sentence (`describeGapSkip`) and the per-page status line may stay. They still describe this page's own state.

### Review suggestions
- The button appears (or is enabled) when the note has at least one `proposed` suggestion. Use `listGapsByNote`.
- The modal lists every proposed suggestion in the note.
- Each row has:
  - the suggestion text and kind badge, the `Summarized` marker when it applies, and the quote (reuse `SuggestionQuote`);
  - its time range;
  - Accept and Reject toggles. Pressing the active one again returns the row to undecided.
- **Undecided on Submit:** stays `proposed` and shows next time.
- **Close without Submit:** choices are remembered for that note while the app runs, and reopening the modal restores them. They are kept in memory, for example in a module-level map keyed by note id or state lifted above the remounting per-page panel. They are not persisted.
- **Submit:**
  1. `updateGap` each decided suggestion to `accepted` or `rejected`.
  2. If any were accepted, `createTypedPage` at `pageIndex` = (max existing `pageIndex` + 1) with the Markdown below.
  3. Clear that note's draft.
  4. Close the modal.
  5. Refresh the panel, and the page list so the new page shows up.
- Rejected suggestions stay stored as `rejected`, so `dropReviewed` stops them resurfacing. Accepted ones stay stored as `accepted` for the same reason.
- **Live note (user's decision):** if the note is the one being captured right now, the modal still opens and choices can be made, but Submit is disabled. A short line says the page will be added once the note ends. The capture engine keeps its own in-memory `pageIndex` (`src/capture/engine.ts`), and a page inserted behind its back would collide with its next page. Read the active note from the existing capture context.
- **Suggestions accepted before this change (user's decision):** no backfill. They stay stored as `accepted`, which still keeps them from being suggested again, and are simply no longer shown.
- **Re-running Find gaps with unsubmitted choices (my call):** a run deletes and recreates `proposed` rows with new ids. Key draft choices by suggestion id. After a run, carry each choice over to the new row on the same page whose `normalizeGapText(text)` matches, and drop choices that match nothing. Find gaps is disabled while the modal is open, and Submit is disabled while a run is in flight, so a Submit never writes to rows being replaced.

### Panel lists
- Remove the per-page "From the recording" (accepted) and "Rejected" lists, and the inline Accept/Reject list of proposed suggestions, from `GapPanel`. Review happens only in the modal.
- The panel keeps: the heading, the source-window line, the Find gaps and Review suggestions buttons, and the status/skip/error/summarized lines.

### Typed page content (Markdown)

```
## From the recording

- **<suggestion text>**
  > <source quote>
  — <recording title>, 12:30–12:48
```

- One bullet per accepted suggestion, in the order the quotes occur in the recording: by recording `startedAt`, then quote start.
- Times are offsets from the recording's start, formatted `m:ss`, or `h:mm:ss` from an hour on.
- The recording title comes from `RecordingRecord.title`, because a note can be linked to more than one recording.
- The page opens like any other typed page: `TypedPageEditor`, editable, autosaved.

## Timestamps: how the quote's time range is found

Add two optional fields to `GapSuggestionRecord` (and `CreateGapInput`):

```ts
/** Offsets from the recording's start, in ms, of the speech the quote came from. Absent → fall back to fromMs/toMs. */
quoteStartMs?: number;
quoteEndMs?: number;
```

They are optional, so existing rows need no IndexedDB migration. For a row without them, the typed page uses the page window (`fromMs`/`toMs` minus `recording.startedAt`).

**Direct path** (`summarized === false`). The quote is meant to be verbatim speech. Normalize both sides (lowercase, collapse whitespace, strip punctuation) and find the run of consecutive segments in the page window whose joined text contains the quote. Its range is the first segment's `startMs` to the last segment's `endMs`. If there is no exact match, fall back to the page window. Fuzzy matching is not required in this change.

**Summarized path.** `chunkSpeech` currently works on a flat string and loses timing. Change the summarized path so that each chunk knows its time span:
- Chunk at segment boundaries (or map character offsets back to segments) so each chunk carries `{ text, startMs, endMs }`.
- Every bullet a chunk's summary produces inherits that chunk's span. Keep a list of `{ bullet, startMs, endMs }`.
- After compare, match each `sourceQuote` against the bullets using the same normalization. A match gives that bullet's span. If several chunks overlap, take the first matching bullet.
- If the quote matches no bullet, try the direct segment match against the raw speech. If that fails too, fall back to the page window.
- When every chunk summarized to nothing and the raw speech was compared instead (an existing fallback in `runPage`), use the direct path's matching.

Prompts do not change: the model is never asked for times. `promptVersion` therefore does not change either.

## Constraints

- TypeScript and React, styled like the existing code. Use the existing `Dialog` from `src/components/ui/dialog.tsx` (as `SettingsDialog` does) and `Button`.
- Tests use the same style as `GapPanel.test.tsx`, `analyzer.test.ts` and `chunk.test.ts`. Use `fakeTextGenerator` for analyzer tests.
- Keep A24: accepted text is never merged into a handwriting page's `TranscriptRecord.markdown`. The new typed page is a separate page, and its `transcript` is its own mirrored text, which is fine.
- Keep the existing re-entrancy and unmount guards in `GapPanel.run`.

## Left to the builder

- Where the draft map lives and how the panel learns the page list changed (callback prop vs. existing refresh mechanism in the notes view).
- Exact modal layout: grouping rows by source page or a flat list, how the time range sits beside the quote, scroll behaviour for a long list.
- Whether chunking moves to segment boundaries or keeps the character chunker plus an offset→segment map.
- Normalization details for quote matching, as long as it is shared between both paths and tested.
- Updating `docs/session-handoff.md` and any spec text that names "Find gaps in note".
