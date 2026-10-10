# TakingNotes — Architecture (Phase 0)

This is the contract Phase 1 features build against. Product decisions are in
`docs/spec.md`. Where this document and the code disagree after Phase 0 lands,
the code in `src/storage/types.ts`, `src/storage/db.ts` and
`src/capture/types.ts` wins; update this file to match.

## 1. Shape of the app

```
main.tsx
 └─ TabletProvider (device controller: BLE, streaming, reconnect, page-turn poll)
     └─ CaptureProvider (one CaptureEngine: pen stream → strokes → pages → notes)
         └─ AppShell
             ├─ header: DeviceStatus · tabs [Notes | Recordings | Triage] · RecorderControl · Settings
             ├─ Notes tab      → NotesView        (F1; mounts PageTurnControls from F4)
             ├─ Recordings tab → RecordingsView   (F2)
             └─ Triage tab     → TriageView       (F3)
```

- No router, no global store. State lives in IndexedDB plus small
  subscribe/getState objects exposed through React context and read with
  `useSyncExternalStore` (the pattern `TabletProvider` already uses).
- `main.tsx` holds a small `CaptureRoot` inside `TabletProvider`: it reads
  `useHuionDevice()` and builds the one engine with
  `createCaptureEngine({ controller })` in a `useState` initializer. The engine
  is never disposed - StrictMode's double mount would tear down the engine the
  app keeps using.
- `AppShell` reads `useHuionDevice()` once and passes `{ controller, state }`
  into `DeviceStatus` as props, so the header can be tested against
  `createFakeDeviceController()` with no provider. Connecting runs
  `controller.connect()` then `controller.startStreaming()`.
- Pure logic lives in plain `.ts` modules with unit tests; React components are
  thin.
- Existing layers are reused unchanged: `src/utils/huion*` (driver, protocol,
  transport, paced transport), `src/device/*` (controller, emitter, reconnect,
  liveness, pageTurnDetector, TabletProvider), `src/storage/*`.

## 2. Data model

All timestamps are **epoch milliseconds** (`Date.now()` clock). Stroke point
times and audio segment times share this clock, which is what lets Phase 2
align handwriting with the recording.

Relations are one-directional foreign keys; there are no id arrays on parents.

```
Session 1 ──< Note 1 ──< Page
   1
   └────< Recording            (Recording.noteId optional, for convenience)

CalendarEvent 1 ──< Task       (Task.eventId, at most one open task per event)
```

### 2.1 Existing records, extended

```ts
export interface StrokePoint {
  x: number; y: number;            // normalized 0-1
  pressure: number;                // 0-1
  /** Epoch ms when the point was received. Live capture only; ROM/legacy points omit it. */
  t?: number;
}

export interface PageStroke {
  points: StrokePoint[];
  /** Epoch ms of first/last point. Live capture only. */
  startedAt?: number;
  endedAt?: number;
}

export interface NoteRecord {
  // ...all existing fields unchanged...
  /** Session this note belongs to. `null` for legacy/imported notes. Absent on v1 rows = null. */
  sessionId?: string | null;
}

export interface PageRecord {
  // ...all existing fields unchanged...
  /**
   * Epoch ms when the page stopped accepting strokes (page turn, new page,
   * note end). `null` while the page is being written. Absent on v1 rows =
   * finalized (legacy pages are complete by definition).
   */
  finalizedAt?: number | null;
}
```

`NoteStatus` stays `'active' | 'interrupted' | 'complete'`.
`TranscriptRecord` (page handwriting transcript) is unchanged.

### 2.2 New records

```ts
export type SessionStatus = 'active' | 'ended';

export interface SessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  startedAt: number;
  endedAt: number | null;
}

export interface TranscriptSegment {
  /** Offsets from Recording.startedAt, in ms. Absolute time = startedAt + startMs. */
  startMs: number;
  endMs: number;
  text: string;
}

export interface AudioTranscriptRecord {
  text: string;
  segments: TranscriptSegment[];
  /** Whisper model id, e.g. `Xenova/whisper-base.en`. */
  model: string;
  language: string | null;
  status: TranscriptStatus;        // reuses 'pending' | 'running' | 'done' | 'failed'
  error: string | null;
  updatedAt: number;
}

export interface RecordingRecord {
  id: string;
  sessionId: string | null;
  noteId: string | null;
  title: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  mimeType: string;
  byteLength: number;
  transcript: AudioTranscriptRecord | null;
}

/** Bytes live in their own store, keyed by recording id (same reasoning as pageRenders, D7). */
export interface RecordingAudioRecord {
  data: ArrayBuffer;
  type: string;
}

export type CalendarEventKind = 'deadline' | 'event';
export type CalendarEventSource = 'manual' | 'syllabus';

export interface CalendarEventRecord {
  id: string;
  title: string;
  kind: CalendarEventKind;
  /** Epoch ms. For a deadline this is the due moment unless allDay. */
  startsAt: number;
  endsAt: number | null;
  /** All-day items are due at the end of their local day (23:59:59.999). */
  allDay: boolean;
  /** Defaults copied onto the generated task. */
  required: boolean;
  estimatedMinutes: number;
  notes: string;
  source: CalendarEventSource;
  /** Phase 2 syllabus import: stable reference to the source item, for idempotent re-import. */
  sourceRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus = 'open' | 'done' | 'dismissed';
export type TaskSource = 'manual' | 'calendar' | 'scratchpad';

export interface TaskRecord {
  id: string;
  title: string;
  required: boolean;
  estimatedMinutes: number;
  dueAt: number | null;
  status: TaskStatus;
  source: TaskSource;
  /** Set when source === 'calendar'. */
  eventId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}
```

The scratchpad is a single setting (`triage.scratchpad`, a string), not a
store.

### 2.3 IndexedDB schema (DB `takingnotes`, version 2; §6.2 raises it to 3)

The v1 upgrade block is frozen. v2 adds, inside `if (oldVersion < 2)`:

| Store | keyPath | Indexes |
|-------|---------|---------|
| `notes` (existing) | `id` | + `by-session` → `sessionId` |
| `sessions` | `id` | `by-started` → `startedAt` |
| `recordings` | `id` | `by-session` → `sessionId`, `by-started` → `startedAt` |
| `recordingAudio` | out-of-line (recording id) | — |
| `events` | `id` | `by-start` → `startsAt` |
| `tasks` | `id` | `by-status` → `status`, `by-event` → `eventId` |

