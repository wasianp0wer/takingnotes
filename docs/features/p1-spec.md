# P1 — Fill gaps in notes from the recording: feature spec

Source requirements: `docs/spec-phase2.md` (P1, decisions J1, J2, J5, J6),
`docs/architecture.md` (§6.1 records, §6.2 schema, §6.3 repositories, §6.4 the
shared text generator, §6.5 the P1 module contract, §6.6 settings, §6.7
ownership), `docs/assumptions.md` (A21–A24, A30).

## Goal

For one page of a note, find the substantive points the lecture said and the
page does not contain, and offer each one for review. A gap is **missing
content** (J1): time only narrows *which* speech is compared against *which*
page. Accepted points are recording-derived content attached to the page,
clearly labelled, never merged into `TranscriptRecord.markdown` (J2, A24).

## What the foundations already guarantee (read from the code)

- `src/storage/gaps.ts`: `createGap`, `createGaps` (one transaction, `[]` for an
  empty batch), `getGap`, `updateGap` (bumps `updatedAt`), `listGapsByNote`,
  `listGapsByPage` (both oldest first, `id` breaking a `createdAt` tie),
  `deleteGapsByPage(pageId, status?)` (returns how many went).
- `src/storage/pages.ts`: `setPageGapAnalysis(id, meta | null)`, `getPage`,
  `listPages` (by `pageIndex`), `isPageFinalized`.
- `src/storage/types.ts`: `GapSuggestionRecord`, `GapKind`, `GapStatus`,
  `GapAnalysisMeta`, `GapAnalysisStatus`, `TranscriptSegment` (`startMs`/`endMs`
  are offsets from `RecordingRecord.startedAt`).
- `src/llm/ollamaText.ts`: `createOllamaTextGenerator({ baseUrl, fetchImpl?,
  timeoutMs? })` → `TextGenerator` with `generate` and `generateJson<T>` whose
  `validate` is mandatory. `think: false`, `num_predict`
  (`DEFAULT_TEXT_NUM_PREDICT` 2000), the 180 s timeout and degenerate-output
  rejection are all already applied; `generateJson` salvages an outermost
  `[…]`/`{…}` slice for free and spends **one** repair call before throwing a
  readable error. A `validate` failure is not repaired.
- `src/storage/settingKeys.ts`: `gaps.leadMs` (60 000), `gaps.trailMs` (30 000),
  and `ollama.baseUrl` / `ollama.model` shared with transcription (A30).
- `src/notes/NotesView.tsx` mounts `<GapPanel key={…} noteId pageId />` beside
  `TranscriptPanel`, keyed per page. `NotesView.test.tsx` asserts
  `[aria-label="Gaps"]`.
- Recordings have **no** `by-note` index: `listRecordings()` (newest first) and
  `listRecordingsBySession(sessionId)` (oldest first) are what exist.

## Design

### `src/gaps/constants.ts`

```ts
export const GAP_LEAD_MS = 60_000;
export const GAP_TRAIL_MS = 30_000;
export const GAP_DIRECT_CHAR_BUDGET = 6000;
export const GAP_CHUNK_CHARS = 3000;
export const GAP_CHUNK_OVERLAP = 300;
```

Its own file so the pure helpers, the analyzer and the panel share one source
without importing each other.

### `src/gaps/window.ts` — which speech belongs to a page (pure)

```ts
export function speechWindowForPage(
  page: PageRecord,
  opts?: { leadMs?: number; trailMs?: number },
): { fromMs: number; toMs: number } | null;

export function segmentsInWindow(
  recording: RecordingRecord,
  fromMs: number,
  toMs: number,
): TranscriptSegment[];

export function speechTextOf(segments: TranscriptSegment[]): string;
```

- The page's own span is `[first stroke time, last stroke time]`, read as: a
  stroke's `startedAt` / `endedAt` when present, else the first / last point's
  `t`. Points and strokes without timestamps (ROM and legacy pages) contribute
  nothing.
- Only **finite** numbers count as timestamps, on the stroke's `startedAt` /
  `endedAt` exactly as on a point's `t`. A `NaN` reaching the window would make
  it `{ NaN, NaN }`, which eligibility reads as `ok` and every segment
  comparison misses — the page would be told the recording said nothing in its
  window when the truth is that it carries no time to align against.
