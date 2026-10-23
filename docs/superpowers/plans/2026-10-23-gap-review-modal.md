# Gap Review Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One note-wide "Find gaps" button, a "Review suggestions" modal with draft accept/reject choices, and Submit appending a typed page of accepted suggestions with the recording time range each quote came from.

**Architecture:** Quote timing is computed in the analyzer from data the app already holds (transcript segments, and the time span of each summarization chunk), and stored as two optional fields on `GapSuggestionRecord`. Pure modules build the typed-page Markdown and hold the in-memory review draft. `GapPanel` loses its per-page lists and gains the modal (`GapReviewDialog`).

**Tech Stack:** TypeScript, React 19, Radix Dialog (`src/components/ui/dialog.tsx`), IndexedDB via `idb`, Vitest + jsdom (`fake-indexeddb`, `resetDatabase`).

**Spec:** `docs/superpowers/specs/2026-10-23-gap-review-modal-design.md`

## Global Constraints

- Never ask the model for timestamps. Prompts and `promptVersion` strings do not change.
- New `GapSuggestionRecord` fields are optional: `quoteStartMs?: number; quoteEndMs?: number;`. They are offsets from the recording's start, in ms. There is no DB migration.
- When no quote timing can be found, fall back to the page window: `fromMs - recording.startedAt` to `toMs - recording.startedAt`.
- Typed page Markdown, exactly:
  ```
  ## From the recording

  - **<text>**
    > <sourceQuote>
    — <recording title>, <start>–<end>
  ```
  - Bullets are separated by a blank line.
  - Times use `m:ss`, or `h:mm:ss` from one hour on.
  - The dash before the title is an em dash (`—`). The dash between the two times is an en dash (`–`).
- Ordering on the page: by recording `startedAt`, then quote start. When there is no quote time, use the fallback start.
- Undecided suggestions stay `proposed` on Submit. Submitting with zero accepted creates no page.
- Submit is disabled while the note is the capture engine's active note, and while a gap run is in flight.
- Draft choices live in memory only (module-level map), keyed by note id.
- Accepted text is never written into a handwriting page's `TranscriptRecord.markdown` (A24).
- **Do not edit or stage files outside your task.** The working tree has unrelated uncommitted changes (`docs/session-handoff.md`, `package*.json`, `src/transcription/*`, `src/notes/TranscriptMarkdown*`). Stage only your own files with explicit paths. Never `git add -A`/`.`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test command: `npx vitest run <path>`. Lint: `npm run lint`.

## Review Focus

1. **Quote text that differs from the segments only in case, punctuation or whitespace,** or that spans a segment boundary, must still get a precise range. Covered in Task 1's tests.
2. **A summarized run where the quote matches no bullet** must fall back to a raw-speech match, then to the page window, and never invent a range. Covered in Task 2's tests.
3. **Rows created before this change** have no `quoteStartMs`. They still render with the page-window fallback. Covered in Task 3's tests.
4. **A gap run finishing while draft choices exist** carries choices to recreated rows with the same normalized text on the same page. Covered in Task 4's tests.
5. **Pressing Submit twice quickly** must create only one page. Covered in Task 5's tests (the button is disabled in flight and a ref guard is checked).

---

### Task 1: Quote timing helpers and timed chunking

**Files:**
- Create: `src/gaps/quoteTime.ts`
- Create: `src/gaps/quoteTime.test.ts`
- Modify: `src/gaps/chunk.ts` (add `chunkSegments`)
- Modify: `src/gaps/chunk.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // quoteTime.ts
  export interface TimeRange { startMs: number; endMs: number }   // recording offsets
  export interface TimedText extends TimeRange { text: string }
  export function normalizeForMatch(text: string): string;
  export function findQuoteInSegments(segments: TranscriptSegment[], quote: string): TimeRange | null;
  export function findQuoteInBullets(bullets: TimedText[], quote: string): TimeRange | null;
  // chunk.ts
  export function chunkSegments(segments: TranscriptSegment[], opts?: ChunkOptions): TimedText[];
  ```