No data migration is needed: new optional fields are read as their documented
defaults when absent.

### 2.4 Repositories (`src/storage/`)

Phase 0 ships CRUD for the new stores so no feature edits another's storage
code. Same style as `notes.ts`/`pages.ts` (async functions over
`openNotesDb()`, `updateX(id, patch)` as a single-transaction read-modify-write).

- `sessions.ts`: `createSession`, `getSession`, `updateSession`, `listSessions`
  (newest first, like `listNotes`).
- `recordings.ts`: `createRecording(input, audio: Blob)` (record + bytes in one
  transaction; `byteLength` and `mimeType` are derived from the Blob),
  `getRecording`, `updateRecording`, `listRecordings` (newest first),
  `listRecordingsBySession` (oldest first),
  `getRecordingAudio(id): Promise<Blob | null>`,
  `setRecordingTranscript(id, transcript)`, `deleteRecording` (record + bytes).
- `events.ts`: `createEvent`, `getEvent`, `updateEvent`, `deleteEvent`,
  `listEvents` (earliest first), `listEventsBetween(fromMs, toMs)` (both bounds
  inclusive).
- `tasks.ts`: `createTask`, `getTask`, `updateTask`, `deleteTask`, `listTasks`
  (unordered - the priority score is computed at render time),
  `listTasksByStatus(status)`, `getTasksByEvent(eventId)` (every status, so the
  sync never re-creates a done or dismissed task).
- `pages.ts` gains `setPageStrokes(id, strokes)` (replaces strokes, recomputes
  `pointCount`; idempotent), `finalizePage(id, at)` and `isPageFinalized(page)`.
- `notes.ts` gains `listNotesBySession(sessionId)` (oldest first).

Conventions the Phase 0 code settled, which features rely on:

- `updateEvent` and `updateTask` set `updatedAt` themselves (a caller may still
  pin it in the patch); `completedAt` stays the triage layer's decision.
- `finalizePage` leaves an already-finalized page untouched, so startup
  recovery cannot re-date a page that was closed properly. `isPageFinalized` is
  the single reading of the absent-means-finalized default.
- `createPage` takes an optional `finalizedAt` (the legacy migration stamps
  imported ROM pages as finalized); `createNote` takes an optional `sessionId`.
- An `eventId`/`sessionId` of `null` is absent from its index, which is what
  keeps manual tasks and session-less notes out of those lookups.

### 2.5 Settings keys (`settings` store)

| Key | Type | Default | Owner |
|-----|------|---------|-------|
| `ollama.baseUrl` | string | `http://localhost:11434` | F1 |
| `ollama.model` | string | `gemma4:12b` | F1 |
| `transcription.renderLongEdge` | number | `1024` (min 768) | F1 |
| `whisper.model` | string | `Xenova/whisper-base.en` | F2 |
| `triage.lookaheadDays` | number | `7` | F3 |
| `triage.scratchpad` | string | `''` | F3 |

Defaults live in `src/storage/settingKeys.ts` (Phase 0) as one exported
const object, so there is a single source. It exports the `SettingValues`
interface (key → type), `SettingKey`, `SETTING_DEFAULTS`,
`MIN_RENDER_LONG_EDGE` and the typed accessors `getSettingValue(key)` /
`setSettingValue(key, value)` over the untyped `settings` repository. A stored
value whose type does not match the default reads as absent, and
`transcription.renderLongEdge` is raised to its floor on read, whatever wrote
it.

## 3. Module contracts

### 3.1 Capture engine — `src/capture/types.ts` (interface: Phase 0; implementation: F1)

```ts
export interface CaptureState {
  activeSessionId: string | null;
  activeNoteId: string | null;
  activePageId: string | null;
  /** Zero-based index of the active page within the active note; -1 when none. */
  pageIndex: number;
}

export type NewPageReason = 'device-turn' | 'manual';

export interface CaptureEngine {
  getState(): CaptureState;
  subscribe(fn: (s: CaptureState) => void): () => void;

  /** Creates Session + Note + first Page and makes them active. Ends any active note first. */
  startNote(opts?: { title?: string }): Promise<string>;
  /** Finalizes the active page, marks the note complete and the session ended. No-op when idle. */
  endNote(): Promise<void>;
  /**
   * Finalizes the active page and makes a new one the active page.
   * No active note → no-op, resolves null.
   */
  newPage(reason: NewPageReason): Promise<string | null>;

  /** Strokes of the active page, including the stroke in progress. For live ink rendering. */
  getLiveStrokes(): readonly PageStroke[];
  /** Fires whenever live strokes change. Consumers throttle (e.g. requestAnimationFrame). */
  subscribeInk(fn: () => void): () => void;
  /** Fires once per page after it is finalized and persisted. F1's transcription queue listens here. */
  subscribePageFinalized(fn: (pageId: string) => void): () => void;

  dispose(): void;
}
```

Behavioral rules every implementation must keep:

- Pen input with no active note calls `startNote()` first. Writing is never
  dropped.
- Strokes persist incrementally: on pen-up and on a periodic flush (≤ 2 s)
  via `setPageStrokes`. A crash loses at most the stroke in progress.
- Points carry `t` (epoch ms at receipt); strokes carry `startedAt`/`endedAt`.
- `newPage` and `endNote` are serialized; concurrent calls queue, never
  interleave.
- On startup, notes left `active` are marked `interrupted`, their sessions
  `ended`, and unfinalized pages finalized (which queues them for
  transcription).

`src/capture/CaptureContext.tsx` (Phase 0): `CaptureProvider({ engine,
children })`, `useCaptureEngine(): CaptureEngine`, `useCaptureState():
CaptureState`.

`src/capture/engine.ts` exports `createCaptureEngine(deps: { controller:
DeviceController }): CaptureEngine`. Phase 0 ships an in-memory placeholder
that satisfies the interface; F1 replaces the implementation behind the same
signature (it may add optional deps).

### 3.2 Handwriting transcription — `src/transcription/` (F1)

