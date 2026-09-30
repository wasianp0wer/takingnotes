# P2 — Syllabus import populates assignments into the calendar: feature spec

Branch `phase2/p2-syllabus`. Implements P2 of `docs/spec-phase2.md` (decisions
J3 and J7, assumptions A25–A27, A29, A30) against the contracts in
`docs/architecture.md` §6.4 (shared text generator), §6.5 (the P2 contract),
§6.6 (`syllabus.termStart`) and §6.7 (ownership).

Owned paths: `src/syllabus/**` except `src/syllabus/pdfjs.ts`, which the Phase 2
foundations own — this feature uses `loadPdfjs()` and never rewrites it, and
never imports `pdfjs-dist` statically.

## What the user gets

One "Syllabus" block in the Triage view (it feeds the calendar, whose deadlines
F3's task sync already turns into tasks):

1. **Two inputs, one path.** Choose a PDF, or paste the syllabus text. Both
   land on the same extraction path (J3 — no URL fetching).
2. **A term start control.** A date input backed by the `syllabus.termStart`
   setting, used to resolve dates that carry no year. Unset means "resolve
   against today".
3. **Extraction progress.** A readable line while it works: which PDF page is
   being read, which chunk is being extracted, and when a scanned page is going
   through the vision path.
4. **A mandatory review table (A25).** It always appears; nothing reaches the
   calendar until the user confirms, even when every row parsed cleanly. Each
   row has an include tick and editable title, due date, due time, required and
   estimated minutes. A row whose date could not be resolved shows an empty date
   and is excluded until one is given (A27). A row that already exists from a
   previous import is marked as such.
5. **Confirm.** Writes `kind: 'deadline'`, `source: 'syllabus'` events, reports
   created and updated counts, and runs F3's existing `syncTasksFromCalendar()`
   so the tasks appear. A re-import of the same syllabus updates rather than
   duplicates.

## Modules (`src/syllabus/`)

| File | Responsibility |
|------|----------------|
| `pdfjs.ts` | **Foundations, not edited.** `loadPdfjs()`, `PDF_WORKER_URL`, `pdfSupportProbe()`. |
| `pdfText.ts` | `extractPdfText(data)` per page, and `renderPdfPages(data, pageNumbers, opts?)` for the scanned pages. Both build on `loadPdfjs()`. |
| `dates.ts` | Pure `resolveDueDate(raw, termStart, now)` and `parseSyllabusDate(raw, termStart, now)`. |
| `chunk.ts` | Pure `chunkSyllabusText(text, opts?)` and the budget constants. |
| `assignments.ts` | `ExtractedAssignment`, the mandatory `validate` for the model's JSON array (`parseAssignments`), and `dedupeAssignments`. |
| `prompts.ts` | The prompt registry (the D8a pattern): `getSyllabusPromptFor(model)` and `getSyllabusVisionPromptFor(model)`, each returning a `promptVersion`. |
| `vision.ts` | `SyllabusPageReader` and `createOllamaPageReader(...)`: a rendered scanned page → plain text, over `createOllamaClient` with `images`. |
| `extractor.ts` | `createSyllabusExtractor(...)` → `SyllabusExtractor` (`fromText`, `fromPdf`). |
| `sourceRef.ts` | `sourceRefFor(importKey, a)`, `importKeyForFile(name)`, `importKeyForPastedText(text)`. |
| `importAssignments.ts` | `ConfirmedAssignment` and `importAssignments(rows, importKey)`. |
| `reviewRows.ts` | Pure review-table state: build rows, mark existing, re-resolve on a term-start change, filter to confirmed rows. |
| `ReviewTable.tsx` | The review table, a thin component over `reviewRows.ts`. |
| `SyllabusImport.tsx` | Replaces the placeholder body. Keeps the `SyllabusImport` export name and the `aria-label="Syllabus"` the host test asserts. |

## Rules

### PDF text (`pdfText.ts`)

`extractPdfText(data: ArrayBuffer): Promise<string[]>` returns one string per
page, in page order.

- Text items of a page are joined with spaces, and pdf.js's end-of-line markers
  become newlines, so a line-per-assignment table survives.
- A page whose text layer is empty, whitespace-only, or shorter than
  `PAGE_TEXT_MIN_CHARS` (16) comes back as `''`. That is the scanned-page
  signal; it is not an error.
- Every entry point passes pdf.js a **fresh copy** of the bytes
  (`data.slice(0)`), because pdf.js may transfer the buffer to its worker and
  detach it — otherwise a second pass over the same `ArrayBuffer` would throw.
- The document is destroyed in a `finally`, as `pdfSupportProbe()` does, so no
  call leaks a worker.

`renderPdfPages(data, pageNumbers, opts?: { longEdge?: number })` renders those
1-based pages to PNG blobs at a scale that puts the page's long edge at
`longEdge` (default 1400, above the 768 legibility floor found in Phase 1),
using `page.getViewport` and the page's `render({ canvasContext, viewport })`.
The canvas factory is injectable so a test needs no real canvas.

### Date resolution (`dates.ts`)

`parseSyllabusDate(raw, termStart, now): { at: number; hasTime: boolean } | null`
is the whole rule; `resolveDueDate` is the contract's thin wrapper returning
`at` or `null`. Everything is local time, via `Date` setters (no UTC drift).

Accepted, case-insensitively, with surrounding words ignored:

| Shape | Example |
|-------|---------|
| ISO | `2026-10-15`, `2026/10/15` |
| Month name and day, either order, with or without year | `Oct 15`, `October 15th, 2026`, `15 Oct`, `Oct. 15 2026` |
| Numeric month/day, US order (A: syllabuses in this app's context are US-style) | `10/15`, `10/15/2026`, `10/15/26` |
| Relative, against `now` | `today`, `tomorrow` |
| Any of the above plus a time | `Oct 15 at 11:59pm`, `10/15 5:00 PM`, `2026-10-15 17:00` |

Rules:

- **With a year**, that year is used as given. A two-digit year means 2000+.
- **With no year**, the year is the earliest one that puts the date on or after
  the local day of `termStart` — so a spring date on a syllabus whose term
  starts in January stays in that year, and a January date on a syllabus whose
  term starts in September rolls to the next year. A date falling exactly on the
  term-start day resolves to the term-start year (the boundary is inclusive).
- **No time** → local midnight of that day, `hasTime: false`. The caller writes
  the event `allDay: true`, and F3's `dueAtForEvent` already makes an all-day
  deadline due at the end of its local day.
- **A time** → that local instant, `hasTime: true`.
- **Unresolvable → `null`, never a guess** (spec-phase2, P2 "Extraction"):
  `TBD`, `see Canvas`, `Week 5`, `Finals week`, `''`, and any date that is not a
  real calendar day (`Feb 30`, `13/40`).

`termStart` is a number; the UI passes `syllabus.termStart ?? now`, which is the
documented default (A30-adjacent: "defaulting to the current date").

### Chunking (`chunk.ts`)

The same character-budget approach as P1: `SYLLABUS_DIRECT_CHAR_BUDGET` 6000,
`SYLLABUS_CHUNK_CHARS` 3000, `SYLLABUS_CHUNK_OVERLAP` 300.

`chunkSyllabusText(text)` returns `[text]` when it fits the direct budget;
otherwise overlapping chunks of about `SYLLABUS_CHUNK_CHARS` with
`SYLLABUS_CHUNK_OVERLAP` of carry-over, preferring a newline boundary near the
end of a chunk so a row of a deadline table is not cut in half. No empty chunks,
and no character is dropped. The overlap means the same assignment can appear in
two chunks, which is why the extractor dedupes.

### Extraction (`extractor.ts`, `assignments.ts`, `prompts.ts`)

```ts
export function createSyllabusExtractor(opts: {
  generator: TextGenerator;           // from createOllamaTextGenerator (§6.4)
  pageReader?: SyllabusPageReader;    // scanned pages; absent means skip them
  termStart?: number | null;          // resolves no-year dates at extract time
  now?: () => number;
  extractText?: typeof extractPdfText;   // injectable for tests
  renderPages?: typeof renderPdfPages;
}): SyllabusExtractor;
```

`fromText(text, { model, signal, onProgress? })`:

1. `chunkSyllabusText(text)`.
2. One `generator.generateJson` call per chunk with the registry's prompt for
   the model family, `validate: parseAssignments`. `signal` is passed through and
   checked between chunks so a cancel stops before the next call.
3. `dedupeAssignments` across chunks, keyed by normalized title plus `rawDate`.

`fromPdf(data, opts)`: `extractPdfText(data)`; pages that came back `''` are
rendered with `renderPdfPages` and read by `pageReader.readPage` (the vision
path) into text; with no `pageReader`, those pages are skipped rather than
failing. The page texts are concatenated in page order and go through the same
`fromText` pipeline, so a PDF and a paste behave identically.

`parseAssignments` is the mandatory `validate` (§6.4: model JSON is untrusted).
A non-array throws. Each row is **dropped** unless `title` is a non-empty
string; `dueDate` that is not a string becomes `rawDate: ''`; a `kind` present
and not `'deadline'` drops the row (J7); `estimatedMinutes` becomes `null`
unless it is a finite number `> 0`; `notes` becomes `''` unless it is a string.
`dueAt` is `resolveDueDate(rawDate, termStart ?? now, now)`.

Prompts follow Phase 1's registry pattern: a family per model
(`gemma`, `generic`, …) and a version recorded with each spec — text versions
`syllabus-<family>-v1`, vision versions `syllabus-vision-<family>-v1`. The text
prompt asks for a JSON array of
`{ title, dueDate, kind: 'deadline', estimatedMinutes?, notes? }`, assignment
deadlines only (J7 — no class meetings, no recurrence), `dueDate` copied
verbatim from the syllabus rather than normalized, and nothing invented: an item
with no date gets an empty `dueDate`. The vision prompt asks for the page's text
verbatim, because a scanned page is an OCR problem and the JSON shape is then
the text path's job.

`vision.ts` goes through `createOllamaClient({ label: 'Syllabus page' })` with
`images: [base64]`, `temperature: 0`, the shared `num_predict` cap, code-fence
stripping and the shared degenerate-output guard — the same guards as
transcription, which is where this pattern comes from.

### `sourceRef` and the write (`sourceRef.ts`, `importAssignments.ts`)

`sourceRefFor(importKey, a)` = `` `${importKey}#${normTitle}@${day}` ``, where
`normTitle` is the title lowercased, whitespace-collapsed and stripped of
trailing punctuation, and `day` is the resolved date as a local `YYYY-MM-DD`, or
`none` when it is null. Using the local day rather than the exact instant means
editing only the due *time* still updates the same event. Per A26, editing the
*title* produces a new ref and therefore a new event.

`importKeyForFile(name)` is `` `file:${name}` ``; `importKeyForPastedText(text)`
is `` `pasted:${fnv1a(text)}` `` — a small deterministic hash, so the same
pasted syllabus re-imports onto the same events.

`importAssignments(rows: ConfirmedAssignment[], importKey)`:

- Reads `listEvents()` once and indexes the `source === 'syllabus'` events by
  `sourceRef`.
- A matching ref → `updateEvent` (title, `startsAt`, `allDay`, `required`,
  `estimatedMinutes`, `notes`, `kind: 'deadline'`), counted as `updated`.
- No match → `createEvent` with `source: 'syllabus'` and that `sourceRef`,
  counted as `created`.
- Two rows in one batch that collapse to the same ref: the first creates, the
  second updates it, so a batch can never duplicate.
- `manual` events are never matched or touched, whatever their title.

It does **not** generate tasks. `SyllabusImport` calls F3's existing
`syncTasksFromCalendar()` after a successful write; task generation is not
reimplemented anywhere in `src/syllabus/`.

### The review table (`reviewRows.ts`, `ReviewTable.tsx`)

A row holds `id`, `title`, `dueDate` (a `YYYY-MM-DD` input value, `''` when
unresolved), `dueTime` (`HH:MM` or `''` for all-day), `required`,
`estimatedMinutes` (input text), `include`, `rawDate` and `existing`.

- `rowsFromExtracted(assignments, termStart, now)` — `include` defaults to
  `true`; a row with no resolvable date gets `dueDate: ''` and `include: false`
  (A27). `estimatedMinutes` empty means the event default (60, per A14).
- `reresolveRows(rows, termStart, now)` re-runs `parseSyllabusDate` on `rawDate`
  for rows the user has not edited, so changing the term start fixes the
  no-year rows without discarding manual entries.
- `markExisting(rows, events, importKey)` sets `existing` from the
  `source === 'syllabus'` events' `sourceRef`s, recomputed as titles and dates
  are edited.
- `toConfirmed(rows)` drops rows that are not included and rows with an empty or
  invalid date (so an unresolved row can never be written), and converts the
  input strings through `localDateTimeFromInputs` (read from F3's
  `src/triage/dates.ts`, not copied) into `{ dueAt, allDay }`.
- Confirm is disabled while `toConfirmed(rows)` is empty.

## Tests

`src/syllabus/pdfText.test.ts` — pdf.js stubbed at the module boundary
(`vi.mock('pdfjs-dist')`), as `pdfjs.test.ts` already does:

1. returns one string per page, in page order
2. joins a page's text items and turns pdf.js EOL markers into newlines
3. a page with an empty text layer comes back as `''`
4. a whitespace-only / near-empty page also comes back as `''` (scanned)
5. destroys the document even when a page rejects
6. passes pdf.js a copy, leaving the caller's `ArrayBuffer` usable twice
7. `renderPdfPages` renders only the requested pages, at the requested long edge
8. `renderPdfPages` destroys the document in a `finally`

`src/syllabus/dates.test.ts`:

9. ISO date with a year
10. `October 15th, 2026` and `Oct. 15 2026`
11. `15 Oct` (day-first, no year) resolves into the term-start year
12. a no-year date earlier in the calendar than the term start rolls to the next year
13. a no-year date falling exactly on the term-start day resolves to that year (boundary, inclusive)
14. `10/15` is month/day; `10/15/26` is 2026
15. a time makes `hasTime` true and lands on that local instant (`11:59pm`, `17:00`)
16. no time → local midnight, `hasTime` false
17. `today` / `tomorrow` resolve against `now`
18. `TBD`, `see Canvas`, `Week 5`, `''` → `null`
19. an impossible calendar date (`Feb 30`, `13/40`) → `null`, never a guess

`src/syllabus/chunk.test.ts`:

20. text inside the direct budget is one chunk, unchanged
21. longer text splits into overlapping chunks, each within the chunk budget
22. consecutive chunks share about the overlap, and no character is lost
23. splits prefer a newline boundary, so a deadline row is not cut in half
24. no empty chunks, including for a single line longer than the budget

`src/syllabus/assignments.test.ts`:

25. a well-formed array maps to `ExtractedAssignment`s with `dueAt` resolved
26. a non-array throws (the caller must not receive a cast)
27. rows with a missing or non-string or blank title are dropped
28. a non-string `dueDate` becomes `rawDate: ''` and `dueAt: null`
29. a row whose `kind` is present and not `'deadline'` is dropped (J7)
30. a non-finite or non-positive `estimatedMinutes` becomes `null`
31. unknown extra fields are ignored and `notes` defaults to `''`
32. `dedupeAssignments` collapses the same title and raw date, keeping the first

`src/syllabus/sourceRef.test.ts`:

33. the same import key and assignment always give the same ref (stability)
34. title case and whitespace differences give the same ref
35. a different title, or a different resolved day, gives a different ref (A26)
36. a null `dueAt` gives a stable `@none` ref
37. changing only the time of day keeps the ref
38. `importKeyForFile` and `importKeyForPastedText` are deterministic, and different text gives a different key

`src/syllabus/importAssignments.test.ts` (real fake-indexeddb, `resetDatabase`):

39. writes `kind: 'deadline'`, `source: 'syllabus'` and the computed `sourceRef`
40. an all-day row is stored `allDay: true` at local midnight
41. carries `required`, `estimatedMinutes` and `notes`
42. re-importing the same rows updates in place: counts `{ created: 0, updated: n }` and the event count does not grow
43. an edited title creates a new event rather than updating (A26)
44. two rows collapsing to one ref in a single batch create once and update once
45. a `manual` event with the same title is never matched or modified

`src/syllabus/extractor.test.ts` (fake `TextGenerator`, fake `SyllabusPageReader`):

46. short text is one model call, and bad rows are dropped by `validate`
47. long text is chunked into one call per chunk, and the results are deduped
48. `fromPdf` sends the PDF's page text down the same path
49. a page with no text layer is rendered and read through the vision path, and its text is folded in
50. with no `pageReader`, a scanned page is skipped rather than failing
51. an aborted signal stops before the next chunk's call
52. `onProgress` reports reading, vision and extraction steps in order

`src/syllabus/reviewRows.test.ts`:

53. `rowsFromExtracted` includes dated rows and excludes undated ones with an empty date (A27)
54. `reresolveRows` fixes no-year rows when the term start changes, and leaves user-edited rows alone
55. `markExisting` marks rows matching a previous import's `sourceRef` and only `syllabus` events
56. `toConfirmed` drops excluded rows, and rows whose date is empty or invalid
57. `toConfirmed` maps an empty time to `allDay: true` and a time to that instant
58. a blank estimate becomes the event default rather than `NaN`

`src/syllabus/SyllabusImport.test.tsx` (`createRoot` + `act`, no
@testing-library/react, fakes injected):

59. renders under `aria-label="Syllabus"` (the mount point the host test asserts)
60. pasting text and extracting shows the review table and writes **nothing** (A25)
61. confirming writes, reports created/updated counts, and calls the task sync exactly once
62. a row with no resolvable date renders an empty date, is unticked, and is not written
63. giving that row a date lets it be included and written
64. a row that already exists from a previous import is marked as such
65. editing a title and an estimate flows into the write
66. an extraction failure is surfaced as readable text and nothing is written
67. the term-start control loads and persists `syllabus.termStart`
68. a chosen PDF goes through the PDF path and reports page progress

No test may call a real model or fetch a real PDF over the network: the
`TextGenerator`, the `SyllabusPageReader`, the PDF text/render functions and the
storage writes are all injected or stubbed at a module boundary.

## Assumptions

Recorded rather than asked (all consistent with A25–A27, A29, A30):

- **P2-A1** Numeric dates are read US-style, month first (`10/15` is 15
  October). The app's syllabuses are US course syllabuses; a day-first reading
  would silently mis-date rows, and this is the convention the rest of the app's
  formatting already assumes.
- **P2-A2** A no-year date resolves to the earliest year on or after the term
  start's local day, inclusive on that day. "On or after the term start" is the
  only rule that makes a single term's syllabus come out right without guessing.
- **P2-A3** `now` is used only for relative words (`today`, `tomorrow`) and as
  the term-start fallback the UI supplies; it never overrides an explicit year.
- **P2-A4** A PDF page is treated as scanned when its text layer yields fewer
  than 16 non-whitespace characters. Below that there is nothing to extract from
  and the vision path is strictly better.
- **P2-A5** Scanned pages go through the vision model as **OCR** (page text out),
  and that text then goes down the same JSON extraction path. One JSON prompt to
  maintain, and the review table is the safety net either way.
- **P2-A6** `ExtractedAssignment` keeps exactly the §6.5 fields. Whether a time
  was stated is recovered in the review layer by re-reading `rawDate` through
  `parseSyllabusDate`, so the documented shape does not change.
- **P2-A7** `sourceRefFor` accepts `Pick<ExtractedAssignment, 'title' | 'dueAt'>`
  rather than the whole record, so `ConfirmedAssignment` can be passed to it.
  Every documented call site still type-checks.
- **P2-A8** `SyllabusImport` takes one optional `deps` prop for injecting fakes.
  `SyllabusImport()` with no props stays valid, which is what §6.7 requires and
  what `TriageView` calls.
- **P2-A9** The placeholder's "Check PDF support" button is dropped, which §6.5
  explicitly allows once P2's own PDF path exists. `extractPdfText` keeps pdf.js
  reachable from the entry, and the build check (no CDN host in `dist/`) still
  covers the worker.
- **P2-A10** The extractor resolves dates with the term start known at
  extraction time; the review table re-resolves from `rawDate` when the user
  changes it. Nothing is written before the user confirms either way.
- **P2-A11** Events are matched only within `source === 'syllabus'`, so the
  import can never adopt or overwrite a manually created event.
- **P2-A12** Every entry point that opens a PDF passes pdf.js a copy of the
  bytes, because pdf.js may transfer and detach the caller's `ArrayBuffer`.

## Done means

`npm run build` succeeds and still emits the pdf worker locally (no new CDN
reference in `dist/`); `npx vitest run` is green (769 existing plus this
feature's); `npx tsc -b` is clean; no new lint errors in touched files;
committed on `phase2/p2-syllabus` in logical commits.
