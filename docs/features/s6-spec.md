# S6 — Find and smart search: feature spec

Source requirements: `docs/spec-phase3.md` (K39–K44, K46, A39),
`docs/architecture.md` (§8.5 the two data-access helpers written for this
unit), `.superpowers/wave2/S6-brief.md`.

## Goal

A graduate student used the app for a week and could not find anything in
it: notes carry timestamp titles and there is no search of any kind. Tags
(S5) help the notes the owner thought to tag; this unit is the half that
works on everything else. Two modes, one query box (K40):

- **Find** — immediate, local, substring match. No model, no network, no
  explicit action: it runs on every keystroke against whatever is already
  loaded.
- **Smart search** — an explicit, two-stage Gemma pass (K42) that screens
  note summaries (or a stated fallback, K46) to shortlist candidate notes,
  then reads only those candidates' page text and bands each one **strong /
  moderate / weak**.

Both modes search the same five things (K41): note titles, note summaries,
page transcripts, typed page text, and audio transcripts. A hit links to
note + page, or to recording + segment timestamp for audio.

## What the foundations already guarantee (read from the code)

- `src/storage/recordings.ts`'s **`recordingsForNote(noteId)`** returns every
  *finished* recording linked to a note, directly (`recording.noteId`) or
  through the note's session (K12/A32), de-duplicated by id. This is the one
  place that knows both link paths (`gaps/analyzer.ts`'s `candidateRecordings`
  forwards to it); this unit must use it, not re-derive the two-path check,
  to attribute an audio-transcript hit back to a note.
- `src/storage/pages.ts`'s **`listAllPageText()`** returns every page in the
  database projected to `{ id, noteId, pageIndex, text, transcript }` — no
  `strokes`, `render` or `gapAnalysis`. `text` is present only on a
  `source: 'typed'` page (K32); that presence is what distinguishes a typed
  page from an ink/ROM one in a projection that otherwise reads the same
  field (`transcript.markdown`) for both, since `setPageText` mirrors typed
  text into `transcript` (K33) specifically so a second consumer never has to
  learn about a second text field.
- `src/storage/notes.ts`'s `listNotes()` (newest first) and
  `NoteRecord.summary: string | null`. `summary` is `null` for three
  populations (K46): legacy notes, a note whose page transcription failed
  (K19 — deliberately never named), and — before fix round 2's Important 1 —
  a note that ended on a typed page. Nothing in `src/storage/*` distinguishes
  these three; they are simply every note with `summary === null`.
- `src/storage/recordings.ts`'s `listFinishedRecordings()` (newest first);
  `RecordingRecord.transcript: AudioTranscriptRecord | null`, whose
  `segments: TranscriptSegment[]` carry `startMs`/`endMs` offsets from
  `recording.startedAt` and `text`.