```ts
export interface PageTranscriber {
  transcribePage(image: Blob, opts: { model: string; signal?: AbortSignal }):
    Promise<{ markdown: string; model: string; promptVersion: string }>;
}
```

- The Ollama implementation calls `POST {baseUrl}/api/generate` with
  `stream: false`, `think: false`, `options.num_predict` capped, and a per-page
  timeout. It rejects degenerate output. Prompts come from a registry keyed by
  model family.
- A serial queue listens to `subscribePageFinalized`, rasterizes the page
  (`setPageRender`), transcribes, and writes `setPageTranscript`. It resumes
  pending and running pages on startup.

### 3.3 Audio — `src/audio/` (F2)

```ts
export interface AudioTranscriber {
  /** 16 kHz mono PCM. */
  transcribe(pcm: Float32Array, opts: { model: string; onProgress?: (p: number) => void; signal?: AbortSignal }):
    Promise<{ text: string; segments: TranscriptSegment[]; language: string | null }>;
}
```

- The Whisper implementation runs transformers.js inside a Web Worker. A
  recorder wraps MediaRecorder. A queue transcribes saved recordings and
  resumes after reload.
- At record start, the recording reads `useCaptureState()` to fill `sessionId`
  and `noteId`.

### 3.4 Triage — `src/triage/` (F3)

- `priority.ts`: `priorityScore(task: Pick<TaskRecord,'required'|'estimatedMinutes'|'dueAt'>, now: number): number`
  implements the formula in `docs/spec.md` exactly.
- `generateTasks.ts`: pure `planTaskSync(events, tasks, now, lookaheadDays): { create: NewTask[]; update: {id, patch}[]; dismiss: string[] }`
  plus a thin `syncTasksFromCalendar(now)` that applies the plan through the
  repositories.
- `dueAt(event)`: `allDay ? endOfLocalDay(startsAt) : startsAt`.

### 3.5 Page turns — `src/capture/` (F4)

- `usePageTurnCapture()`: a hook mounted once in `AppShell`. While the pad is
  connected it keeps the controller's capture running (`startCapture` /
  `stopCapture`: page-turn polling, liveness, reconnect). It forwards every
  `controller.subscribePageTurn` event to `engine.newPage('device-turn')`.
- `PageTurnControls`: the on-screen "New page" button (`newPage('manual')`)
  plus a transient "Page N" indicator. It is mounted in the NotesView page
  toolbar.

## 4. File ownership (for parallel work)

| Path | Owner |
|------|-------|
| `src/storage/**`, `src/capture/types.ts`, `src/capture/CaptureContext.tsx`, `src/app/**`, `src/main.tsx` | Phase 0 (features may add new files but do not edit these, except as noted) |
| `src/capture/engine.ts` and new capture internals (`segmenter.ts`, …), `src/transcription/**`, `src/notes/**`, deletion of studio code | F1 |
| `src/audio/**`, `src/recordings/**` | F2 |
| `src/triage/**` | F3 |
| `src/capture/usePageTurnCapture.ts`, `src/capture/PageTurnControls.tsx` | F4 |
| `src/utils/huion*`, `src/device/**`, `src/probe/**` | Existing; not edited in Phase 1 |

Phase 0 creates a placeholder component for each mount point:
`src/notes/NotesView.tsx`, `src/recordings/RecordingsView.tsx`,
`src/audio/RecorderControl.tsx`, `src/triage/TriageView.tsx`,
`src/capture/PageTurnControls.tsx`, `src/capture/usePageTurnCapture.ts`,
`src/notes/TranscriptionSettings.tsx`, `src/audio/AudioSettings.tsx`. Each
feature replaces its own placeholders' bodies and keeps their export names.
`NotesView` must keep rendering `<PageTurnControls />` in its page toolbar.

## 5. Testing conventions

- Vitest + happy-dom + `fake-indexeddb` (already configured). Tests sit beside
  sources as `*.test.ts(x)`.
- Hardware, network, audio and ML sit behind the interfaces above, so tests
  use fakes: `src/test/fakeHuionTransport.ts`, a fake `DeviceController`
  (Phase 0 adds `src/test/fakeDeviceController.ts`), a mocked `fetch` for
  Ollama, and fake `AudioTranscriber` / MediaRecorder.
- There is no `@testing-library/react`. Component tests render with
  `createRoot` from `react-dom/client` inside `act` from `react`, after setting
  `globalThis.IS_REACT_ACT_ENVIRONMENT = true`, and assert on
  `container.textContent` / `querySelector`. See
  `src/app/DeviceStatus.test.tsx`.
- happy-dom has no real canvas; rasterization is tested at the geometry level
  (scaling, aspect ratio, stroke widths) against a recorded 2D-context mock.

---

## 6. Phase 2 additions

Product decisions are in `docs/spec-phase2.md`. Sections 1–5 above still
describe the app; this section adds what Phase 2 introduces. Same rules apply:
the code wins where it disagrees, and this file gets updated to match.

### 6.1 Data model additions

```ts
export type GapStatus = 'proposed' | 'accepted' | 'rejected';

export type GapKind =
  | 'claim' | 'definition' | 'name-or-date' | 'example' | 'argument-step' | 'other';

export interface GapSuggestionRecord {
  id: string;
  noteId: string;
  pageId: string;
  /** Recording the speech came from. */
  recordingId: string;
  /** Absolute epoch ms window of speech compared for this page. */
  fromMs: number;
  toMs: number;
  /** The missing point, as the model stated it. */
  text: string;
  kind: GapKind;
  /** Verbatim speech supporting it, so a claim can be checked against the audio. */
  sourceQuote: string;
  status: GapStatus;
  model: string;
  promptVersion: string;
  /** True when the speech was summarized into bullets before comparison (J5), so the UI can say the source was lossy. */
  summarized: boolean;
  createdAt: number;
  updatedAt: number;
}

export type GapAnalysisStatus = 'pending' | 'running' | 'done' | 'failed';

/** Per-page record of the last gap analysis. Added to PageRecord as an optional field. */
export interface GapAnalysisMeta {
  status: GapAnalysisStatus;
  at: number;
  model: string;
  promptVersion: string;
  error: string | null;
  summarized: boolean;
}

export interface PageRecord {
  // ...all existing fields unchanged...
  /** Absent means never analyzed. */
  gapAnalysis?: GapAnalysisMeta | null;
}
```

