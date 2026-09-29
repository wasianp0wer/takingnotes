# F1 — Drawing removal + handwriting transcription (feature spec)

Product source: `docs/spec.md` §F1 (plus D8, D9, findings F1–F4). Contracts:
`docs/architecture.md` §3.1 (capture engine) and §3.2 (transcription). This
document pins down the details those leave open and lists the tests F1 ships.

## 1. Drawing removal

- Delete the studio: `src/App.tsx`, every `src/components/*.tsx` outside
  `components/ui/`, `src/hooks/useAnimationRecorder.ts`, `src/hooks/useHistory.ts`,
  `src/utils/helpers.ts`, `src/utils/imageFilters.ts`, drawing-only types in
  `src/types/index.ts`, and anything reachable only from those. Every deletion
  is checked with `grep` for importers first.
- Keep: `components/ui/*`, `lib/utils.ts`, pen-input drivers (`huion*`,
  `wacomBLE.ts`, `tabletUSB.ts`, `packetHeuristics.ts`), `src/types/memory.ts`,
  the `.d.ts` files, and any type that a kept file (drivers, `storage/migrate.ts`,
  probe) imports.
- `npm uninstall` deps used only by deleted code: `@dnd-kit/core`,
  `@dnd-kit/sortable`, `@dnd-kit/utilities`, `react-colorful`, `@ffmpeg/ffmpeg`,
  `@ffmpeg/util`, plus any other dependency with no remaining importer (checked by
  grep, e.g. `@radix-ui/react-popover`).
- `package.json` description → a note-taking app. `vite.config.ts`
  `manualChunks` drops removed packages (no `vendor-dnd`, no `react-colorful`).

## 2. Capture engine (`src/capture/`)

### 2.1 Stroke segmenter — `src/capture/segmenter.ts` (pure)

`createStrokeSegmenter(opts?: { maxGapMs?: number })` consumes
`HuionPenPoint`s plus a receipt time `t` and builds `PageStroke`s.

- A point is **down** when `status > 0 && pressure > 0` (the driver already
  zeroes pressure below its threshold and reports `status 0` for up/hover).
- Down with no open stroke → opens a stroke (`startedAt = t`). Down with an
  open stroke → appends. Each stored point is `{ x, y, pressure, t }`.
- Up with an open stroke → closes it (`endedAt` = `t` of its last point) and
  returns it. Up with no open stroke (hover) → ignored.
- **Gap split**: a down point arriving more than `maxGapMs` (default 500 ms)
  after the previous point of the open stroke closes that stroke and opens a
  new one — a lost pen-up packet must not join two strokes with a straight line.
- `current()` returns the open stroke (or `null`); `end()` force-closes it and
  returns it (used when a page turn / note end arrives mid-stroke).
- `push` returns `{ closed: PageStroke | null; changed: boolean }`: `closed`
  is a stroke that just ended (up or gap), `changed` is true when the live ink
  changed (a point was added or a stroke closed).

### 2.2 Engine — `src/capture/engine.ts`

`createCaptureEngine(deps: CaptureEngineDeps): LiveCaptureEngine` where

```ts
interface CaptureEngineDeps {
  controller: DeviceController;
  now?: () => number;          // default Date.now
  flushIntervalMs?: number;    // default 1000 (≤ 2 s rule)
  maxGapMs?: number;           // passed to the segmenter
}
interface LiveCaptureEngine extends CaptureEngine {
  /**
   * Attaches to the pen stream, starts the flush timer and runs startup
   * recovery; idempotent; resolves when recovery is done. Every public method
   * except getState/dispose calls it first.
   */
  start(): Promise<void>;
  /** Persists the active page's strokes now (tests, and pagehide). */
  flush(): Promise<void>;
}
```

Model: the engine keeps an in-memory **buffer** for the page being written:
`{ pageId: string | null; strokes: PageStroke[] }` plus the segmenter's open
stroke. `pageId` is null until the page record exists (the auto-start window).

- **Pen input** (via `controller.subscribePen`): every point goes to the
  segmenter with `t = now()`. If a down point arrives and no note is open (and
  none is being opened), the engine calls `startNote()`; points keep
  accumulating in the buffer meanwhile and are written once the page exists.
  Writing is never dropped. `subscribeInk` fires on every `changed`.