- [ ] **Step 1: Write failing tests** in `quoteTime.test.ts`:
  - `normalizeForMatch`: `normalizeForMatch('  The Krebs  cycle, ATP!')` → `'the krebs cycle atp'`. It lowercases, replaces every non-letter/non-number run with one space, and trims.
  - `findQuoteInSegments`:
    - Given segments `[{0,1000,'Hello there.'},{1000,2500,'The Krebs cycle'},{2500,4000,'makes ATP. Next topic.'}]` and quote `'krebs cycle makes ATP'`, it returns `{startMs:1000,endMs:4000}`.
    - Quote `'Hello there'` → `{0,1000}`.
    - Quote `'not said'` → `null`.
    - An empty quote → `null`.
    - Segments with empty text are ignored.
  - `findQuoteInBullets`:
    - Given bullets `[{text:'- Mitochondria make ATP', startMs:0, endMs:60000},{text:'- Krebs cycle runs in matrix', startMs:50000, endMs:120000}]` and quote `'Krebs cycle runs in matrix'`, it returns `{50000,120000}`.
    - A quote matching both bullets returns the first.
    - No match → `null`.
    - A leading `- ` on the quote or the bullet is ignored. This falls out of normalization.

- [ ] **Step 2: Write failing tests** in `chunk.test.ts` for `chunkSegments`:
  - Segments totalling under the budget → one chunk spanning the first `startMs` to the last `endMs`, with its text equal to `speechTextOf(segments)`.
  - Ten segments of 100 chars each with `{budget: 350, overlap: 120}`:
    - Every chunk's text is at most 350 chars.
    - Consecutive chunks share at least one segment.
    - Each chunk's `startMs`/`endMs` equal its first and last segment's times.
    - The union covers every segment.
  - A single 1000-char segment with `{budget: 300}` → several pieces, each with that segment's `startMs`/`endMs`, and none over 300 chars.
  - Empty and whitespace-only segments are skipped. An empty input gives `[]`.

- [ ] **Step 3: Run** `npx vitest run src/gaps/quoteTime.test.ts src/gaps/chunk.test.ts`. Expected: the new tests fail.

- [ ] **Step 4: Implement.**
  - `findQuoteInSegments`:
    1. Build the normalized text of the non-empty segments joined by a single space, recording each segment's start/end character offsets.
    2. Find the normalized quote with `indexOf`.
    3. Map the match's start and end offsets back to the segments that contain them.
  - `findQuoteInBullets`: return the first bullet whose normalized text contains the normalized quote.
  - `chunkSegments`:
    1. Greedily pack whole segments (joined with `' '`) up to `budget`.
    2. Start the next chunk at the earliest trailing segment such that the carried-over text is at most `overlap` chars. Always advance at least one segment.
    3. A segment longer than `budget` on its own is split with the existing `chunkSpeech(text, {budget, overlap})`, and each piece takes that segment's span.
    4. Defaults: `GAP_CHUNK_CHARS` / `GAP_CHUNK_OVERLAP`.

- [ ] **Step 5: Run** the same command. Expected: PASS.

- [ ] **Step 6: Commit.** Run `git add src/gaps/quoteTime.ts src/gaps/quoteTime.test.ts src/gaps/chunk.ts src/gaps/chunk.test.ts`, then commit with the message `feat(gaps): locate a quote's time range in the recording`.

### Task 2: Store quote timing from the analyzer

**Files:**
- Modify: `src/storage/types.ts` (`GapSuggestionRecord`)
- Modify: `src/storage/gaps.ts` (`CreateGapInput`, `buildGap`)
- Modify: `src/gaps/analyzer.ts` (`summarizeChunks`, `runPage`)
- Test: `src/gaps/analyzer.test.ts`

**Interfaces:**
- Consumes: `findQuoteInSegments`, `findQuoteInBullets`, `chunkSegments`, `TimedText` (Task 1).
- Produces: `GapSuggestionRecord.quoteStartMs?: number`, `quoteEndMs?: number`. These are recording offsets, set only when a quote was located. `buildGap` copies them only when defined, so old-shaped inputs produce records without the keys.

- [ ] **Step 1: Write failing tests** in `analyzer.test.ts`, using the file's existing seeding helpers and `createFakeTextGenerator`:
  - **Direct path:** the recording segments include `{startMs: 5000, endMs: 9000, text: 'Entropy always increases in a closed system.'}`, and the compare reply quotes `'entropy always increases'`. The created gap has `quoteStartMs === 5000` and `quoteEndMs === 9000`.
  - **Direct path, no match:** the reply quotes text absent from the speech. The gap has `quoteStartMs === undefined`.
  - **Summarized path** (set `directCharBudget` small and `chunkChars` so there are two chunks with known spans):
    - The summarize replies are `'- Point A from chunk one'` and `'- Point B from chunk two'`.
    - The compare reply quotes `'Point B from chunk two'`.
    - The gap's `quoteStartMs`/`quoteEndMs` equal the second chunk's first segment `startMs` and last segment `endMs`.
  - **Summarized, quote matches no bullet but matches raw speech:** the range is the raw segment match.
  - **Summarized, every chunk summarizes to `''`:** the raw speech is compared, and the quote matched against the segments gives the range.
  - **Prompts unchanged:** the existing promptVersion and prompt-text assertions still pass with no edits.