- `src/llm/ollamaText.ts`'s `createOllamaTextGenerator({ baseUrl })` →
  `TextGenerator` with `generate` and `generateJson<T>({ model, system,
  validate, signal })`. `generateJson`'s `validate` is mandatory and is the
  one place untrusted model JSON is accepted or rejected (§6.4); a thrown
  `Error` from an unreachable host already reads `Could not reach Ollama at
  <url>: …` (`src/llm/ollamaClient.ts`'s `unreachableError`).
- `src/storage/settingKeys.ts`'s `getSettingValue('ollama.baseUrl'|'ollama.model')`
  (A30/A36) — this unit adds no setting and no model picker.
- `src/app/AppShell.tsx` owns the `Tabs`/`TabsList`/`TabsContent` that switch
  between Notes/Recordings/Triage; this unit adds a fourth trigger and
  content pane. `NotesView`/`NoteList`/`NoteToolbar`/`RecordingsView` are
  off-limits (another unit's files) and expose **no prop for an external
  caller to pick a note, a page or a recording** — `NotesViewProps` is
  `{ queue?, namingQueue? }`, `NotesView`'s `selectedNoteId` is private
  `useState`, and `RecordingsView`'s selection is likewise private. See
  Assumption S6-A6 for what "links to note + page" can honestly mean given
  that boundary. (This was the state at first implementation; fix round 1
  lifted the boundary for these two files specifically — S6-A6 now also
  records what shipped after that.)
- House test pattern: `createRoot` + `act`, no `@testing-library/react`
  (not a dependency). `src/notes/NotesView.test.tsx`'s `buttons()` /
  `buttonByText()` / `click()` / `settle()` helpers are the convention this
  unit's component test follows.

## Design

### `src/search/corpus.ts` — one read of storage, shared by both modes

```ts
export interface SearchPage {
  pageId: string;
  pageIndex: number;
  /** `PageTextProjection.text !== undefined` (K32) — a typed page, not ink/ROM. */
  isTyped: boolean;
  /** `transcript.markdown`, trimmed; `''` when not yet transcribed. */
  text: string;
}
export interface SearchNote {
  note: NoteRecord;
  /** This note's pages, `pageIndex` order, from `listAllPageText()`. */
  pages: SearchPage[];
  /** Fix round 3, C1/S6-A9: owned, done-transcribed recordings' text, joined oldest first. `''` when none. */
  audioText: string;
  /** Fix round 3, C1/S6-A9: the recording `audioText` came from (earliest contributing), or `null`. */
  primaryRecordingId: string | null;
}
export interface SearchCorpus {
  notes: SearchNote[];
  recordings: RecordingRecord[];
  /** recordingId -> noteId, built from `recordingOwnersByNote` (one definition — §8.5, extended S6-A1). */
  recordingOwner: Map<string, string>;
}
export async function loadSearchCorpus(): Promise<SearchCorpus>;
```

- One `listNotes()`, one `listAllPageText()`, one `listFinishedRecordings()`,
  grouped and sorted in memory — `listAllPageText()` exists exactly so this
  is one bulk read instead of one `listPages` per note (§8.5).
- `recordingOwner` is built by `recordingOwnersByNote(notes, recordings)`
  (fix round 3, I5/S6-A1, superseding a per-note `recordingsForNote` loop)
  in one pass over data already loaded. `audioText`/`primaryRecordingId`
  (fix round 3, C1/S6-A9) are derived from the same pass: every recording
  whose `recordingOwner` entry names a note, filtered to `status: 'done'`
  transcripts with non-blank text, sorted oldest-first per note.
- Loaded once per `SearchView` mount (or explicit reload), not on every
  keystroke: Find's own match function is pure and run against the already-
  loaded corpus, which is what makes Find "immediate" without re-reading
  storage on every character typed.

### `src/search/find.ts` — Find mode (K40, K41), pure

```ts
export type FindHitSource = 'note-title' | 'note-summary' | 'page-text' | 'audio-segment';
export interface FindHit {
  source: FindHitSource;
  noteId: string | null;   // null only for an audio hit whose recording has no owning note
  noteTitle: string | null;
  pageIndex?: number;      // 'page-text'
  isTyped?: boolean;       // 'page-text'
  recordingId?: string;    // 'audio-segment'
  recordingTitle?: string; // 'audio-segment'
  startMs?: number;        // 'audio-segment'
  snippet: string;
}
export function findInCorpus(corpus: SearchCorpus, query: string): FindHit[];
export function snippetAround(text: string, query: string, radius?: number): string;
```

- Case-insensitive substring match (K40 — no model, so no fuzziness). A
  query shorter than `MIN_QUERY_LENGTH` (2, fix round 3, I4/S6-A13) returns
  `[]`, not just a blank/whitespace-only one — matches too broadly to be
  useful on a real library otherwise.
- Searches, per note: `note.title`, `note.summary` (skipped when `null`),
  and each page's `text` (one hit per matching page, not per occurrence —
  K41's "links to note + page" is page-granular). Searches, per recording:
  each transcript segment's `text` (one hit per matching segment — K41's
  "recording + segment timestamp" is segment-granular, matching the
  recordings view's own clickable-per-segment granularity).
- An audio hit's `noteId`/`noteTitle` come from `corpus.recordingOwner`; a
  standalone recording (no linked note) still produces a hit, with both
  `null`.
- `snippetAround` returns the text around the first case-insensitive match
  (±`radius`, default 60, chars), trimmed, with a leading/trailing `…` when
  truncated. Used for every hit kind, including the title (for a long title
  that still reads oddly truncated — acceptable, titles are short).

### `src/search/prompts.ts` — the smart-search prompt registry (versioned, K42/K43)

Two prompts, not keyed by model family — following `naming/prompts.ts`'s
reasoning (A36: this reuses `ollama.model` as-is; no per-family wording is
needed yet, and a future revision that needs one adds the parameter the way
`transcription/prompts.ts` does):

```ts
export interface ScreenCandidate { index: number; title: string; text: string; }
export interface ScreenPromptInput { query: string; candidates: ScreenCandidate[]; }
export interface BandPromptInput { query: string; noteTitle: string; text: string; }

export const SCREEN_PROMPT_VERSION = 'search-screen-v1';
export const BAND_PROMPT_VERSION = 'search-band-v1';

export function getScreenPrompt(): { promptVersion: string; system: string; build(i: ScreenPromptInput): string };
export function getBandPrompt(): { promptVersion: string; system: string; build(i: BandPromptInput): string };
```

- **Screen** (stage 1): given the query and a numbered list of
  `{ title, text }` (`text` is the note's summary plus its recording text,
  or — K46 — its page text plus recording text when the summary is `null`;
  fix round 3, C1 added the recording half of both), return the JSON array
  of numbers that *might* be relevant. The prompt explicitly asks the model
  to **err toward inclusion** — "a closer check will narrow this down
  afterward" — because K42's whole case against a keyword prefilter is that
  a strict first pass finds nothing to rerank when the query shares no
  words with the note; a strict screening stage would quietly reproduce
  that same failure one layer up. Stage 2 is what enforces precision. Fix
  round 3, I2: the candidate list is batched (`screenBatch.ts`) against the
  project's own un-chunked-prompt ceiling, so one call per batch rather
  than one call over the whole library.
- **Band** (stage 2): given the query and one candidate note's full page
  text plus full recording transcript (fix round 3, C1), return
  `{ "band": "strong"|"moderate"|"weak"|"none", "reason": string }`, where
  `band` says how well the note answers the query and `reason` is a short
  span **copied from the text**, never invented — the same "never invent a
  quote" rule `gaps/prompts.ts`'s compare prompt already uses, because a
  fabricated snippet is worse than no snippet. Fix round 3, I3: the four
  quoted band labels are built from `BAND_LABELS` (`SMART_SEARCH_BANDS`
  plus `'none'`), the same array `validate.ts`'s accepted set is built
  from, so a retuned/renamed/added band cannot drift between the prompt's
  wording and what the validator will accept — mirroring `gaps/prompts.ts`'s
  `GAP_KINDS` pattern.
- Both prompts are round-tripped through their own validator by a dedicated
  test (see Tests) — the brief's own warning about a prompt that asks for
  one shape while its validator accepts another. Fix round 3 extended this:
  the screen prompt's worked example (`SCREEN_EXAMPLE_INDICES`) and every
  label the band prompt quotes (`BAND_LABELS`, via `it.each`) are now
  imported into their tests rather than hand-retyped, so the round-trip
  exercises the prompt's literal, current wording rather than a stand-in
  that could silently diverge from it.

### `src/search/validate.ts` — the untrusted JSON (pure)

```ts
export type SmartSearchBand = 'strong' | 'moderate' | 'weak';
export interface BandResult { band: SmartSearchBand | 'none'; reason: string; }
export const SEARCH_REASON_MAX = 500;

export function validateScreenIndices(value: unknown, candidateCount: number): number[];
export function validateBandResult(value: unknown): BandResult;
```

- `validateScreenIndices` accepts a bare array or a common wrapper object
  (`{ indices: […] }` / `{ candidates: […] }` / `{ relevant: […] }` /
  `{ matches: […] }` / `{ ids: […] }`), mirroring `gaps/validate.ts`'s
  `WRAPPER_KEYS` approach. Each entry is a number, or `{ index: number }`;
  anything else, or an out-of-range index (outside `1..candidateCount`), is
  **dropped, not cast** — one bad entry costs one candidate, not the whole
  screen. Duplicates collapse. A non-array, non-wrapper value (prose, a
  string) throws — the model did not do the task, which must not look like
  "found nothing". An empty result (`[]`, or everything dropped) is a valid,
  non-throwing "no candidates".
- `validateBandResult` throws only when the value is not even a JSON object
  (the model answered in prose). An unrecognised `band` value defaults to
  `'none'` rather than throwing, matching `gaps/validate.ts`'s "an unknown
  `kind` becomes `'other'`" convention — a malformed label on an otherwise-
  answered call should sink *this* candidate to "not a hit", not kill a run
  that already screened and is about to score several other candidates.
  `reason` is coerced to `''` when absent/non-string, and capped at
  `SEARCH_REASON_MAX` (same convention as `gaps/validate.ts`'s `GAP_TEXT_MAX`
  and `naming/validate.ts`'s `NAMING_SUMMARY_MAX` — model output is untrusted
  input, length included).

### `src/search/smartSearch.ts` — `runSmartSearch` (K42, K43, K44, K46)

```ts
export interface SmartSearchHit {
  noteId: string;
  noteTitle: string;
  band: SmartSearchBand;
  reason: string;
  /** Fix round 3, C1/S6-A9: set instead of a page when the note has no page text - the recording the hit came from. */
  recordingId?: string;
}
export interface SmartSearchResult {
  strong: SmartSearchHit[];
  moderate: SmartSearchHit[];
  weak: SmartSearchHit[];
  /** Notes with `summary === null`, screened by title + page text/recording instead (K44/K46). */
  unsummarizedCount: number;
  /** Fix round 3, I1/S6-A10: the honest subset of the above with *no* page text and *no* recording text either. */
  titleOnlyCount: number;
  /**
   * A screened candidate whose screen batch (fix round 3, I2) or band call
   * (fix round 1, Finding 2) then failed — dropped from every section, but
   * *not* folded into an indistinguishable "no match". See points 4 and 6
   * below.
   */
  uncheckedCount: number;
}
export interface SmartSearchDeps { generator: TextGenerator; model: string; }
export async function runSmartSearch(
  query: string,
  corpus: SearchCorpus,
  deps: SmartSearchDeps,
  opts?: { signal?: AbortSignal },
): Promise<SmartSearchResult>;
```

1. `unsummarizedCount` and `titleOnlyCount` are computed from the whole
   corpus (`note.summary === null`; and, for the latter, no page text and
   no `audioText` either) regardless of what follows — K44's reporting,
   "extended to cover the fallback path too, not narrowed by it" (K46), so
   neither is ever conditioned on how many candidates the model happens to
   pick.
2. An empty corpus, or a blank query, returns the all-empty result
   immediately — **no Ollama call is made.** This is what makes "smart
   search over an empty library … fails with a plain message rather than a
   stack trace" true by construction: there is no call that could produce a
   stack trace, and the view (not this function) renders the plain "nothing
   to search yet" message for a zero-note corpus.
3. Build one `ScreenCandidate` per note: `text` is `note.summary` (capped,
   `SCREEN_TEXT_MAX`) or — K46 — the note's page text joined in `pageIndex`
   order (capped tighter, `SCREEN_FALLBACK_TEXT_MAX`), with `note.audioText`
   (capped, `SCREEN_AUDIO_TEXT_MAX`) appended regardless (fix round 3, C1) —
   stage 1 only needs enough to judge topic, stage 2 reads the full text.
4. The candidate list is split into batches (fix round 3, I2,
   `screenBatch.ts`'s `batchScreenCandidates`) within
   `SCREEN_BATCH_CHAR_BUDGET`. One `generateJson` call per batch, `validate:
   validateScreenIndices` (now given the *exact* index set that batch
   offered, not a `1..count` range). Chosen indices are unioned across
   batches. **A failed batch is caught**, logged, and its candidates'
   count is added to `uncheckedCount` — batching means "the screen stage"
   is no longer one atomic call whose single failure can be cleanly
   surfaced as *the* K44 error; see point 6 and S6-A4/S6-A11.
5. For each chosen candidate, serially (Ollama serves one model at a time —
   the same reasoning `gaps/analyzer.ts`'s `summarizeChunks` already states):
   build its full page text joined with its full `audioText` (fix round 3,
   C1; capped, `DETAIL_TEXT_MAX_CHARS`), call the band prompt, and push the
   result into `strong`/`moderate`/`weak` unless `band === 'none'`. When the
   note has no page text, the pushed hit also carries `recordingId:
   note.primaryRecordingId` (C1's band-granularity ruling). **A
   per-candidate failure is caught, logged, counted in `uncheckedCount`,
   and the candidate is dropped** — one candidate's bad answer must not
   cost every other candidate's already-screened result (the same "one bad
   page must not stop the rest of the note" principle as
   `gaps/analyzer.ts`'s `analyzeNote`) — except an abort
   (`signal.aborted`/`AbortError`), which is the user cancelling and ends
   the loop by rethrowing.
6. If Ollama goes unreachable at any point *after* the first screen batch,
   every subsequent call fails and is caught (point 4 or point 5). The run
   still ends with zero hits for those candidates, but `uncheckedCount`
   reflects it, so the view reports "could not be checked" rather than
   letting a confidently empty result read as "no matches" — the exact
   silent-wrong-answer class this phase has been digging out elsewhere.
   `SearchView` renders this as its own line, separate from each band's
   "No matches.". This still does not make K44's "fails with a plain
   message" airtight for every call in a run — only the very *first*
   screen batch can propagate as a thrown error; everything after that
   degrades to a counted, reported omission instead. Both halves are a
   deliberate, documented trade-off (S6-A4, extended S6-A11), not an
   oversight — see Assumptions.

### `src/search/startSearch.ts` — settings-wired deps

```ts
export async function getSmartSearchDeps(): Promise<SmartSearchDeps>;
```

Reads `ollama.baseUrl`/`ollama.model` (A30/A36) and builds
`createOllamaTextGenerator({ baseUrl })`, mirroring `gaps/startGaps.ts`'s
`createConfiguredGapAnalyzer`. Built per run, not cached, for the same
reason: an explicit action should pick up a settings change between two
presses. Never called by a test.

### `src/search/SearchView.tsx`

```ts
export interface SearchViewProps {
  /** Tests only — a real mount builds its own via `getSmartSearchDeps`. */
  smartSearchDeps?: SmartSearchDeps;
  /**
   * From `AppShell` (fix round 1, Finding 1). `pageIndex` is `0` for a hit
   * naming no specific page (a note-title/summary Find hit, or any
   * smart-search hit).
   */
  onOpenNotes?: (noteId: string, pageIndex: number) => void;
  /** `startMs` names the segment to look for, when the hit has one. */
  onOpenRecordings?: (recordingId: string, startMs?: number) => void;
}
export function SearchView(props?: SearchViewProps): JSX.Element;
```

- Loads the corpus on mount (`loadSearchCorpus`); while it is still
  loading, renders a "Loading…" state with the `aria-label="Search"`
  landmark already present (fix round 3, I5 — previously rendered `null`,
  nothing at all). A corpus with zero notes and zero recordings renders
  "Nothing to search yet — write a note or make a recording first." in
  place of the controls (K44's empty-library case, handled here rather
  than inside `runSmartSearch` per its own doc above).
- A query `Input`, bound to the raw `query` state so typing feels
  immediate. **Find** recomputes/renders from a separate `debouncedQuery`
  (150ms, fix round 3, I4) rather than every raw keystroke; rendered hits
  are capped at `FIND_RESULTS_CAP` (50) with a "Showing first 50 of N
  matches." line naming the true total when there are more. Each row
  shows the snippet and a button that calls `onOpenNotes(hit.noteId,
  hit.pageIndex ?? 0)` or `onOpenRecordings(hit.recordingId, hit.startMs)`
  by hit kind (S6-A6). Changing the query also clears any prior smart-
  search result and error (fix round 3, I6) — without this, an old
  Strong/Moderate/Weak result for a previous query kept reading as an
  answer to the new one.
- A **Smart search** button: disabled while a run is in flight, while the
  query is blank, or while the corpus has no notes. On click, builds an
  `AbortController` (fix round 3, M2), passes its `signal` to
  `runSmartSearch` (via `props.smartSearchDeps ?? await
  getSmartSearchDeps()`, the same tests-only-override shape as
  `GapPanel`'s `analyzer` prop and `NotesView`'s `queue` prop) inside a
  `try/catch`; a rejection sets an error string shown in destructive text
  — **the error never escapes the handler**, so it can never reach React
  as an uncaught rejection or a stack trace (same pattern as
  `GapPanel.run`). The view's unmount cleanup aborts the controller and a
  `liveRef` guards the three post-`await` `setState` calls against firing
  after unmount — a run abandoned by a tab switch (the view remounts
  fresh on the next visit; S6-A6) no longer keeps making serial model
  calls for a result nothing will read.
- Results render as three headed sections, **Strong / Moderate / Weak**
  (K42, labels from `SMART_SEARCH_BANDS`, fix round 3, I3 — not a fourth
  hand-copy of the band list), each hit showing the note title and its
  `reason`, plus an Open button that calls `onOpenRecordings(hit.recordingId)`
  when set, `onOpenNotes(hit.noteId, 0)` otherwise (fix round 3, C1's
  band-granularity ruling). Two lines report what couldn't be fully
  screened: `unsummarizedCount - titleOnlyCount` notes "have no summary
  yet and were screened by title and page text or recording content
  instead." (K44/K46, now including the recording half C1 added), and
  `titleOnlyCount` (fix round 3, I1) "have neither page text nor a
  recording, and were screened by title alone." — a plainly different,
  and honest, sentence for the notes the first line cannot truthfully
  cover. A third, separately-styled line states `uncheckedCount` when it
  is `> 0` (fix round 1, Finding 2; extended fix round 3, I2 to cover a
  failed screen batch too): a candidate that could not be checked,
  reported distinctly from "No matches." so a run where every batch or
  band call fails does not read as a confidently empty result.
- No result section renders as "No matches." rather than being omitted
  entirely, so "ran and found nothing" is distinguishable from "hasn't run
  yet" (no smart-search section is rendered at all before the first run).

### `src/app/AppShell.tsx`

Adds a fourth `TabsTrigger`/`TabsContent` ("Search") alongside
Notes/Recordings/Triage (K39: "its own tab… it spans notes *and*
recordings, so it does not belong inside either view"). As of fix round 1,
Finding 1, it also owns the one pending cross-tab navigation request
(`NavigationTarget`, tagged `'note' | 'recording'`, each carrying a
monotonic `token`): `openNote`/`openRecording` bump the token, store the
target, and switch tabs; `clearNavigationTarget` (stable via `useCallback`)
is passed to both `NotesView` and `RecordingsView` as
`onExternalSelectionApplied`, so a consumed request does not linger to
re-fire on some later, unrelated switch to that tab. See Assumption S6-A6
for the full shape and its one named residual gap (segment auto-seek).

## Tests

`src/search/corpus.test.ts`
1. groups pages under their note, sorted by `pageIndex`, from real
   `createNote`/`createPage`/`setPageTranscript` writes.
2. a typed page (`createTypedPage`/`setPageText`) is projected with
   `isTyped: true` and its text in `page.text`; an ink page is
   `isTyped: false`.
3. `recordingOwner` maps a directly-linked recording
   (`recording.noteId`) and a session-linked one (K12/A32, no direct
   `noteId`) to the same note; a standalone recording (no note, no session)
   is absent from the map.
4. an empty database yields `{ notes: [], recordings: [], recordingOwner:
   size 0 }`, not a throw.

`src/search/find.test.ts`
5. matches a note title, case-insensitively.
6. matches a note summary; a `null` summary is skipped without throwing.
7. matches page text for both an ink page (via `transcript.markdown`) and a
   typed page (via mirrored `transcript`, K33) — one hit each, `isTyped` set
   correctly.
8. matches an audio transcript segment; the hit carries the segment's
   `startMs` and the owning note's id/title via `recordingOwner`.
9. an audio hit for a recording with **no** owning note (standalone, A10)
   still appears, with `noteId`/`noteTitle` both `null`.
10. a blank/whitespace query returns `[]` without scanning (mutation-check:
    break the early return and confirm every page's text starts coming back
    as a hit).
11. two pages of the same note both matching produce two distinct hits
    (page-granular, not note-granular).
12. a query present in one segment but not another of the same recording
    produces one hit, not two.
13. `snippetAround` returns text centered on the match with ellipses when
    truncated, and the untruncated text verbatim when it's shorter than the
    radius.

`src/search/prompts.test.ts`
14. `getScreenPrompt().build` embeds the query and every candidate's title
    and text, numbered to match `candidates[i].index`.
15. `getBandPrompt().build` embeds the query, the note title and its text.
16. **Round-trip**: a worked example reply matching the screen prompt's own
    stated shape (`'[1, 3]'`) parses and validates via
    `validateScreenIndices` to `[1, 3]`; a worked example matching the band
    prompt's stated shape (`'{"band":"strong","reason":"…"}'`) validates via
    `validateBandResult` to the same band and reason. This is the check the
    brief calls out by name: the prompt's stated shape and the validator's
    accepted shape are exercised against the same literal string.
17. both prompts' `promptVersion` are stable, non-empty and distinct from
    each other and from every existing registry's versions (`naming-v1`,
    `gap-*`, transcription's `*-v1`).

`src/search/validate.test.ts`
18. a clean array of numbers validates to itself, sorted, deduped.
19. a wrapper object (`{ indices: […] }`, `{ candidates: […] }`, etc.) is
    unwrapped.
20. an out-of-range index (`0`, negative, greater than `candidateCount`,
    non-integer) is dropped, not thrown on.
21. a non-array, non-wrapper value (a string, a number, `null`) throws.
22. an empty array, and an array that fully drops, both validate to `[]`
    without throwing.
23. `validateBandResult`: each of `strong`/`moderate`/`weak`/`none` survives
    (case/whitespace-insensitively); an unrecognised string becomes `'none'`.
24. a non-object value throws; a missing/non-string `reason` becomes `''`;
    an over-long `reason` is capped.

`src/search/smartSearch.test.ts` (fake `TextGenerator`, `fake-indexeddb`)
25. a note with a summary is screened on that summary; a note with
    `summary === null` is screened on its title + page text instead
    (asserted from the fake generator's captured prompt text) — K46's
    behavioural core.
26. `unsummarizedCount` counts exactly the `summary === null` notes,
    regardless of how many the screen stage returns, and regardless of
    whether any hit at all is found (mutation-check: this is the field most
    likely to survive a mutation vacuously if only checked with `toBeGreaterThan(0)`
    — assert the exact number).
27. only the screened candidates get a band call (a note the screen step
    did not choose never reaches the second stage — asserted by call count
    and by which note ids were used to build which prompts).
28. a candidate banded `'none'` is excluded from every section.
29. candidates land in the matching section (`strong`/`moderate`/`weak`) by
    the band they were given.
30. an empty corpus returns the all-empty result and makes **zero** calls
    to the generator (mutation-check: assert `generator.calls.length === 0`,
    not just that the result is empty, so a mutation that calls Ollama with
    an empty candidate list and happens to get `[]` back cannot pass this
    silently).
31. a blank query likewise makes zero calls.
32. the screen call rejecting (simulating an unreachable host) makes
    `runSmartSearch` reject with that same error — it is not swallowed.
33. one candidate's band call rejecting is logged and excluded, while the
    other candidates' results still come back (the per-candidate resilience
    S6-A4 documents).
34. an already-aborted signal aborts before the screen call; an abort
    arriving between band calls stops the loop and rethrows rather than
    being swallowed as a per-candidate failure.
35. band calls for multiple candidates happen serially, not concurrently
    (the fake generator records overlap and sees none — same style as
    `gaps/analyzer.test.ts`'s interleaving check).

`src/search/SearchView.test.tsx` (`createRoot` + `act`, injected fake
`smartSearchDeps`)
36. typing a query that matches a note's title shows a Find hit with the
    note's title and a snippet, live (no explicit submit).
37. clearing the query clears the Find results.
38. Smart search is disabled with a blank query, and with no notes in the
    library; typing a query and having at least one note enables it.
39. clicking Smart search calls the injected generator and renders Strong /
    Moderate / Weak sections from its (validated) reply.
40. a band of `'none'` from the fake generator does not appear in any
    section.
41. the `unsummarizedCount` line appears, with the right number, after a
    run over a library where every note has `summary: null`.
42. a rejecting fake generator shows a plain error string, not a thrown
    render — the test asserts the component is still interactive afterwards
    (the query input still accepts typing), which a crashed tree could not
    do.
43. an empty library (no notes, no recordings) renders the "nothing to
    search yet" message and no Smart search button.
44. a Find hit's "Open" button calls the `onOpenNotes`/`onOpenRecordings`
    prop it was given, by hit kind.

`src/app/AppShell.test.tsx` (existing file, extended)
45. the tab list gains "Search", alongside the existing three (the existing
    "shows the three tabs" assertion is corrected to four).
46. switching to the Search tab renders `SearchView`'s own landmark (its
    root `aria-label`).

## Assumptions

- **S6-A1** ⚑ **Superseded by fix round 3, I5 — recorded for history.**
  Originally: `SearchCorpus.recordingOwner` was built by calling
  `recordingsForNote(note.id)` once per note, costing one
  `listFinishedRecordings()` scan per note rather than one overall. The
  brief required using the one correct link-path definition rather than
  re-deriving it, and that was the only way to call it that did so without
  a storage-layer change. **As shipped after fix round 3:** the
  coordinator authorised a boundary extension - `src/storage/recordings.ts`
  gained `recordingOwnersByNote(notes, finishedRecordings)`, a batch form
  of the same two-link-path check that takes data already loaded and
  builds the whole map in one pass, with no further storage reads.
  `loadSearchCorpus` calls it once. The "one correct definition" property
  this assumption worried about giving up is preserved: both the single-
  note and batch forms live in the same file, checked against each other
  by a dedicated equivalence test
  (`src/storage/recordings.test.ts`'s "matches recordingsForNote looped
  per note...").
- **S6-A2** Find is page-granular for notes (one hit per matching page) and
  segment-granular for recordings (one hit per matching segment), matching
  K41's two link grandularities ("note + page", "recording + segment
  timestamp") exactly rather than collapsing either to one hit per note or
  per recording.
- **S6-A3** The screen prompt is explicitly told to be generous (include a
  note it is unsure about) rather than strict, because K42's own rationale
  for rejecting a keyword prefilter — it "finds nothing to rerank when the
  query shares no words with the note" — is a failure mode a strict
  semantic screen could reproduce just as easily. Precision is stage 2's
  job, not stage 1's.
- **S6-A4** A per-candidate band-stage failure is caught and the candidate
  is dropped; only the screen-stage call's failure propagates as a visible
  error. **Updated by fix round 1, Finding 2:** a dropped candidate is no
  longer indistinguishable from "found nothing" — it is counted in
  `uncheckedCount` and `SearchView` reports it in its own line, separate
  from each band's "No matches.". This means an Ollama host that goes
  unreachable *between* the screen call and the band calls is now reported
  as "N notes could not be checked" rather than silently as zero hits —
  still not the thrown error K44 asks for (that guarantee holds only for
  the *first* call of a run, the screen call), but no longer a false
  negative either. The original per-candidate catch-and-drop is unchanged
  and still the right call: the alternative (treating any band failure as
  fatal) would make one malformed-but-answered reply from a model abort
  every other already-screened candidate's result, which is a worse
  everyday failure mode for what is, in the common case, a transient
  parsing hiccup rather than a dead host.
- **S6-A5** `runSmartSearch` makes no Ollama call at all for an empty corpus
  or a blank query; the "nothing to search yet" / "type something" messaging
  is the view's responsibility, not this function's return shape. Keeps the
  orchestration function's contract to "a result, or a rejection from a real
  model call" — no synthetic in-band error value.
- **S6-A6** ⚑ **Superseded by fix round 1, Finding 1 — recorded here for
  history.** Originally: "links to note + page / recording + timestamp"
  (K41) was cross-*tab* navigation only, because `NotesView` and
  `RecordingsView` were off-limits and exposed no prop through which an
  external caller could set which note, page or recording was selected.
  The coordinator verified this and lifted the ownership boundary for
  exactly those two files. **As shipped after fix round 1:**
  - `NotesView` takes `external?: NotesExternalSelection` (`{ token,
    noteId, pageIndex }`) and `onExternalSelectionApplied?: () => void`.
    Applied during the same render-time comparison block that already
    resolves the default/active-note selection (not in an effect, so there
    is no placeholder-frame flash) — see `NotesView.tsx`'s own comment at
    the `hasPendingExternalSelection` branch for exactly why it cannot fire
    on the same render as the active-note-follow branch, and therefore
    never fights it. A single click on a note+page hit now lands on that
    exact note and page.
  - `RecordingsView` takes the analogous `external?:
    RecordingsExternalSelection` (`{ token, recordingId, startMs? }`) and
    selects the named recording. **One real gap remains, by design, not by
    oversight:** this view cannot seek `RecordingDetail`'s `<audio>`
    element, since that element and its `seekTo` are private to
    `RecordingDetail.tsx` — a third file, never named in the lifted
    boundary ("`src/notes/NotesView.tsx` and
    `src/recordings/RecordingsView.tsx`", specifically). Rather than
    stretch that grant to a file it did not name, `RecordingsView` instead
    shows a one-line hint ("Jumped here from search — look for the segment
    at …") naming the timestamp the hit matched, beside the (correctly
    selected) recording's own segment list, which already has the "the
    recordings view already has clickable segment timestamps" K41 points
    at. An audio hit therefore costs one more click than a note hit does;
    that residual gap, and the one file that would need to be added to the
    grant to close it, is named again in `s6-report.md`'s fix round 1
    section rather than silently worked around.
  - In both cases, the token exists because the obvious shape — a bare
    `{noteId, pageIndex}`/`{recordingId}` prop — cannot be re-applied: once
    a view has "seen" a given value once, a second identical prop is
    indistinguishable from the first and does nothing. `AppShell` bumps a
    counter on every "Open" click, including a repeat of the exact same
    hit, and each view tracks which token it last applied.
- **S6-A7** No new setting is added. The brief allows one "if needed"; this
  unit needed none — there is no persisted state (no saved searches, no
  remembered query) and the model/host come entirely from `ollama.model`/
  `ollama.baseUrl` (A30/A36).
- **S6-A8** Screen-stage candidate text is capped (`SCREEN_TEXT_MAX` for a
  real summary, a tighter `SCREEN_FALLBACK_TEXT_MAX` for K46's title+page-text
  fallback, and (fix round 3, C1) `SCREEN_AUDIO_TEXT_MAX` for the recording
  gist appended to either — stage 1 only needs enough to judge topic) and
  detail-stage text is capped at a much larger `DETAIL_TEXT_MAX_CHARS`
  (now covering page text *and* the full recording transcript, C1) with no
  per-note chunking. Unlike `gaps/analyzer.ts`'s speech (which can be an
  hour of transcribed lecture), a note's own page text is "a few kilobytes"
  at most (`architecture.md` §8.5's own description of what
  `listAllPageText` exists to search cheaply) — a recording's transcript
  can be longer, but still bounded by one lecture's length, not a whole
  library's — so a hard cap rather than `gaps/chunk.ts`'s per-note
  summarize-then-compare pipeline is treated as sufficient for a single
  note's text; an unusually long note's tail is simply not read by the
  band stage. (This is a different budget from fix round 3 I2's
  *library-wide* screen batching below — this one bounds one note's own
  text, that one bounds how many notes' candidates ride in one prompt.)
  Matches K43's own framing — prompt and threshold tuning is expected
  after first contact with real summaries, and this is one of the
  thresholds that may need revisiting before then.
- **S6-A9** ⚑ **Fix round 3, C1 (Critical).** Smart search originally
  never read `corpus.recordings`/`corpus.recordingOwner` at all - both
  stages screened on `note.summary` and page text only, four of K41's five
  sources. Fixed: `SearchNote.audioText` (corpus.ts) is appended to the
  screen candidate's text and joined into the band stage's detail text
  alongside page text. The coordinator's band-granularity ruling: a
  smart-search hit stays note-granular (banding a note is inherent to
  K42's two-stage design), but when a note has no page text at all, its
  hit carries `recordingId: note.primaryRecordingId` instead of implying a
  page that was never the source - `SearchView`'s smart-hit "Open" opens
  that recording in that case, the note otherwise.
- **S6-A10** Fix round 3, I1. `titleOnlyCount` (the subset of
  `unsummarizedCount` with *no* page text and *no* recording text) exists
  because C1 widened K46's fallback to include recording text, which
  dissolved most of the original overclaim ("screened by title and page
  text" for a note that had neither) but not all of it — a note with none
  of the three populations (no summary, no page text, no recording) still
  exists, and the view now says so in a separate, honest sentence rather
  than folding it into the wider "screened by title and page text or
  recording content" line.
- **S6-A11** Fix round 3, I2. The screen call is batched against
  `SCREEN_BATCH_CHAR_BUDGET` (= `gaps/constants.ts`'s
  `GAP_DIRECT_CHAR_BUDGET`, imported rather than re-declared at a
  different value) via `src/search/screenBatch.ts`'s
  `batchScreenCandidates`, mirroring `gaps/chunk.ts`'s precedent but
  without overlap - a candidate is a complete, atomic record, not
  continuous text with a mid-sentence-split risk. `validateScreenIndices`
  now takes the exact `Set` of indices a given call offered rather than a
  `1..count` range, since under batching a count-based range would wrongly
  accept an index belonging to a different batch's own prompt. A failed
  batch's candidates count into `uncheckedCount` (extending S6-A4's
  per-candidate resilience to the screen stage, now that it is no longer
  one atomic call) rather than rejecting the whole run - see S6-A4's own
  text for the K44 nuance this implies.
- **S6-A12** Fix round 3, I3. `SMART_SEARCH_BANDS`/`BAND_LABELS`
  (`src/search/prompts.ts`) are the one list the band prompt's wording,
  `validate.ts`'s accepted values, and `SearchView.tsx`'s section labels
  are all built from (mirroring `gaps/prompts.ts`'s `GAP_KINDS` pattern).
  This closes drift between the *prompt wording* and the *validator*
  specifically - it does not make a full band rename a one-array-edit
  change throughout the codebase: `SmartSearchResult`/`SmartSearchHit`'s
  `strong`/`moderate`/`weak` fields are a hand-written TypeScript
  interface, not generated from the array, and a real rename still
  correctly requires touching them (caught by the compiler, not silently)
  — confirmed by actually attempting a full rename during this fix round's
  mutation-checking rather than assumed.
- **S6-A13** Fix round 3, I4. `MIN_QUERY_LENGTH` (2) and the 150ms
  `FIND_DEBOUNCE_MS` are both chosen, not measured against real usage -
  K43-style tuning candidates, not load-bearing values. `FIND_RESULTS_CAP`
  (50) caps *rendered* hits only; `findInCorpus` itself still computes the
  full match set so the view can report the true total ("Showing first 50
  of N matches.").
- **S6-A14** Fix round 3, M2. `runSmartSearch`'s `signal` support (added
  and tested in fix round 1, before `SearchView` ever passed one) is now
  actually wired from `SearchView`: an `AbortController` per run, aborted
  from the view's unmount cleanup. A `liveRef` (not component state, to
  avoid an extra render) guards the three post-`await` `setState` calls
  in `handleSmartSearch` against firing after unmount.
- **S6-A15** ⚑ **M5 (lift `query`/`smart` into `AppShell` so a tab
  round-trip does not lose them) was not attempted this round.** Given the
  number of other items already closed and mutation-checked, and that
  this one is structurally larger (either making `SearchView`'s relevant
  props required - breaking its ~24-test file's existing direct-render
  call sites - or adding a dual controlled/uncontrolled mode), it was
  judged lower value for the risk of destabilising a large, already-
  tested surface than finishing the rest of the round carefully. Recorded
  as a deliberate stop, not a silent omission - see `s6-report.md`'s fix
  round 3 section for the reasoning in full.