- **Persistence**: all storage writes run on one serial op chain. A closed
  stroke (pen-up) schedules a flush. A timer every `flushIntervalMs` flushes
  when the buffer is dirty. A flush calls `setPageStrokes(pageId, [...closed,
  open?])` — it includes a snapshot of the open stroke, so a crash loses at most
  the last ≤ 1 s of it. A failed write is logged and retried on the next flush.
- **startNote(opts)**: synchronously closes the current note if one is open
  (same as `endNote`), marks a note as opening, then on the op chain: waits for
  recovery, creates Session (`title`), Note (`sessionId`, `deviceId =
  deviceName || 'huion'`, `deviceType 'huion'`, `deviceName || null`,
  `pageBaseline = storedPageCount`, `pageWidth/Height` = Huion A5 constants
  1409×1869), and Page 0 (`source 'live'`, `devicePageNum`), assigns the buffer
  its `pageId`, publishes state, flushes any buffered strokes. Default title:
  `Note <local date time>`. Resolves the note id.
- **newPage(reason)**: synchronously — if no note is open or opening, resolves
  `null` (A7). Otherwise force-ends the open stroke onto the *old* buffer, swaps
  in a fresh buffer (pen points arriving from now on go to the new page), then
  on the op chain: persists the old buffer, `finalizePage(old, now)`, creates
  the next page (`pageIndex + 1`), publishes state, flushes the new buffer,
  emits `pageFinalized(old)`. Resolves the new page id.
- **endNote()**: synchronously — no note open/opening → no-op. Otherwise ends
  the open stroke onto the old buffer, swaps in a fresh buffer, marks no note
  open, then on the chain: persist, finalize, note `complete` + `endedAt`,
  session `ended` + `endedAt`, state → idle, emit `pageFinalized`.
- **devicePageNum** (best effort): when the controller reports `isConnected`,
  `storedPageCount + 1` for the first page and for `'device-turn'` pages (the
  count has already advanced when the turn fires); `null` for `'manual'` pages
  and when disconnected.
- **Recovery** (runs first on the chain, from `start()`, which resolves after):
  every non-legacy note with status `active` → `interrupted` with `endedAt` =
  latest stroke `endedAt` / page `capturedAt` (fallback now); its session →
  `ended`; each of its pages with `finalizedAt === null` → `finalizePage` and
  `pageFinalized` emitted. Any other session left `active` → `ended`.
- **dispose()**: unsubscribes the pen, stops the timer, stops emitting.

## 3. Transcription (`src/transcription/`)

- `types.ts`: `PageTranscriber` exactly as architecture §3.2, and
  `TranscriptionResult = { markdown; model; promptVersion }`.
- `prompts.ts`: `getPromptFor(model): { family; promptVersion; prompt }`.
  Family is matched from the model name (tag and namespace stripped, e.g.
  `gemma4:12b` → `gemma`, `qwen2.5vl:7b` → `qwen-vl`, `llava:13b` → `llava`);
  unknown → `generic`. `promptVersion` is `<family>-v1`. Every prompt asks for
  Markdown only, `[illegible]` for unreadable words, preserved structure, no
  commentary.