- Each end falls back to the **other** after that check: a stroke carrying
  exactly one of `startedAt` / `endedAt` and no point `t` still says when it was
  written, and a zero-length span at that instant is the honest reading of it.
- `toMs` uses `page.finalizedAt` when it is a number (the page was closed:
  writing may have stopped well before the turn, and the speech in between is
  exactly what a gap analysis wants), else the last stroke time. An **absent**
  `finalizedAt` (a v1 row) is not a timestamp, so it falls back the same way. It
  is taken as `max(finalizedAt, last stroke time)`, never the bare
  `finalizedAt`: a `finalizedAt` that predates the last stroke (a clock
  adjustment, a repaired row) would otherwise truncate or invert the window.
- Then widen: `fromMs = start - leadMs`, `toMs = end + trailMs`. Speech precedes
  writing, so the lead is the larger margin (60 s vs 30 s).
- `null` when the page has no strokes at all, or no stroke carries a usable
  timestamp — there is nothing to align against (A22 makes that a skip, not a
  failure).
- `segmentsInWindow` returns `[]` when the recording has no transcript. A
  segment is included when it **overlaps** the window inclusively:
  `absEnd >= fromMs && absStart <= toMs`, where `absStart = recording.startedAt +
  segment.startMs`. Touching at a boundary counts: the margins are already a
  guess, so the tie goes to including the speech. Output is sorted by `startMs`
  (a transcript is expected to be ordered; sorting makes it so).
- `speechTextOf` joins the segments' trimmed, non-empty text with a single
  space. One flat string is what both the direct comparison and the chunker
  take.

### `src/gaps/chunk.ts` — `chunkSpeech` (pure)

```ts
export function chunkSpeech(text: string, opts?: { budget?: number; overlap?: number }): string[];
```

- `[]` for empty or whitespace-only text; a single chunk when the text fits the
  budget.
- Otherwise walk the text: each chunk is at most `budget` characters, cut at the
  last whitespace inside the budget so a chunk never ends mid-word (a chunk with
  no whitespace at all is cut at the budget). The next chunk starts `overlap`
  characters before the cut, again moved back to a whitespace boundary, so a
  sentence straddling a cut is summarized whole at least once.
- Guards: `overlap` is clamped below `budget` (`min(overlap, budget - 1)`) and
  the start index must always advance, so no input can loop forever. A
  non-positive budget falls back to the default.
- Every chunk is trimmed and non-empty, and the concatenation of the chunks
  covers the whole text (overlap aside).

### `src/gaps/prompts.ts` — the prompt registry (D8a, versioned)

Two prompts, in a registry keyed by model family, never inline strings:

```ts
export type GapPromptKind = 'summarize' | 'compare';
export interface GapPromptSpec {
  kind: GapPromptKind;
  family: string;
  promptVersion: string;   // `gap-<kind>-<family>-v1`
  system: string;
  build(input: …): string; // renders the user prompt
}
export function gapModelFamily(model: string): string;   // 'gemma' | 'generic'
export function getGapPrompt(kind: GapPromptKind, model: string): GapPromptSpec;
/** The version stamped on a suggestion: the compare prompt, plus the summarize prompt when the speech was summarized. */
export function gapPromptVersion(model: string, summarized: boolean): string;
```

- `gapModelFamily` strips namespace and tag like `modelFamily` in
  `src/transcription/prompts.ts` (`library/gemma4:12b` → `gemma`). Own function
  rather than reusing transcription's: that one maps *vision* families
  (`qwen-vl`, `llava`), which say nothing about a text prompt.
- `summarize` takes one chunk and asks for key bullet points, substantive only
  (J6): claims, definitions, names and dates, argument steps, worked examples,
  anything flagged as important or examinable; no asides, no repetition.
- `compare` takes the page's handwriting transcript and the speech (verbatim or
  bullets) and asks for a JSON array of the substantive points **present in the
  speech and absent from the notes**, each
  `{ text, kind, sourceQuote }` with `kind` in
  `claim | definition | name-or-date | example | argument-step | other` and
  `sourceQuote` verbatim from the speech. It states: judge on substance, not
  wording — a point written in different words is present; return `[]` when
  nothing is missing; never invent a quote; JSON only.