- [ ] **Step 2: Run** `npx vitest run src/gaps/analyzer.test.ts`. Expected: the new tests fail.

- [ ] **Step 3: Implement.**
  - Add the two optional fields to `GapSuggestionRecord` with this doc comment: "Offsets from the recording's start, in ms, of the speech the quote came from. Absent → fall back to fromMs/toMs."
  - Add the same two fields to `CreateGapInput`.
  - In `runPage`:
    1. Keep `const segments = segmentsInWindow(...)`.
    2. On the summarized path, call `chunkSegments(segments, {budget: chunkChars, overlap: chunkOverlap})`.
    3. `summarizeChunks` now takes `TimedText[]` and returns `TimedText[]`. It returns one entry per non-empty bullet line of each summary, each with its chunk's span.
    4. The compared text is still the bullets joined with `'\n'`. The existing all-empty fallback compares the raw speech as before.
    5. Per point, the range is `(summarized && bullets.length > 0 ? findQuoteInBullets(bullets, quote) : null) ?? findQuoteInSegments(segments, quote)`.
  - `speechTextOf(segments)` must stay the direct-path text, so prompts are unchanged.

- [ ] **Step 4: Run** `npx vitest run src/gaps src/storage`. Expected: PASS.

- [ ] **Step 5: Commit** these files with the message `feat(gaps): record where in the recording each quote came from`.

### Task 3: Typed-page Markdown and Submit

**Files:**
- Create: `src/gaps/gapPage.ts`
- Create: `src/gaps/gapPage.test.ts`
- Create: `src/notes/pageChanges.ts` (a tiny emitter)

**Interfaces:**
- Consumes: `GapSuggestionRecord` with optional quote fields (Task 2). Also `createTypedPage`, `listPages` (`src/storage/pages.ts`), `updateGap` (`src/storage/gaps.ts`), and `getRecording` (`src/storage/recordings.ts`).
- Produces:
  ```ts
  // gapPage.ts
  export type GapDecision = 'accepted' | 'rejected';
  export function formatOffset(ms: number): string;
  export function quoteRange(gap: GapSuggestionRecord, recording: RecordingRecord): { startMs: number; endMs: number };
  export function buildGapPageMarkdown(items: Array<{ gap: GapSuggestionRecord; recording: RecordingRecord }>): string;
  export function submitGapReview(noteId: string, decisions: Map<string, GapDecision>): Promise<PageRecord | null>;
  // pageChanges.ts
  export function notifyPagesChanged(noteId: string): void;
  export function subscribePagesChanged(listener: (noteId: string) => void): () => void;
  ```

- [ ] **Step 1: Write failing tests** in `gapPage.test.ts`:
  - `formatOffset`: `0` → `'0:00'`, `65_000` → `'1:05'`, `3_600_000` → `'1:00:00'`, and `3_725_000` → `'1:02:05'`. Negative input clamps to `'0:00'`.
  - `quoteRange`: it uses `quoteStartMs`/`quoteEndMs` when present. Otherwise it returns `fromMs - recording.startedAt` to `toMs - recording.startedAt`, each clamped to ≥ 0.
  - `buildGapPageMarkdown`: given two gaps whose input order is reversed relative to their quote start, and a recording titled `'Lecture 4'`, the output is exactly:
    ```
    ## From the recording

    - **First point.**
      > first quote
      — Lecture 4, 0:05–0:09

    - **Second point.**
      > second quote
      — Lecture 4, 12:30–12:48
    ```
  - Items from two recordings are ordered by recording `startedAt` first.
  - `submitGapReview` (with the IndexedDB `resetDatabase` fixture):
    - The seed is a note with one ink page (`pageIndex` 0) and three proposed gaps. The decisions are `{g1: accepted, g2: rejected}`.
    - g1 is `accepted`, g2 is `rejected`, and g3 stays `proposed`.
    - A new typed page exists at `pageIndex` 1, and its `text` contains g1's text and not g2's.
    - The return value is that page.
    - `notifyPagesChanged` listeners receive the note id.
  - With only rejections, statuses are updated, no page is created, and the result is `null`.