### 6.2 IndexedDB schema (version 3)

The v1 and v2 upgrade blocks are frozen. v3 adds, inside `if (oldVersion < 3)`:

| Store | keyPath | Indexes |
|-------|---------|---------|
| `gaps` | `id` | `by-note` → `noteId`, `by-page` → `pageId` |

No data migration: `gapAnalysis` absent means never analyzed.

### 6.3 Repositories

`src/storage/gaps.ts`, in the established style: `createGap`, `getGap`,
`updateGap(id, patch)`, `listGapsByNote(noteId)`, `listGapsByPage(pageId)`,
`deleteGapsByPage(pageId, status?)` (a re-run deletes only `proposed`),
`createGaps(records)` (one transaction for a batch). `pages.ts` gains
`setPageGapAnalysis(id, meta)`.

As shipped:

```ts
export interface CreateGapInput {           // every GapSuggestionRecord field except id,
  /* …noteId, pageId, recordingId, fromMs, toMs, text, kind, sourceQuote, model, promptVersion… */
  status?: GapStatus;                       // defaults to 'proposed'
  summarized?: boolean;                     // defaults to false
  createdAt?: number;                       // both default to now
  updatedAt?: number;
}

createGap(input: CreateGapInput): Promise<GapSuggestionRecord>
createGaps(inputs: CreateGapInput[]): Promise<GapSuggestionRecord[]>   // [] for an empty batch
getGap(id): Promise<GapSuggestionRecord | undefined>
updateGap(id, patch): Promise<GapSuggestionRecord>                     // bumps updatedAt itself
listGapsByNote(noteId) / listGapsByPage(pageId): Promise<GapSuggestionRecord[]>
deleteGapsByPage(pageId, status?): Promise<number>                     // how many went
setPageGapAnalysis(id, meta: GapAnalysisMeta | null): Promise<PageRecord>
```

Conventions, matching §2.4: `updateGap` maintains `updatedAt` (a caller may pin
it in the patch), listings are oldest first with `id` breaking a `createdAt` tie
(a batch shares one timestamp and index order is by random key), and
`deleteGapsByPage` walks the `by-page` index with a cursor so the read and the
deletes share one transaction.

### 6.4 Shared Ollama text client — `src/llm/`

Phase 1's `src/transcription/ollama.ts` speaks to Ollama for vision. P1 and P2
need text generation with the same guards, so the low-level request, error
naming and degenerate-output detection move to `src/llm/ollamaClient.ts` and
transcription imports them. Transcription's public API
(`createOllamaTranscriber`, `listOllamaModels`, `PageTranscriber`) must not
change, and its tests must keep passing unmodified.

```ts
export interface TextGenerator {
  /** One completion. Applies think:false, a num_predict cap, a timeout and degenerate-output rejection. */
  generate(prompt: string, opts: {
    model: string;
    system?: string;
    numPredict?: number;
    signal?: AbortSignal;
  }): Promise<string>;
  /** As generate, but parses JSON, with one repair attempt before failing. */
  generateJson<T>(prompt: string, opts: {
    model: string;
    system?: string;
    numPredict?: number;
    signal?: AbortSignal;
    validate: (value: unknown) => T;
  }): Promise<T>;
}

export function createOllamaTextGenerator(opts: {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): TextGenerator;
```

`validate` is mandatory: a model's JSON is untrusted input, so every caller
states the shape it expects and bad rows are dropped or the call fails, rather
than being cast.

As shipped, in two files:

- `src/llm/ollamaClient.ts` - `createOllamaClient({ baseUrl, fetchImpl?,
  timeoutMs?, label? })` returning `{ baseUrl, generate(request, signal?),
  throwIfAborted(signal) }`, plus `FetchLike`, `DEFAULT_TIMEOUT_MS`,
  `DegenerateOutputError`, `isDegenerateOutput`, `stripCodeFence` and
  `listOllamaModels`. `generate` adds `stream: false` and `think: false` (with
  the one retry without `think` for models that reject it) and throws
  `Ollama <status>: <error>`. `label` names the operation in the timeout and
  abort messages the user reads, which is how transcription still says
  "Transcription timed out after 180s" while text calls say "Generation".
- `src/llm/ollamaText.ts` - `createOllamaTextGenerator`, `TextGenerator` and
  `DEFAULT_TEXT_NUM_PREDICT` (2000). Before spending a call on a repair,
  `generateJson` retries the parse on the outermost `[…]`/`{…}` slice, which
  costs nothing and handles a model that wrapped its JSON in prose. A `validate`
  failure is **not** repaired: the JSON parsed, so the shape was wrong rather
  than the syntax, and the caller's own `validate` already decided whether to
  drop bad rows or throw.

`src/transcription/ollama.ts` keeps every export it had, re-exporting the four
that moved, so `createOllamaTranscriber`, `listOllamaModels`, `FetchLike`,
`DEFAULT_TIMEOUT_MS`, `DEFAULT_NUM_PREDICT`, `DegenerateOutputError` and
`isDegenerateOutput` all still come from there.

### 6.5 Module contracts

**P1 gap filling — `src/gaps/`**

```ts
/** Pure: which speech belongs to a page. */
export function speechWindowForPage(page: PageRecord, opts?: { leadMs?: number; trailMs?: number }):
  { fromMs: number; toMs: number } | null;

/** Pure: segments overlapping a window, in order, as absolute-time text. */
export function segmentsInWindow(recording: RecordingRecord, fromMs: number, toMs: number): TranscriptSegment[];

/** Pure: split speech text for summarization when it exceeds the budget. */
export function chunkSpeech(text: string, opts?: { budget?: number; overlap?: number }): string[];

export interface GapAnalyzer {
  /** Analyzes one page. Replaces its `proposed` suggestions; keeps accepted and rejected ones. */
  analyzePage(pageId: string, opts?: { signal?: AbortSignal }): Promise<GapSuggestionRecord[]>;
  /** Analyzes every eligible page of a note, serially. */
  analyzeNote(noteId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}
```