- `gapPromptVersion(model, false)` → `gap-compare-gemma-v1`;
  `gapPromptVersion(model, true)` →
  `gap-summarize-gemma-v1+gap-compare-gemma-v1`. The summarize step changes what
  the comparison ever sees, so a summarized result is not the same prompt
  lineage as a direct one and must not claim to be.

### `src/gaps/validate.ts` — the untrusted JSON (pure)

```ts
export interface GapPoint { text: string; kind: GapKind; sourceQuote: string; }
export function validateGapPoints(value: unknown): GapPoint[];
export function normalizeGapText(text: string): string;
export function dropReviewed(points: GapPoint[], existing: GapSuggestionRecord[]): GapPoint[];
```

- `validateGapPoints` accepts an array (or `{ points: [...] }` / `{ gaps: [...] }`,
  which is the common way a model wraps one) and keeps only rows that are
  objects with a non-empty string `text`; `kind` is taken when it is one of the
  six, else `'other'`; `sourceQuote` is coerced to `''` when absent or not a
  string, because a missing quote weakens a suggestion but does not make it
  false. Everything else is **dropped, not cast** (§6.4) — a bad row is one lost
  suggestion, not a failed analysis. A non-array, non-wrapper value throws, so a
  model that answered in prose is a failure rather than silent emptiness.
  `text` and `sourceQuote` are trimmed and capped (2000 chars) so one runaway
  row cannot fill the page.
- Duplicates within one response are collapsed on `normalizeGapText`
  (lowercase, collapse whitespace, strip surrounding punctuation).
- `dropReviewed` removes points whose normalized text matches an `accepted` or
  `rejected` suggestion already on the page. This is what "rejected ones are
  kept so a re-run does not resurface them" (A23) actually requires: keeping the
  row only prevents resurfacing if the analyzer consults it.

### `src/gaps/eligibility.ts` — why a page can or cannot be analyzed (pure)

```ts
export type GapSkipReason =
  | 'no-strokes' | 'no-timestamps' | 'no-recording'
  | 'recording-transcript' | 'page-transcript';
export function gapEligibility(page, recording, window): { ok: true } | { ok: false; reason: GapSkipReason };
export function describeGapSkip(reason: GapSkipReason): string;
```

Shared by the analyzer (which skips, per A22) and the panel (which says so and
disables "Find gaps"), so the two can never disagree about whether a press would
do anything. Not in §6.5's list; an addition inside P1's own module (P1-A4).

### `src/gaps/analyzer.ts` — `createGapAnalyzer`

```ts
export interface GapAnalyzerDeps {
  generator: TextGenerator;
  model: string;
  leadMs?: number; trailMs?: number;
  directCharBudget?: number; chunkChars?: number; chunkOverlap?: number;
  /** Injected for tests. */
  now?: () => number;
}
export function createGapAnalyzer(deps: GapAnalyzerDeps): GapAnalyzer;
```

`analyzePage(pageId, { signal })`:

1. `getPage`; a missing page throws (a programming error, not a skip).
2. Resolve the note's recording: `recordingForNote(noteId)` — the **first**
   recording linked to the note (A21), where linked means
   `recording.noteId === noteId`, or `recording.sessionId === note.sessionId`
   when the note has a session; earliest `startedAt` wins, `id` breaking a tie.
3. `speechWindowForPage`, then `gapEligibility`. Not eligible → return `[]`,
   writing **nothing**: a skip is not an analysis, and stamping `done` on a page
   that was never compared would tell the UI it had been (A22, P1-A1).
4. `setPageGapAnalysis(pageId, { status: 'running', … })`.
5. `segmentsInWindow` → `speechTextOf`. No speech in the window is a real
   result, not a skip: the run happened and honestly found no overlap, so the
   analysis is recorded `done` (`error: null`, `summarized: false`) with zero
   suggestions and **no model call**. The page's `proposed` suggestions are
   **kept**: this run compared nothing, and deleting what an earlier run that
   did compare speech found would lose the user's work with no way back
   (P1-A12). An empty window is a wrongly linked recording, a device clock that
   disagrees or a legacy import — not "your notes are complete" — so the panel
   says the window matched no speech in its own words rather than "no gaps
   found".
6. If the speech fits `directCharBudget`, one `compare` call against
   `page.transcript.markdown`; `summarized = false`. Otherwise `chunkSpeech`,
   one `summarize` call per chunk **serially** (Ollama serves one model; a
   parallel fan-out would only queue and would make a timeout look like a
   stall), bullets concatenated, then one `compare` call against those bullets;
   `summarized = true`. A chunk whose summary comes back empty is skipped
   rather than failing the run.
