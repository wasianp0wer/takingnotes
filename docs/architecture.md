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

### 2.3 IndexedDB schema (DB `takingnotes`, version 2)

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
| `src/syllabus/**` | P2 |
| `src/capture/engine.ts`, `src/capture/SessionControls.tsx` | P3 |
| Everything from Phase 1 not listed | not edited |

Foundations creates placeholders with their final export names:
`src/notes/GapPanel.tsx` (mounted by `NotesView` beside the transcript panel),
`src/capture/SessionControls.tsx` (mounted in the `AppShell` header),
`src/syllabus/SyllabusImport.tsx` (mounted in the Triage view, since it feeds
the calendar). Each feature replaces its own placeholder's body and keeps the
name, so no feature edits another's mount point.

## 7. Recorded defect (not fixed in Phase 2)

`huionBLE.reconnect()` swallows the error when a reconnect succeeds but
restoring the pen stream fails. The pad then reports connected while sending no
pen input, and nothing retries; page turns still create empty pages. Found by
F4, out of scope for Phase 1 and 2, recorded here so it is not rediscovered.