- [ ] **Step 2: Run** `npx vitest run src/gaps/gapPage.test.ts`. Expected: fail.

- [ ] **Step 3: Implement** both modules.
  - `submitGapReview`:
    1. `updateGap` each decision, serially.
    2. Load the accepted gaps with their recordings. A missing recording falls back to the title `'Recording'` with `startedAt = gap.fromMs`.
    3. If there are any accepted gaps, `createTypedPage({noteId, pageIndex: max(pageIndex)+1, text})`, then call `notifyPagesChanged(noteId)`.
  - `pageChanges.ts`: a `Set` of listeners, like `resumeLock`'s subscribe pattern.

- [ ] **Step 4: Run** the tests. Expected: PASS.

- [ ] **Step 5: Wire the page list refresh.** In `src/sessions/useNotePages.ts`, subscribe to `subscribePagesChanged` and bump `revision` when the id equals `noteId`. Add a test in `src/sessions/useNotePages.test.ts` (create it if absent) that rendering the hook, then creating a page plus `notifyPagesChanged(noteId)`, shows the new page. If a hook test needs a `CaptureProvider`, follow whatever existing hook tests in `src/sessions` do.

- [ ] **Step 6: Commit** with the message `feat(gaps): build the accepted-suggestions page on submit`.

### Task 4: In-memory review draft

**Files:**
- Create: `src/gaps/reviewDraft.ts`
- Create: `src/gaps/reviewDraft.test.ts`

**Interfaces:**
- Consumes: `GapDecision` (Task 3), `normalizeGapText` (`src/gaps/validate.ts`).
- Produces:
  ```ts
  export function getDraft(noteId: string): Map<string, GapDecision>;          // a copy; empty when none
  export function setDraftChoice(noteId: string, gap: GapSuggestionRecord, decision: GapDecision | null): void; // null clears
  export function clearDraft(noteId: string): void;
  export function reconcileDraft(noteId: string, proposed: GapSuggestionRecord[]): void;
  export function resetAllDrafts(): void; // tests only
  ```
  - Internally, the module stores `Map<noteId, Map<gapId, { decision, pageId, key }>>`, where `key` is `normalizeGapText(gap.text)`.

- [ ] **Step 1: Write failing tests:**
  - Set → get round-trips. Setting `null` removes the entry. `clearDraft` empties it. Notes are independent.
  - `getDraft` returns a copy: mutating the result does not change the store.
  - `reconcileDraft`:
    - An entry whose id is still among `proposed` is kept.
    - An entry whose id is gone moves to a proposed row with the same `pageId` and the same normalized text (`'The Krebs cycle.'` vs `'the krebs cycle'`) that has no entry of its own.
    - An entry with no such row is dropped.
    - A same-text row on a *different* page is not matched.

- [ ] **Step 2: Run** them to see them fail. **Step 3: Implement. Step 4: Run** them to see them pass.

- [ ] **Step 5: Commit** with the message `feat(gaps): keep review choices in memory until submit`.

### Task 5: GapReviewDialog and the reworked GapPanel

**Files:**
- Create: `src/notes/GapReviewDialog.tsx`
- Create: `src/notes/GapReviewDialog.test.tsx`
- Modify: `src/notes/GapPanel.tsx`
- Modify: `src/notes/GapPanel.test.tsx`
- Modify: `src/sessions/NotesHalf.tsx` (pass `noteIsLive`)
- Modify: `src/gaps/analyzer.ts` (only the `noteHasRecording` doc comment that names "Find gaps in note")

**Interfaces:**
- Consumes: Tasks 3 and 4, plus `listGapsByNote` and `getRecording`.
- Produces:
  ```ts
  export interface GapReviewDialogProps {
    noteId: string;
    open: boolean;
    onOpenChange(open: boolean): void;
    /** Submit is disabled with an explanation while the note is being captured. */
    noteIsLive: boolean;
    /** Submit is disabled while a gap run is in flight. */
    running: boolean;
    /** Called after a successful submit, so the panel reloads. */
    onSubmitted(): void;
  }
  export function GapReviewDialog(props: GapReviewDialogProps): JSX.Element;
  // GapPanelProps gains:
  noteIsLive?: boolean; // default false
  ```