7. `validateGapPoints` is the `generateJson` validate. Then `dropReviewed`
   against `listGapsByPage`.
8. `deleteGapsByPage(pageId, 'proposed')`, then `createGaps` with the surviving
   points (`status` defaults to `'proposed'`), each carrying `recordingId`,
   `fromMs`, `toMs`, `model`, `promptVersion` and `summarized`. Delete-then-write
   in that order and only after the model call has returned: a run that fails
   leaves the previous suggestions alone (P1-A2).
9. `setPageGapAnalysis(pageId, { status: 'done', error: null, summarized, … })`
   and return the created records.
10. Any throw: `setPageGapAnalysis(pageId, { status: 'failed', error: message,
    … })` and rethrow. The meta write is itself guarded — failing to record a
    failure must not replace the real error with a storage one.

`analyzeNote(noteId, { signal })`: `listPages`, mark every eligible page
`pending` up front (which is what `pending` means here — waiting its turn in a
note-wide run), then `analyzePage` each in `pageIndex` order, serially. A page
that throws is logged and the run continues to the next page; its own `failed`
meta is already on disk. An abort stops the loop and rethrows.

### `src/gaps/startGaps.ts` — the settings-wired analyzer

```ts
export function createConfiguredGapAnalyzer(): Promise<GapAnalyzer>;
```

Reads `ollama.baseUrl`, `ollama.model`, `gaps.leadMs`, `gaps.trailMs` (A30) and
builds `createOllamaTextGenerator({ baseUrl })`. Built per run, not cached:
gap analysis is an explicit user action, and picking up a settings change
between presses is the behaviour a user expects. Never called by a test.

### `src/notes/GapPanel.tsx`

Keeps its export name, `GapPanelProps { noteId, pageId }` and
`aria-label="Gaps"` (§6.7). One extra optional prop, `analyzer?: GapAnalyzer`,
tests-only, exactly as `NotesViewProps.queue` already does — so a test never
reaches the network.

Loads, on mount and after every action: the page (`getPage`, for
`gapAnalysis`), its suggestions (`listGapsByPage`) and the note's recording
(for eligibility). Renders, under the label:

- A heading `Gaps`, and a one-line source note naming the recording window —
  only when the page is genuinely **comparable** (the eligibility result is
  `ok`, which already implies a recording and a window). A page with a stroke
  window but no usable recording has nothing to compare, so the present-tense
  "Comparing against the recording from … to …" would state a falsehood and read
  as a contradiction beside the skip sentence below it.
- Buttons `Find gaps` (this page) and `Find gaps in note`. Disabled while a run
  is in flight; `Find gaps` also disabled when the page is not eligible.
- The ineligible case in plain words: "This page has no writing on it.", "This
  page has no timestamps to line up with the recording.", "This note has no
  linked recording.", "The recording is still being transcribed." or "This page
  has not been transcribed yet."
- Status from `page.gapAnalysis`: absent → "Not analyzed yet."; `pending` →
  "Waiting to analyze…"; `running` → "Looking for gaps…"; `failed` → the error,
  in destructive text, with the buttons still available; `done` → when it found
  nothing, "No gaps found in the recording for this page."
- `done` on a page whose window matched **no speech** gets its own sentence
  instead: "The recording has no speech in this page's time window." Only that
  one is true — "no gaps found" would claim the notes are complete when nothing
  was compared. The panel derives it the way the analyzer did, from the page and
  the recording it already holds (`segmentsInWindow` → `speechTextOf`); it is
  not stored, because `GapAnalysisMeta` has no field for it and
  `src/storage/types.ts` is not P1's to extend. It is checked before the "found
  nothing" line and shown however many suggestions are listed: the analyzer
  keeps the page's proposals on that path, so this line is the only thing that
  explains a run which changed nothing.
- When `summarized` is true: "The speech was too long to compare directly, so
  it was summarized first — some detail may be lost." This is the lossy-source
  statement J5 asks for, and it shows both on the analysis status and on each
  suggestion that carries the flag.