Constants with defaults: `GAP_LEAD_MS` 60_000, `GAP_TRAIL_MS` 30_000,
`GAP_DIRECT_CHAR_BUDGET` 6000, `GAP_CHUNK_CHARS` 3000, `GAP_CHUNK_OVERLAP` 300.
Prompts live in a registry with versions, as in Phase 1 (D8a).

**P2 syllabus import — `src/syllabus/`**

```ts
export interface ExtractedAssignment {
  title: string;
  /** Epoch ms, or null when the text gave no resolvable date. */
  dueAt: number | null;
  /** What the model read, kept for the review table when dueAt is null. */
  rawDate: string;
  estimatedMinutes: number | null;
  notes: string;
}

/** Pure: text of a PDF, page by page. Pages with no usable text layer come back empty. */
export function extractPdfText(data: ArrayBuffer): Promise<string[]>;

/** Pure: resolve a date string against a term start. */
export function resolveDueDate(raw: string, termStart: number, now: number): number | null;

export interface SyllabusExtractor {
  fromText(text: string, opts: { model: string; signal?: AbortSignal }): Promise<ExtractedAssignment[]>;
  fromPdf(data: ArrayBuffer, opts: { model: string; signal?: AbortSignal }): Promise<ExtractedAssignment[]>;
}

/** Pure: stable sourceRef for idempotent re-import. */
export function sourceRefFor(importKey: string, a: ExtractedAssignment): string;

/** Writes confirmed rows as `kind: 'deadline'`, `source: 'syllabus'` events; updates on matching sourceRef. */
export function importAssignments(rows: ConfirmedAssignment[], importKey: string): Promise<{ created: number; updated: number }>;
```

`pdfjs-dist` and its wiring ship with the foundations, in
`src/syllabus/pdfjs.ts`: `loadPdfjs()` (dynamic import, cached, with
`GlobalWorkerOptions.workerSrc` already pointed at the locally emitted worker),
`PDF_WORKER_URL`, and `pdfSupportProbe()`, a trivial open-one-page check.
`extractPdfText` builds on `loadPdfjs()` and must not import `pdfjs-dist`
statically - that would move ~1 MB into the entry chunk - nor set `workerSrc`
itself. The worker is emitted by Vite from a `?url` import and resolved against
`import.meta.url`, so it is always same-origin (A29) and no `vite.config.ts`
change is needed.

**P3 sessions — `src/capture/`**

`CaptureEngine` gains two methods; everything else keeps its current
behaviour:

```ts
  /** Creates a Session, opens a Note in it, and reports the ids. Ends any active note first. */
  startSession(opts?: { title?: string }): Promise<{ sessionId: string; noteId: string }>;
  /** Finalizes the page, completes the note, ends the session. No-op when idle. */
  endSession(): Promise<void>;
```

`startNote()` keeps working for bare notes (and for pen-input auto-start).
A session's audio is started by the UI, not the engine: the engine must not
depend on the recorder, so `SessionControls` calls
`engine.startSession()` then the recorder, and reports an audio failure
without unwinding the session.

Both methods are on the interface, and `src/capture/engine.ts` carries the thin
delegation that satisfies it: `startSession` opens a note (Phase 1's `startNote`
already creates exactly one session per note) and reports both ids;
`endSession` closes the note, which already ends its session. Correct for
today's shape and no behaviour change - P3 replaces it with the real flow, and
`src/capture/pageTurnTestEngine.ts` (the F4 stub) implements both too.

### 6.6 Settings additions

| Key | Type | Default | Owner |
|-----|------|---------|-------|
| `gaps.leadMs` | number | `60000` | P1 |
| `gaps.trailMs` | number | `30000` | P1 |
| `syllabus.termStart` | number \| null | `null` | P2 |

### 6.7 File ownership (Phase 2)

| Path | Owner |
|------|-------|
| `src/storage/**`, `src/llm/**`, `src/capture/types.ts`, placeholders | Phase 2 foundations |
| `src/gaps/**`, `src/notes/GapPanel.tsx` | P1 |
| `src/syllabus/**` except `pdfjs.ts` (foundations) | P2 |
| `src/capture/engine.ts`, `src/capture/SessionControls.tsx` | P3 |
| Everything from Phase 1 not listed | not edited |

Foundations creates placeholders with their final export names:
`src/notes/GapPanel.tsx` (mounted by `NotesView` beside the transcript panel),
`src/capture/SessionControls.tsx` (mounted in the `AppShell` header),
`src/syllabus/SyllabusImport.tsx` (mounted in the Triage view, since it feeds
the calendar). Each feature replaces its own placeholder's body and keeps the
name, so no feature edits another's mount point.

As shipped, each placeholder renders its block under a stable `aria-label` -
`Gaps`, `Session`, `Syllabus` - and the three host tests assert that label, so a
feature that dropped its own mount would be caught. The labels are part of the
contract; keep them.

- `GapPanel({ noteId, pageId }: GapPanelProps)`. `NotesView` passes
  `viewedPage.noteId` and `viewedPage.id` and keys it per page, so the panel
  never shows one page's suggestions against another.
- `SessionControls()` and `SyllabusImport()` take no props; they read the
  capture engine and storage themselves.
- `SyllabusImport`'s placeholder carries one real affordance, a "Check PDF
  support" button that runs `pdfSupportProbe()`. That is what keeps pdf.js
  reachable from the entry, and so genuinely built, before P2 exists; P2 is free
  to drop it once its own PDF path is in.

## 7. Recorded defect (not fixed in Phase 2)

`huionBLE.reconnect()` swallows the error when a reconnect succeeds but
restoring the pen stream fails. The pad then reports connected while sending no
pen input, and nothing retries; page turns still create empty pages. Found by
F4, out of scope for Phase 1 and 2, recorded here so it is not rediscovered.

## 8. Phase 3 foundations

Product decisions are in `docs/spec-phase3.md`. This section is the contract
Wave 2's five units (S1 sessions, S4 typed pages, S5 tags, and the others)
build against, written after six foundations tasks landed on `phase3`. Same
rules as always: the code wins where this disagrees, and this file gets
updated to match.

### 8.1 IndexedDB schema (version 4)

The v1–v3 upgrade blocks are frozen. v4 adds, inside `if (oldVersion < 4)`
(`src/storage/db.ts`):