- `ollama.ts`:
  - `createOllamaTranscriber({ baseUrl, fetch?, timeoutMs = 180_000, numPredict = 2000 })`.
    `POST {baseUrl}/api/generate` with `{ model, prompt, images: [base64],
    stream: false, think: false, options: { num_predict, temperature: 0 } }`.
    Trailing slashes on `baseUrl` are tolerated.
  - **Think fallback**: if the response is an HTTP error whose message mentions
    `think` (models that do not support the field), retry once without `think`.
  - **Timeout**: an `AbortController` aborts after `timeoutMs`; the caller's
    `signal` also aborts. A timeout rejects with `Transcription timed out after Ns`.
  - **Degenerate output** (`isDegenerateOutput(text, doneReason)`): rejected
    with `DegenerateOutputError` when (a) ≥ 20 non-empty lines with unique-line
    ratio < 0.3, or (b) `done_reason === 'length'` and ≥ 4 lines with unique
    ratio < 0.5, or (c) ≥ 200 whitespace tokens with unique-token ratio < 0.1.
    A real degenerate run always hits the `num_predict` cap, so (b) is the
    primary guard; (a) and (c) are loose on purpose so that a legitimately
    repetitive page (a checklist of identical `- [ ]` lines, a table with
    repeating rows) is not thrown away.
  - Output cleanup: trims, and strips a single wrapping ```` ```markdown ```` fence.
  - HTTP errors reject with Ollama's `error` text when present.
  - `listOllamaModels(baseUrl, fetch?)`: `GET /api/tags` → sorted `name`s.
- `rasterize.ts`:
  - `rasterGeometry(pageWidth, pageHeight, longEdge)` → `{ width, height }`,
    long edge = `longEdge`, aspect from page dims (null dims → A5 constants).
  - `strokeWidth(pressure, longEdge)` = `longEdge * (0.0012 + 0.0028 * p)`,
    pressure clamped 0–1 (≈1.2–4.1 px at 1024).
  - `drawStrokes(ctx, strokes, { width, height })`: white fill, black round
    lines, one segment per point pair using the pair's pressure; a
    single-point stroke is a filled dot. Shared by the notes view.
  - `renderPage(strokes, dims, longEdge, createCanvas?)` → `{ blob (PNG), width, height }`
    using `OffscreenCanvas` or a DOM canvas.
- `queue.ts`: `createTranscriptionQueue(deps)` — deps: `engine`
  (`subscribePageFinalized`), `getSettings()` (baseUrl, model,
  renderLongEdge), `createTranscriber(baseUrl)`, `render(strokes, note, longEdge)`,
  `now?`.
  - `start()`: subscribes to `pageFinalized` **then** scans storage and
    enqueues pages whose transcript is `pending`/`running`, or live finalized
    pages with no transcript (a crash between finalize and enqueue). Legacy/ROM
    pages without transcript are not auto-queued (retry is the manual path).
  - `enqueue(pageId)`: writes `pending` immediately (so a reload resumes it),
    dedupes, processes serially.
  - Job: page with zero points → `done`, empty markdown, no model call. Else
    render → `setPageRender` → `running` → `transcribePage` → `done` (model,
    promptVersion from the result) or `failed` (error message). One failure never
    stops the queue.
  - `retry(pageId)` re-enqueues a `failed` (or any) page. `subscribe(fn)`
    notifies `pageId` on every status change (the UI refreshes from it).
    `stop()` unsubscribes.
- `startTranscription.ts`: `ensureTranscriptionQueue(engine)` — a
  module-level singleton that builds the real queue (settings via
  `getSettingValue`, Ollama transcriber, canvas renderer) and starts it once.
  `NotesView` calls it from `useTranscriptionQueue()`; the Notes tab is the
  default tab, so the queue starts at app load, and it is never stopped when the
  tab unmounts. No Phase 0 file changes.

## 4. Notes UI (`src/notes/`)

- `NotesView` (keeps the export name): left column — note list (all notes from
  `listNotes`, newest first, legacy ones labelled, the active one marked);
  right — a toolbar (note title, **New note** / **End note**, page navigation
  `‹ Page i / n ›`, and `<PageTurnControls />`), then the page (ink) beside a
  transcript panel.
- Selection: follows the active note whenever capture starts one; otherwise the
  clicked note. Viewing the active page draws live strokes (`getLiveStrokes` +
  `subscribeInk`, throttled with `requestAnimationFrame`); any other page draws
  its stored strokes. Page navigation jumps to the active page when a new one is
  created.
- `InkCanvas`: a canvas sized to the page aspect using `drawStrokes`.
- Transcript panel: status (Waiting / Transcribing / Done / Failed + error),
  the markdown as pre-wrapped text, and **Retry** (failed pages, and
  "Transcribe" for finalized pages without transcript, e.g. legacy). The active,
  unfinalized page shows "Transcribed when the page is finished".
- `TranscriptionSettings`: Ollama URL input, model `<select>` of installed
  models (from `listOllamaModels`, with a refresh button and an error line when
  Ollama is unreachable; the saved model stays selectable even if not listed),
  render long edge number input (min 768, saved clamped). Saves on change/blur.

## 5. Tests

Core logic (unit):

- `segmenter.test.ts`: down/append/up builds one stroke with `t`,
  `startedAt`/`endedAt`; hover-only points produce nothing; up with no stroke
  ignored; `status>0` with `pressure 0` counts as up; gap > `maxGapMs` splits;
  `end()` closes mid-stroke and returns null when idle; `changed` flags.
- `engine.test.ts` (replaces the placeholder tests, fake controller + fake
  IndexedDB + fake timers where needed):
  - starts idle; `startNote` creates Session + Note (sessionId, device fields,
    A5 dims) + Page 0 and publishes state;
  - pen input with no note auto-starts one and the triggering stroke lands on
    page 0 (no points dropped during the async start);
  - pen-up persists strokes via `setPageStrokes`; periodic flush persists an
    in-progress stroke within `flushIntervalMs`; points carry `t`;
  - `newPage` finalizes the old page, creates page 1, emits `pageFinalized`
    once; resolves `null` with no note; mid-stroke turn ends the stroke on the
    old page and later points go to the new page;
  - `devicePageNum` from `storedPageCount` for first/device-turn pages, null for
    manual or disconnected;
  - concurrent `newPage`/`newPage`/`endNote` calls serialize (page indices 1,2,
    then note complete, no interleaving);
  - `endNote` completes note + ends session + idles state; no-op when idle;
    `startNote` over an active note ends it first;
  - recovery: a stored `active` note becomes `interrupted`, session `ended`,
    open pages finalized and announced; complete notes untouched;
  - live strokes/`subscribeInk` reflect the stroke in progress; `dispose` stops
    listening.
- `prompts.test.ts`: family matching (gemma3/gemma4 tags, qwen-vl, llava,
  namespaced names), generic fallback, promptVersion shape, prompt mentions
  `[illegible]` and Markdown.
- `ollama.test.ts` (mocked fetch): request shape (`think:false`, `stream:false`,
  `num_predict`, base64 image, URL join); success returns markdown/model/
  promptVersion; fence stripping; think-rejection fallback retries once without
  `think`; non-think HTTP error rejects with Ollama's message; timeout aborts;
  external signal aborts; degenerate output rejected (line repetition,
  length+repetition, token repetition) while normal output with `length` passes;
  `listOllamaModels` parses and sorts, rejects on HTTP error.
- `rasterize.test.ts` (recorded 2D-context mock): geometry for portrait/landscape
  and null dims; long edge honoured; stroke width scales with pressure and long
  edge; white background fill; points scaled to pixel space; single-point dot.
- `queue.test.ts` (fake transcriber, fake render, fake IndexedDB): finalized
  page goes pending→running→done with render stored; failure → failed with
  error and the next page still runs; jobs run serially; empty page → done
  empty without calling the model; resume on start picks up pending/running and
  unqueued live finalized pages but not legacy pages; retry reruns a failed
  page; duplicate enqueue runs once; subscribers are notified.

UI (component tests, `createRoot` + `act`):

- `NotesView.test.tsx`: renders `PageTurnControls` ("New page"); lists stored
  notes including a legacy note; New note calls `startNote`; shows a page's
  transcript text and status; Retry on a failed page re-queues it.
- `TranscriptionSettings.test.tsx`: lists installed models from a mocked
  `/api/tags`; shows an error when Ollama is unreachable; saves model and
  clamps render size to ≥ 768.

## Assumptions

- F1-A1 The segmenter splits a stroke when consecutive down points are more
  than 500 ms apart (lost pen-up over BLE). A false split costs one short gap;
  a false join draws a straight line across the page.
- F1-A2 `devicePageNum = storedPageCount + 1` while connected, for the first
  page and device-turn pages; `null` for manual pages and while disconnected.
  The pad's page numbering relation is inferred, not confirmed on hardware.
- F1-A3 `deviceId` is the device name reported by the controller, or `'huion'`
  when unknown (the live stream carries no serial number). Page dims default
  to the Huion A5 logical page (1409×1869); A4 is not detected from the live
  stream here.
- F1-A4 Transcripts are shown as pre-wrapped plain text; no Markdown renderer
  dependency is added.
- F1-A5 Legacy (ROM) pages are not transcribed automatically; the page view
  offers "Transcribe" for them.
- F1-A6 Periodic flushes include a snapshot of the stroke in progress, so a
  crash loses at most ~1 s of ink rather than the whole stroke.
- F1-A7 The transcription queue is a module-level singleton started by the
  Notes view on first mount (the default tab), so no Phase 0 file changes.
  It survives tab switches.
- F1-A8 A think-field rejection is detected by an HTTP error whose message
  contains "think"; the retry omits the field for that request only.
- F1-A10 ⚑ The engine has no side effects at construction; it attaches to the
  pen stream (and runs recovery) on first use (`start()`, called by every
  public method except `getState`/`dispose`). `main.tsx` builds the engine in a
  `useState` initializer, which StrictMode runs twice in development; an eager
  engine would leave the discarded twin subscribed and auto-starting duplicate
  notes. In the app, `useSyncExternalStore`'s `subscribe` attaches the kept
  engine on first render.
- F1-A9 The render is PNG; the per-page timeout is 180 s; `num_predict` 2000.