- Each `proposed` suggestion: its `text`, a `kind` label (`Claim`,
  `Definition`, `Name or date`, `Example`, `Argument step`, `Other`), the
  `sourceQuote` as a blockquote labelled "From the recording", and `Accept` /
  `Reject` buttons calling `updateGap(id, { status })`.
- Accepted suggestions in their own block, `From the recording`, labelled as
  recording-derived and not editable (A24): text and quote only, no controls,
  and nothing that writes to the transcript.
- Rejected ones listed muted under `Rejected`, with no controls, so a re-run
  visibly does not bring them back.

Errors from a run are caught and shown; the panel never throws into React.

## Tests

`src/gaps/window.test.ts`
1. window spans the first stroke time to `finalizedAt`, widened by the default
   lead and trail.
2. custom `leadMs` / `trailMs` are honoured, including `0`.
3. stroke `startedAt`/`endedAt` absent: falls back to the first and last point
   `t`.
4. `finalizedAt` `null` (page still open) and absent (v1 row): ends at the last
   stroke time.
5. `null` for a page with no strokes, for strokes with no points, and for
   strokes whose points carry no `t`.
   - also `null` for a stroke whose `startedAt`/`endedAt` are `NaN` (or
     infinite) with no usable point times — a non-finite window must never look
     comparable.
   - but a stroke carrying only `startedAt`, or only `endedAt`, and no point `t`
     yields the zero-length span at that instant rather than `null`.
6. strokes out of chronological order still give the min/max span.
7. `segmentsInWindow` includes a segment that starts before and ends inside the
   window, one wholly inside, one that starts inside and ends after, and one
   that spans the whole window.
8. `segmentsInWindow` excludes a segment wholly before and one wholly after.
9. boundary: a segment whose absolute end **equals** `fromMs`, and one whose
   absolute start **equals** `toMs`, are both included; one ending 1 ms before
   `fromMs` and one starting 1 ms after `toMs` are not.
10. `segmentsInWindow` is `[]` when the transcript is `null`, and when the
    transcript has no segments.
11. segments come back in `startMs` order even when stored out of order.
12. `speechTextOf` joins with one space, dropping empty and whitespace-only
    segments; `''` for none.

`src/gaps/chunk.test.ts`
13. text under the budget is one chunk (and is trimmed).
14. empty and whitespace-only text give `[]`.
15. long text splits into chunks each within the budget.
16. consecutive chunks overlap by about the overlap, and the chunks cover the
    whole text (every word of the input appears in some chunk).
17. chunks break on whitespace, not mid-word.
18. a single word longer than the budget is still cut (no infinite loop) and the
    call returns.
19. `overlap >= budget` is clamped and still terminates.
20. defaults are `GAP_CHUNK_CHARS` / `GAP_CHUNK_OVERLAP`; a non-positive budget
    falls back to the default.

`src/gaps/prompts.test.ts`
21. `gapModelFamily`: `gemma4:12b`, `library/gemma4:latest`, `GEMMA3:4B` →
    `gemma`; `mistral:7b` and `''` → `generic`.
22. `getGapPrompt('compare', …).promptVersion` is `gap-compare-<family>-v1`;
    `summarize` likewise; the two kinds never share a version.
23. `getGapPrompt` is deterministic for the same model.
24. every family's `compare` prompt names all six kinds, `text`, `kind`,
    `sourceQuote`, asks for JSON only and for an empty array when nothing is
    missing; every `summarize` prompt asks for bullet points and says
    substantive only.
25. `build` embeds the notes and the speech it is given, and neither prompt
    contains the other's instructions.
26. `gapPromptVersion(model, false)` is the compare version;
    `gapPromptVersion(model, true)` includes both, summarize first.

`src/gaps/validate.test.ts`
27. a clean array of three rows validates to three points.
28. a wrapper object (`{ points: [...] }`, `{ gaps: [...] }`) is unwrapped.
29. bad rows are dropped, not cast: `null`, a string, a number, an object with
    no `text`, with an empty/whitespace `text`, with a non-string `text`.
30. an unknown or missing `kind` becomes `'other'`; each of the six valid kinds
    survives.
31. a missing or non-string `sourceQuote` becomes `''`.
32. `text` and `sourceQuote` are trimmed, and an over-long value is capped.
33. a non-array, non-wrapper value (a string, a number, `null`) throws.
34. an empty array validates to `[]` (the model found nothing).
35. duplicate points within one response collapse to one.
36. `dropReviewed` removes points matching an `accepted` or a `rejected`
    suggestion, ignoring case, whitespace and trailing punctuation, and keeps
    points matching only a `proposed` one (those are being replaced anyway).