| Store | keyPath | Indexes |
|-------|---------|---------|
| `recordingChunks` | `id` | `by-recording` → `recordingId` |

No data migration: every v4 field is optional with a documented
absent-reading, so existing rows are already valid v4 rows.

`recordingChunks` holds transient per-`MediaRecorder`-chunk audio for a
recording in progress (K4–K6): one row per chunk, written as it arrives so an
interruption costs at most one timeslice of audio. `stop()` stitches a
recording's chunks into `recordingAudio` and deletes them, so a row surviving
a reload means a recording that was interrupted - exactly what startup
recovery looks for. The id is `<recordingId>:<seq>` (not random), so a retried
write of the same chunk overwrites itself instead of duplicating audio into
the stitched file.

`stitchRecordingChunks` reads `by-recording` (keyed on `recordingId` alone)
and sorts the result by `seq` in memory, since the index cannot order by
`seq` for it. This is a **deliberate accepted cost**, not an oversight: at the
default 1-second timeslice, a 90-minute lecture is on the order of 5,400 chunk
rows, which sorts in memory without being noticeable, and the sort is correct
and mutation-tested. A compound `['recordingId', 'seq']` index was considered
for this wave and rejected - an unused index is cruft, and the v1–v4 upgrade
blocks are frozen besides. A later phase can add one in a v5 block if
streaming audio ever makes the in-memory sort a real cost.

```ts
export interface RecordingChunkRecord {
  id: string;
  recordingId: string;
  /** Monotonic per recording, starting at 0. Stitch order (K6). */
  seq: number;
  data: ArrayBuffer;
  /** The `MediaRecorder` MIME type, carried so stitching needs no second read. */
  type: string;
}
```

Four new optional fields land on existing records (`src/storage/types.ts`),
each with a documented absent-reading so no v4 field needed a data migration:

```ts
export interface NoteRecord {
  // ...all existing fields unchanged...
  /** Free-form tags, normalized on write (K3). Absent on pre-v4 rows = []. */
  tags?: string[];
  /** See `TitleSource`. Absent reads as `'default'`. */
  titleSource?: TitleSource;
  /** Identifies the prompt that produced `summary`. Absent reads as `null`. */
  summaryPromptVersion?: string | null;
}

export interface PageRecord {
  // ...all existing fields unchanged...
  /**
   * The typed content of a `source: 'typed'` page (K32). Absent on ink pages.
   * Mirrored into `transcript` (K33), so search and gap analysis read it
   * through the one field they already know about.
   */
  text?: string;
}
```

`TitleSource` (`src/storage/types.ts`) is `'default' | 'auto' | 'manual'`:
absent on v1–v3 rows, which reads as `'default'` - the `Note <timestamp>`
placeholder `openNote()` (in `src/capture/engine.ts`) writes when
`startNote`/`startSession` is given no explicit title - so every pre-Phase-3
note is eligible for auto-naming. That same eligibility is what
the summary backfill (smart search) needs. `PageSource` gains a third
member: `'rom' | 'live' | 'typed'`.

### 8.2 Repository functions owning the new fields

A Wave 2 unit reads or writes a new field only through the function below; it
must not invent its own writer, since several of these do more than a plain
`put` (normalization, provenance, or a second mirrored field).

**`src/storage/notes.ts`** - tags and title provenance:

- `normalizeTags(input: readonly string[]): string[]` - trims, lowercases,
  deduplicates, drops blanks; preserves first-seen order (K3).
- `tagsOf(note: NoteRecord): string[]` - the absent-reading, `note.tags ?? []`.
- `titleSourceOf(note: NoteRecord): TitleSource` - the absent-reading,
  `note.titleSource ?? 'default'`.
- `setNoteTags(id: string, tags: readonly string[]): Promise<NoteRecord>` -
  normalizes, then `updateNote(id, { tags: normalizeTags(tags) })`. This is
  S5's one writer for tags.
- `renameNote(id: string, title: string): Promise<NoteRecord>` - a manual
  rename; trims, rejects a blank title, and sets `titleSource: 'manual'`,
  which permanently opts the note out of auto-titling. The only path that
  writes a title by hand.
- `setNoteSummary(id: string, input: NoteSummaryInput): Promise<NoteRecord>` -
  `NoteSummaryInput` is `{ summary, model, promptVersion, title? }`. The
  summary always lands; `title` lands (with `titleSource: 'auto'`) only when
  `titleSourceOf(existing) !== 'manual'` - read, decide and write inside one
  transaction, so a concurrent `renameNote` can't be overwritten by a stale
  decision. A blank generated title is treated as a failed generation, never
  as an instruction to clear the title.
- `listTagVocabulary(): Promise<string[]>` - every distinct tag across all
  notes, sorted, derived by scanning rather than cached.

**`src/storage/pages.ts`** - typed pages and open-page timing:

- `isTypedPage(page: PageRecord): boolean` - `page.source === 'typed'`.
- `createTypedPage(input: CreateTypedPageInput): Promise<PageRecord>` -
  `CreateTypedPageInput` is `{ noteId, pageIndex, text?, capturedAt? }`; `text`
  defaults to `''`. Creates a page with `source: 'typed'`, no strokes, no
  device page number, then calls `setPageText` to fill it. This is S4's one
  creator for a typed page.
- `setPageText(id: string, text: string): Promise<PageRecord>` - writes
  `page.text` and mirrors it into `page.transcript` (K33): non-blank text
  becomes a `'done'` transcript with `model: TYPED_MODEL` (`'typed'`) and
  `promptVersion: TYPED_PROMPT_VERSION` (`'typed/1'`); blank text leaves
  `transcript: null` rather than writing a contentless `'done'` transcript, so
  an empty typed page doesn't show up in smart search or get offered to gap
  analysis. Throws if the page is not a typed page.
- `pageEndedAt(page: PageRecord): number` - when a page last received
  writing: the latest stroke `endedAt`, falling back to `capturedAt` for a
  page whose strokes carry no timestamps (ROM, legacy, or typed). Shared by
  startup recovery and `resumeNote` (§8.3): both finalize an interrupted
  page at the time writing stopped, not at the time the app noticed - true of
  both call sites as of this wave; `engine.recover()` previously finalized
  with `now()`, which (now that incremental audio survives a crash, Wave 1
  task 4) stretched that page's gap-analysis speech window
  (`speechWindowForPage`, `src/gaps/window.ts`) across however long the note
  sat interrupted before the next launch.