- [ ] **Step 1: Write failing `GapReviewDialog` tests.** Render with seeded IndexedDB, as `GapPanel.test.tsx` does. Radix portals into `document.body`, so query `document.body`.
  - Open with three proposed gaps → three rows. Each shows its text, quote, kind badge and `— <title>, m:ss–m:ss`.
  - Accept and Reject are toggles with `aria-pressed`. Clicking Accept on a row sets `aria-pressed="true"`, and clicking it again clears it. Accept then Reject leaves only Reject pressed.
  - Nothing is written before Submit: after clicking Accept, `getGap(id).status` is still `'proposed'`.
  - Close and reopen (`open` false, then true) → previous choices are still pressed (via `reviewDraft`).
  - Submit with one accepted and one rejected:
    - `onSubmitted` is called and `onOpenChange(false)` is called.
    - The statuses are written, and a typed page exists.
    - The draft for the note is empty.
  - `noteIsLive` → the Submit button is disabled, and the text `The page will be added once this note ends.` is shown.
  - `running` → Submit is disabled.
  - Double-click Submit → exactly one new typed page.
  - Submit failure (spy `updateGap` to reject) → the error message is shown, the dialog stays open, and the draft is kept.

- [ ] **Step 2: Rewrite `GapPanel.test.tsx` for the new panel.**
  - Delete the tests for the inline Accept/Reject list, "From the recording" and "Rejected" lists, and "Find gaps in note".
  - Keep the status, skip, summarized and error-line tests, adjusted for the new button.
  - New tests:
    - Exactly one button named `Find gaps`, and no `Find gaps in note`.
    - Clicking it calls `analyzer.analyzeNote(noteId)`, never `analyzePage`.
    - It is enabled when the note has a finished recording even if this page has none, and disabled without any recording.
    - `Review suggestions` is absent or disabled when the note has no proposed gaps, and enabled when any page of the note has one.
    - After a run, `reconcileDraft` has been applied: seed a draft choice, have the fake analyzer delete and recreate that row with the same text, then reopen the dialog and see the choice pressed on the new row.
    - The re-entrancy and unmount guard tests are kept.

- [ ] **Step 3: Run** `npx vitest run src/notes/GapPanel.test.tsx src/notes/GapReviewDialog.test.tsx`. Expected: fail.

- [ ] **Step 4: Implement.**
  - **`GapReviewDialog`:**
    - Use `Dialog`, `DialogContent` with `className="sm:max-w-2xl"` and a scrollable list (`max-h-[60vh] overflow-auto`), `DialogHeader`, `DialogTitle` "Review suggestions", and `DialogFooter` with a Submit button.
    - Reuse `SuggestionQuote`: export it from `GapPanel.tsx`, or move it, together with `GAP_KIND_LABELS`, to a small `src/notes/SuggestionQuote.tsx`.
    - Load proposed gaps on open via `listGapsByNote(noteId)` filtered to `proposed`, and their recordings via `getRecording`.
    - Show times with `quoteRange` and `formatOffset`.
    - Initial choices come from `getDraft(noteId)`, and each toggle calls `setDraftChoice`.
    - Submit calls `submitGapReview(noteId, choices)`, then `clearDraft(noteId)`, `onSubmitted()` and `onOpenChange(false)`.
    - Guard Submit with a ref, as `GapPanel.run` does.
  - **`GapPanel`:**
    - Remove `'page'` runs, the second button, and all three lists.
    - `run()` always calls `analyzeNote`, then `reconcileDraft(noteId, proposedForNote)`, and bumps `revision`.
    - `findGapsDisabled = running || !noteRecorded || dialogOpen`.
    - Load `listGapsByNote(noteId)` to count proposed gaps for the Review button. The button reads `Review suggestions (N)` and is disabled when N is 0.
    - Update the component doc comment and the `noteRecorded` comment to drop "Find gaps in note". Keep the status line's "No gaps found…" condition based on this page's proposed count, using `listGapsByPage` as now.
  - **`NotesHalf`:** pass `noteIsLive={state.activeNoteId === viewedPage.noteId}`.

- [ ] **Step 5: Run** `npx vitest run src/notes src/sessions src/gaps`, then `npm run lint`. Expected: PASS and no lint errors.

- [ ] **Step 6: Commit** the task's files with the message `feat(notes): review gap suggestions in a modal and submit them as a typed page`.

### Task 6: Full verification

- [ ] Run `npx vitest run`. Expected: all files pass.
- [ ] Run `npm run lint` and `npx tsc -b --noEmit` (or the project's typecheck via `npm run build`). Expected: clean.
- [ ] Run `grep -rn "Find gaps in note" src docs/superpowers/specs/2026-10-23*`. Expected: no product-code hits.