`src/gaps/eligibility.test.ts`
37. eligible when the page has strokes and a window, the recording's transcript
    is `done` and the page transcript is `done`.
38. each skip reason in turn: no strokes, no window, no recording, recording
    transcript `null`/`pending`/`running`/`failed`, page transcript
    `null`/not `done`.
39. `describeGapSkip` returns a distinct non-empty sentence per reason.

`src/gaps/analyzer.test.ts` (fake `TextGenerator`, `fake-indexeddb`, no fetch)
40. direct path: speech under the budget makes exactly one `compare` call, the
    prompt contains the page's markdown and the speech, and one
    `GapSuggestionRecord` per point is written with `status: 'proposed'`,
    `recordingId`, the window's `fromMs`/`toMs`, the model, the compare prompt
    version and `summarized: false`.
41. the page's `gapAnalysis` ends `done` with `error: null`, `summarized: false`
    and the model and prompt version, having been `running` while the call was
    in flight (observed from inside the fake generator).
42. summarized path: speech over the budget makes one `summarize` call per chunk
    plus one `compare` call, in that order; the compare prompt contains the
    bullets and not the raw speech; records and meta carry `summarized: true`
    and the combined prompt version.
43. a chunk that summarizes to an empty string is skipped and the run still
    completes.
44. `validate` drops bad rows: a response mixing two good rows with three bad
    ones writes two records and still reports `done`.
45. a re-run replaces only `proposed`: a page with one accepted, one rejected
    and two proposed suggestions keeps the accepted and the rejected ones and
    ends with the new proposals only.
46. a re-run does not resurface a rejected point: the model returns it again and
    it is not written.
47. a page with no strokes is skipped: no model call, no records, and
    `gapAnalysis` is left exactly as it was (absent stays absent).
48. a note with no linked recording is skipped, likewise silently.
49. a page whose transcript is not `done`, and a recording whose transcript is
    not `done`, are skipped.
50. no speech in the window: no model call is needed for a decision — nothing is
    written, the page's existing `proposed` suggestions **survive** (the run
    compared nothing and must not destroy what a run that compared something
    found) and `gapAnalysis` is `done` with `error: null` and
    `summarized: false`.
51. a generator failure records `gapAnalysis` `failed` with the error message,
    leaves the existing suggestions untouched, and rethrows.
52. an already-aborted signal aborts before any model call and records the
    abort.
53. the recording is chosen by A21: with two recordings linked to the note the
    earlier one is used; a recording linked only through the note's `sessionId`
    is found.
54. `analyzeNote` marks every eligible page `pending`, then analyzes them in
    `pageIndex` order, serially (the fake records interleaving and sees none).
55. `analyzeNote` skips ineligible pages without a model call and still analyzes
    the eligible ones.
56. `analyzeNote` continues past a page that fails, leaving that page `failed`
    and the next page `done`.
57. `analyzeNote` on a note with no pages resolves without writing anything.

`src/notes/GapPanel.test.tsx` (`createRoot` + `act`, injected fake analyzer)
58. keeps the contract: renders a `[aria-label="Gaps"]` section with the heading.
59. lists a page's `proposed` suggestions with text, a readable kind label and
    the source quote.
60. `Accept` sets that suggestion to `accepted` in storage and moves it into the
    accepted block, labelled as from the recording and with no edit control.
61. `Reject` sets it to `rejected` and moves it into the rejected block.
62. `Find gaps` calls `analyzePage` with this page's id and re-reads the list.
63. `Find gaps in note` calls `analyzeNote` with this note's id.
64. the buttons are disabled while a run is in flight and enabled again after it
    resolves.
65. `gapAnalysis` `running` shows "Looking for gaps…"; `pending` shows the
    waiting line.
66. `gapAnalysis` `failed` shows its error and still offers `Find gaps`.
67. an analyzer that rejects shows the error and leaves the panel usable.
68. `gapAnalysis` `done` with no suggestions says so plainly — and only when
    there was speech to compare:
    - an eligible page whose recording's segments all fall outside its window,
      with a `done` meta, says "The recording has no speech in this page's time
      window." and not "No gaps found"; it says it with a surviving `proposed`
      suggestion listed too.
    - a page whose window did hold speech still says "No gaps found in the
      recording for this page.", including when only an already-reviewed
      suggestion is on the page.