`finalizePage(id, at)` and `isPageFinalized(page)` are unchanged from Phase 1
(§2.4) and are what `resumeNote` calls to close a page it finds open.

**`src/storage/recordingChunks.ts`** and **`src/storage/recordings.ts`** -
chunks and unfinished-recording lookup:

- `appendRecordingChunk(recordingId: string, seq: number, blob: Blob): Promise<void>` -
  writes one chunk row (`<recordingId>:<seq>`).
- `listRecordingChunks(recordingId: string): Promise<RecordingChunkRecord[]>` -
  `seq`-ordered (not index order: the primary key sorts lexicographically, so
  "rec:10" would otherwise land before "rec:2" past nine chunks).
- `stitchRecordingChunks(recordingId: string): Promise<Blob | null>` -
  concatenates a recording's chunks in `seq` order; `null` when there are
  none. A hole in the sequence (a failed write) is concatenated across rather
  than treated as an error.
- `deleteRecordingChunks(recordingId: string): Promise<void>`.
- `listUnfinishedRecordings(): Promise<RecordingRecord[]>` (in
  `recordings.ts`) - every recording with `endedAt === null`, newest first.
  K5: a recording row is created at record-start, before any chunk exists, so
  recovery can find it this way and already knows its session/note link,
  title and start time.
- `listFinishedRecordings(): Promise<RecordingRecord[]>` (in
  `recordings.ts`) - the exact complement: every recording with
  `endedAt !== null`, newest first. **`listRecordings()`'s meaning changed
  under K5**: a `RecordingRecord` now exists from the moment recording
  starts, so `listRecordings()` includes rows that are not finished work.
  Anything that treats a row as finished - transcription (the resume queue),
  playback lists (`RecordingsView`), gap-analysis recording selection
  (`recordingForNote`) - must call `listFinishedRecordings()`, not
  `listRecordings()`, or it will try to use a recording that is still being
  written. Startup ordering is load-bearing here: recovery (K7, owned by the
  audio runtime) must stitch and patch `endedAt` on every unfinished
  recording *before* the transcription queue's own startup resume runs, or
  the queue will see `endedAt === null` rows and skip them as still-open
  rather than as recordings recovery already finished.
- `finalizeRecording(id, audio, patch): Promise<RecordingRecord>` (in
  `recordings.ts`) - K6's `stop()` in one atomic write: puts the stitched
  `audio` into `recordingAudio`, patches the row (`endedAt`, `durationMs`,
  `byteLength` derived from the blob, `mimeType` when given), and deletes
  that recording's chunk rows, all inside one transaction over
  `['recordings', 'recordingAudio', 'recordingChunks']`. **This is the one
  correct way to close a recording** - doing the three writes as separate
  transactions reopens the exact gap this function exists to close (next
  bullet), so S3 must call this rather than composing
  `stitchRecordingChunks` / `updateRecording` / `deleteRecordingChunks`
  itself.
- **Invariant: a recording with `endedAt === null` and no chunks may only be
  deleted when its `recordingAudio` row is absent or zero-length.** The
  alternative - a row with no chunks, `endedAt === null`, and a non-trivial
  `recordingAudio` row - means its finalisation was interrupted between the
  audio write and the `endedAt` patch; that recording's audio is complete and
  durable, and deleting the row on the strength of "no chunks, not ended"
  would discard a finished lecture. `finalizeRecording`'s single transaction
  is what makes this invariant holdable in practice: there is no window
  where the audio is written but `endedAt` isn't, because both are the same
  transaction. Recovery (K7) must itself patch `endedAt` after stitching -
  if it stitches into `recordingAudio` and deletes the chunks but leaves
  `endedAt: null`, the *next* launch finds zero chunks and an unfinished row
  and, by K7's own "no chunks at all is deleted" rule, deletes a recording
  recovery just finished saving.
- `deleteRecording(id)` was extended to also delete any chunks left over for
  that recording (a recording deleted while still open would otherwise leave
  orphaned chunk rows, since nothing else scans for them).

**Known limitation, with a named next step: K8's decode proof covers the
bytes, not the browser.** S3's mandatory test
(`src/audio/incrementalRecovery.decode.test.ts`) proves that a stitched,
truncated recording (crashed before `stop()` ever ran, so the container was
never finalised) is a structurally valid, decodable Opus/WebM stream: it
parses as well-formed Matroska up to the truncation point, and the system's
`ffmpeg` - substituted at `decodeToPcm16k`'s injectable `decode` seam
(`src/audio/pcm.ts:66`), because `happy-dom` provides no real
`AudioContext` for this test suite to call the genuine article - decodes it
to real, non-silent PCM. **What this does not prove is that the browser's
own `AudioContext.decodeAudioData` accepts the same bytes.** `ffmpeg` is
known to be tolerant of damaged/streamed containers; a browser's decoder
may be stricter. If it turns out to reject a truncated recording that
`ffmpeg` accepts, the contingency is a remux step before decode (anticipated
by K8 and deliberately not built, since no failing test has asked for it) -
and either way the raw bytes are preserved and recoverable in
`recordingAudio`, so the owner is strictly better off than before S3 (where
an interruption lost the whole recording outright). The one manual check
that would close this residual risk: interrupt a real recording on real
hardware, reopen the app, and confirm the recovered recording both plays
and transcribes.

### 8.3 `resumeNote`'s contract

Declared on `CaptureEngine` in `src/capture/types.ts`:

```ts
/**
 * Reopens an existing note and appends a new page after its last one (K10,
 * K11). One mechanism serves both restarting an interrupted session and
 * returning to a finished note. Ends any other open note first. Appending
 * only: no existing page is modified and none is re-finalized.
 */
resumeNote(noteId: string): Promise<{ sessionId: string; noteId: string }>;
```

Implemented in `src/capture/engine.ts`. Behavioral rules Wave 2 relies on:

- **Reopens, never forks.** It is not a call into `startNote`/`openNote`:
  no new Note or Session row is created when the note already has a usable
  one. It calls `getNote(noteId)` and operates on the same note row.
- **Appends after the last page; never touches an existing one.** It reads
  `listPages(noteId)` (`pageIndex`-sorted) and creates exactly one new page
  whose `pageIndex` is `pages[pages.length - 1].pageIndex + 1` (`0` for an
  empty note). No existing page's strokes, `transcript`, or `finalizedAt` are
  rewritten.
- **The note keeps its original `startedAt`.** Only `status` (back to
  `'active'`) and `endedAt` (back to `null`) move on the note row; `startedAt`
  is never part of the patch.
- **`sessionStartedAt` is reset to `now()`.** The published `CaptureState`'s
  `sessionStartedAt` (read via `sessionStartedAtOf(state)`) is set to the
  resume's own timestamp, not the note's or session's original start, so the
  header clock measures the current sitting - a note resumed three days later
  must not show a 72-hour timer.
- **A missing or dangling session is created and linked.** `note.sessionId`
  may be `null` (legacy/imported note) or may name a session row that no
  longer exists (`getSession` returns nothing). Either way `resumeNote`
  creates a new `SessionRecord` (`title: note.title`, `startedAt:
  note.startedAt`) and links it onto the note via `updateNote`'s `sessionId`
  patch - every note is resumable (K14), not just ones with a live session. A
  session that does still exist is reactivated in place
  (`updateSession(sessionId, { status: 'active', endedAt: null })`) rather
  than replaced.
- **An open page is finalized at `pageEndedAt(page)`, not `now()`.** Before
  appending, any page the note left unfinalized (an interrupted capture) is
  closed with `finalizePage(page.id, pageEndedAt(page))` - the time writing
  actually stopped, so the page's gap-analysis speech window isn't stretched
  across the days-long gap until the resume.
- **Two concurrent resumes of the same note share one promise.** A
  synchronous `pendingResume: { noteId, result } | null` marker is set before
  the async op is enqueued and cleared only when it is still the newest
  pending resume. A second `resumeNote(noteId)` call for the *same* note,
  arriving before the first call's enqueued op has published state, returns
  `pendingResume.result` directly rather than falling through to close the
  page the first call is in the middle of opening. (A call for the same note
  while it is already the open, active note - and a session exists - is a
  separate, cheaper early-return: it resolves immediately with the current
  state and never touches storage at all.)
- **Resuming a *different* note before the first resume's op has run still
  leaves a stray empty page.** The `pendingResume` guard only covers a second
  call for the *same* `noteId`; a call for a different note falls through to
  `closeNote()` against whatever note/page was open before the first resume's
  op has had a chance to publish its own state. This is why the UI must
  disable **Resume and Start session** while a call is in flight - S1's own
  responsibility, not the engine's. Start session is not an obviously
  related control, but it shares the same gap: during the window before a
  resume's op publishes state, `sessionStartedAtOf(state)` is still `null`
  (the resume hasn't set it yet), so the session lock reads as off and Start
  session is clickable; clicking it there falls through to `closeNote()`
  against the half-opened resume for exactly the same reason and produces
  the same stray-empty-page outcome this bullet already documents for a
  second Resume click.

### 8.4 Wave 2 mount points

`NotesView` was split in Task 6 into `src/notes/NoteList.tsx` and
`src/notes/NoteToolbar.tsx`, each exposing slots as `ReactNode` (or
`ReactNode`-returning) props. **A Wave 2 unit adds to a slot it owns; it does
not edit `NoteList.tsx`, `NoteToolbar.tsx`, or `NotesView.tsx` itself.** Two
units touching the same file is exactly what parallel worktrees can't resolve
without a merge conflict at best and a silently dropped mount at worst.

| Mount point | Owner |
|---|---|
| `NoteList.filter` | S5 tags |
| `NoteList.rowActions` | S1 sessions (Resume) |
| `NoteToolbar.title` | S1 sessions (inline title) |
| `NoteToolbar.meta` | S5 tags (tag editor) |
| `NoteToolbar.actions` | S4 typed pages ("Type page") |
| `NoteToolbar.banner` | S1 sessions (writing-destination notice) |

Signatures, from the components as shipped:

```ts
// src/notes/NoteList.tsx
export interface NoteListProps {
  notes: readonly NoteRecord[];
  selectedNoteId: string | null;
  activeNoteId: string | null;
  onSelect: (id: string) => void;
  /** Rendered above the list. */
  filter?: ReactNode;
  /** Trailing controls for one row. */
  rowActions?: (note: NoteRecord) => ReactNode;
}

// src/notes/NoteToolbar.tsx
export interface NoteToolbarProps {
  noteTitle: string | null;
  /** Replaces the plain title. */
  title?: ReactNode;
  /** Rendered under the title. */
  meta?: ReactNode;
  /** Rendered before page navigation. */
  actions?: ReactNode;
  /** A full-width row below the toolbar. */
  banner?: ReactNode;
  sessionLocked: boolean;
  hasActiveNote: boolean;
  onNewNote: () => void;
  onEndNote: () => void;
  pageCount: number;
  viewedIndex: number;
  onGoToPage: (index: number) => void;
}
```

`filter` renders above the note list; `rowActions` is called per note and
rendered at the bottom of that note's list item. `title` replaces the plain
`noteTitle ?? 'No note selected'` span when given; `meta` renders directly
under the title/title-slot; `actions` renders in the button row, before page
navigation and before F4's `<PageTurnControls />` (which must stay mounted -
it is F4's only mount point, §4); `banner` renders as a full-width row below
the whole toolbar row.

`NoteToolbarProps.sessionLocked` already exists for S1: when `true`, "New
note" is disabled (K15 - a session locks you into its note) while "End note"
deliberately stays enabled, since ending must never be reachable only by
reload.

One line for S5: `NoteList`'s "No notes yet - write on the pad to start one"
empty state is not S5's to change. A tag filter that matches nothing still
renders an empty list, which would otherwise read to the user as "you have no
notes" rather than "no notes match this filter" - that distinction belongs in
the `filter` slot S5 already owns (e.g. "3 notes hidden by this filter"), not
in a rewrite of `NoteList`'s own empty-state copy.