69. `summarized: true` says the speech was summarized and detail may be lost;
    `summarized: false` does not.
70. an ineligible page (no strokes) explains why and disables `Find gaps`, while
    `Find gaps in note` stays available.
71. a note with no recording says so, disables both find actions, and renders
    **no** source note — the page still has a stroke window, and the comparison
    sentence would be false beside it.
72. accepted suggestions never render an editable control and the panel never
    calls `setPageTranscript` (asserted by rendering with an accepted
    suggestion and checking the page's transcript is unchanged).

Existing `src/notes/NotesView.test.tsx` must keep passing unmodified.

## Assumptions

- **P1-A1** A skipped page (A22) writes **no** `gapAnalysis`: the panel derives
  the reason itself from the page and the recording. Stamping `done` would claim
  an analysis that never ran, and `GapAnalysisMeta` has no field for a skip
  reason (and `src/storage/types.ts` is not P1's to extend).
- **P1-A2** The model call happens **before** `deleteGapsByPage(pageId,
  'proposed')`, so a failed run leaves the previous suggestions in place. The
  delete and the batch write are two transactions; nothing else writes gaps, so
  the window between them is not contended.
- **P1-A3** A re-run drops a new point whose normalized text matches an
  `accepted` or `rejected` suggestion on the page. Comparison is on text, not
  the quote, and is deliberately loose (case, whitespace, trailing punctuation),
  because the model restates a point differently between runs. A reworded
  duplicate can still slip through and be rejected again.
- **P1-A4** `gapEligibility` / `describeGapSkip` are P1 additions beyond §6.5's
  listed exports, inside `src/gaps/`. They exist so the analyzer's skip rule and
  the panel's explanation are one piece of code.
- **P1-A5** `GapPanel` takes an optional, tests-only `analyzer` prop, following
  `NotesViewProps.queue`. `NotesView` still passes only `{ noteId, pageId }`.
- **P1-A6** No queue and no persistence of in-flight state: gap analysis is a
  foreground action bound to the panel. A reload mid-run leaves a page
  `running`; `Find gaps` starts it again. A queue is not in §6.5's contract.
- **P1-A7** `promptVersion` on a summarized suggestion is
  `gap-summarize-<family>-v1+gap-compare-<family>-v1`. One field has to describe
  a two-prompt pipeline, and a summarized result must not be mistaken for a
  direct one when a prompt is later retuned.
- **P1-A8** The analyzer needs the page's handwriting transcript to be `done` to
  say anything about what the page is missing, so a page whose transcript is
  `pending`, `running`, `failed` or absent is skipped, exactly like A22's cases.
  The trigger rule in `docs/spec-phase2.md` ("available once the note's page
  transcripts and the linked recording's transcript are `done`") is enforced
  here rather than only in the UI.
- **P1-A9** A blank page (finalized with no strokes, kept per A8) is skipped by
  `no-strokes`; a page whose strokes carry no `t` (ROM or legacy import) is
  skipped by `no-timestamps`. Neither is an error.
- **P1-A10** `analyzeNote` continues past a failing page. One bad page must not
  cost the rest of the note; each failure is readable on its own page.
- **P1-A11** Suggestion text and quotes are capped at 2000 characters in
  `validate`. A degenerate row that slipped past the client's own guard is
  truncated rather than allowed to fill the panel and the store.
- **P1-A12** An empty window is destructive to nothing. A run that compared no
  speech records `done` but leaves every existing suggestion in place, including
  `proposed` ones, so "look again" can never lose work; the only thing it
  changes is the status line. The cost is a page that may list proposals from a
  window that no longer matches the recording — visible and re-runnable, unlike
  a silent deletion.
- **P1-A13** "The window matched no speech" is derived in the panel, not stored:
  `GapAnalysisMeta` has no field for it and `src/storage/types.ts` is not P1's
  to extend. The panel recomputes it from the page and the recording it already
  loads, with the same helpers the analyzer uses, so the two cannot disagree
  about what was compared.
- **P1-A14** The panel's source note is gated on the eligibility result rather
  than on the stroke window, so every sentence that speaks in the present tense
  about "the recording" is only shown when there is one to compare against.
