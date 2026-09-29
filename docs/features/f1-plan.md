# F1 — Drawing removal + handwriting transcription: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the drawing studio and turn the live pen stream into persisted, page-by-page notes that are rasterized and transcribed locally through Ollama, with a Notes view and transcription settings.

**Architecture:** A pure stroke segmenter feeds a capture engine that owns the active Session/Note/Page and persists strokes through the Phase 0 repositories on one serialized op chain. A transcription queue listens for finalized pages, rasterizes them, calls an Ollama `PageTranscriber`, and stores render + transcript. React components in `src/notes/` are thin views over the engine, the queue and storage.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Vitest 3 + happy-dom + fake-indexeddb, `idb`, Tailwind + local shadcn-style `components/ui`.

**Spec:** `docs/features/f1-spec.md` (feature spec, binding), `docs/architecture.md` §3.1/§3.2/§4/§5 (contracts), `docs/spec.md` §F1.

## Global Constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/f1-transcription` (branch `notes/f1-transcription`). Never push, never bare `git stash`.
- Do not edit Phase 0 files: `src/storage/**`, `src/capture/types.ts`, `src/capture/CaptureContext.tsx`, `src/app/**`, `src/main.tsx`. Do not edit `src/device/**`, `src/utils/huion*`, `src/probe/**`, `src/capture/PageTurnControls.tsx`, `src/capture/usePageTurnCapture.ts`.
- `createCaptureEngine(deps)` keeps its name and module; extra deps are optional.
- All timestamps are epoch ms (`Date.now()` clock).
- Ollama: `stream: false`, `think: false`, `options.num_predict` 2000, per-page timeout 180 000 ms, degenerate-repetition rejection.
- Render long edge from setting `transcription.renderLongEdge` (default 1024, floor 768 — `MIN_RENDER_LONG_EDGE`); default model `gemma4:12b`; default base URL `http://localhost:11434`.
- Every transcript stores `model` and `promptVersion`. Status flow pending → running → done/failed.
- `NotesView` must keep rendering `<PageTurnControls />` in its page toolbar; keep export names `NotesView`, `TranscriptionSettings`.
- Tests: Vitest beside sources (`*.test.ts(x)`); component tests use `createRoot` + `act` with `globalThis.IS_REACT_ACT_ENVIRONMENT = true` (pattern: `src/app/DeviceStatus.test.tsx`); no `@testing-library`. Storage tests call `resetDatabase()` from `src/test/resetDb.ts` in `beforeEach`.
- TDD: failing test first, then code. Commit per task; every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Path alias `@/` → `src/`. Code style: 2-space indent, single quotes, semicolons (match `src/capture/*`).
- Commands: `npx vitest run <paths>`, `npm run build`, `npx eslint <paths>`.

## Review Focus

1. **A page turn arriving mid-stroke** (F4 calls `newPage('device-turn')` while the pen is down): the stroke must end on the old page and later points go to the new page — pinned in Task 3 tests.
2. **Pen input during the async auto-start window** (first stroke of a note, IndexedDB still creating records): no point may be dropped — pinned in Task 3.
3. **Ollama unreachable / model missing / model rejects `think`**: the page goes `failed` with a readable message, the queue continues, settings show an error instead of an empty spinner — pinned in Tasks 4, 6, 7.
4. **Reload mid-transcription** (page left `running`/`pending`, or finalized by recovery with no transcript): resumes on start — pinned in Task 6.
5. **Legacy notes with `pageWidth/pageHeight` null and no `t` on points**: list, view and render them without crashing — pinned in Tasks 5 and 8.

---

### Task 1: Remove the drawing studio and its dependencies

**Files:**
- Delete: `src/App.tsx`, `src/components/*.tsx` (NOT `src/components/ui/**`), `src/hooks/useAnimationRecorder.ts`, `src/hooks/useHistory.ts`, `src/utils/helpers.ts`, `src/utils/imageFilters.ts`, and any other file that becomes unreferenced and is drawing-only.
- Modify: `src/types/index.ts` (drop drawing-only types; keep anything imported by kept files), `package.json` (description; deps), `package-lock.json` (via npm), `vite.config.ts` (`manualChunks`).

**Interfaces:** Produces nothing new. Must keep `src/utils/huion*`, `src/utils/wacomBLE.ts`, `src/utils/tabletUSB.ts`, `src/utils/packetHeuristics.ts`, `src/utils/pacedTransport.ts`, `src/types/memory.ts`, `src/types/*.d.ts`, `src/lib/utils.ts`, `src/components/ui/**`.

- [ ] **Step 1: Map importers.** For every candidate file run e.g. `grep -rn "components/CanvasEngine\|/App'" src --include='*.ts' --include='*.tsx'` and confirm every importer is itself being deleted. Also check `index.html`, `probe.html`, `vite.config.ts`, `scripts/` for references to `src/App.tsx`. Record the list in the report.
- [ ] **Step 2: Delete the files** (`git rm`). For `src/types/index.ts`: remove only exports no remaining file imports (grep each exported name across `src/`); delete the file if nothing remains.
- [ ] **Step 3: Dependencies.** For each of `@dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities react-colorful @ffmpeg/ffmpeg @ffmpeg/util`, and then every other `dependencies` entry, grep `src/` (and config files) for an importer. `npm uninstall` those with none. Keep anything used by `components/ui/**`, `lib/`, `index.css`/tailwind config.
- [ ] **Step 4: package.json description** → `"Local-first handwritten note-taking for the Huion X10: live ink capture, on-device transcription, audio notes and triage."`
- [ ] **Step 5: vite.config.ts** — remove the `vendor-dnd` chunk; remove from `vendor-ui` any package that is no longer installed (e.g. `react-colorful`). Leave everything else unchanged.
- [ ] **Step 6: Verify.** `npx tsc -b --noEmit` (or `npm run build`) succeeds; `npx vitest run` all pass (baseline 241 tests, 26 files); `npx eslint vite.config.ts src/types` clean.
- [ ] **Step 7: Commit** `chore: remove the drawing studio and its dependencies` (+ Co-Authored-By line).

### Task 2: Stroke segmenter

**Files:**
- Create: `src/capture/segmenter.ts`, `src/capture/segmenter.test.ts`

**Interfaces:**
- Consumes: `HuionPenPoint` from `@/utils/huionBLE` (`{ x, y, pressure, status, timestamp }`, status 0 = up), `PageStroke` from `@/storage/types`.
- Produces:
```ts
export interface SegmentResult { closed: PageStroke | null; changed: boolean }
export interface StrokeSegmenter {
  push(point: HuionPenPoint, t: number): SegmentResult;
  current(): PageStroke | null;   // open stroke (live reference is fine; callers copy)
  end(): PageStroke | null;       // force-close; null when idle
}
export const DEFAULT_MAX_GAP_MS = 500;
export function createStrokeSegmenter(opts?: { maxGapMs?: number }): StrokeSegmenter;
```

Rules (spec §2.1): down = `status > 0 && pressure > 0`. Down + no open stroke → open `{ points: [p], startedAt: t, endedAt: t }` (`changed: true`). Down + open → if `t - lastPoint.t > maxGapMs` close the open one (returned as `closed`) and open a new stroke with this point; else append and set `endedAt = t`. Up + open → close, return it as `closed`, `changed: true`. Up + idle → `{ closed: null, changed: false }`. Stored point is `{ x, y, pressure, t }` (drop `status`/`timestamp`).

- [ ] **Step 1: Write failing tests** covering: (a) three down points then up → one closed stroke with 3 points, each with `t`, `startedAt` = first t, `endedAt` = last t; (b) hover points only → never `changed`, `current()` null; (c) `status 1, pressure 0` is treated as up; (d) gap: down at t=0, t=10, then t=700 → second push returns `closed` with 2 points and `current()` has 1 point; custom `maxGapMs: 50` respected; (e) `end()` mid-stroke returns the stroke and `current()` becomes null; `end()` when idle returns null; (f) up after `end()` is ignored.

```ts
import { describe, expect, it } from 'vitest';
import { createStrokeSegmenter } from '@/capture/segmenter';
import type { HuionPenPoint } from '@/utils/huionBLE';

const down = (x: number, y: number, pressure = 0.5): HuionPenPoint =>
  ({ x, y, pressure, status: 1, timestamp: 0 });
const up = (): HuionPenPoint => ({ x: 0, y: 0, pressure: 0, status: 0, timestamp: 0 });

it('builds one stroke from down points closed by pen-up', () => {
  const seg = createStrokeSegmenter();
  seg.push(down(0.1, 0.1), 1000);
  seg.push(down(0.2, 0.2), 1010);
  seg.push(down(0.3, 0.3), 1020);
  const r = seg.push(up(), 1030);
  expect(r.changed).toBe(true);
  expect(r.closed).toEqual({
    points: [
      { x: 0.1, y: 0.1, pressure: 0.5, t: 1000 },
      { x: 0.2, y: 0.2, pressure: 0.5, t: 1010 },
      { x: 0.3, y: 0.3, pressure: 0.5, t: 1020 },
    ],
    startedAt: 1000,
    endedAt: 1020,
  });
  expect(seg.current()).toBeNull();
});
```
- [ ] **Step 2: Run** `npx vitest run src/capture/segmenter.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/capture/segmenter.ts` per the rules above (~50 lines, no dependencies beyond types).
- [ ] **Step 4: Run** the test file → PASS; `npx eslint src/capture/segmenter.ts src/capture/segmenter.test.ts` clean.
- [ ] **Step 5: Commit** `feat(capture): segment the pen stream into timestamped strokes`.

### Task 3: Capture engine

**Files:**
- Modify (replace body): `src/capture/engine.ts`
- Modify (replace placeholder tests): `src/capture/engine.test.ts`
- Read-only context: `src/capture/types.ts`, `src/storage/{notes,pages,sessions,types}.ts`, `src/device/controller.ts`, `src/device/emitter.ts`, `src/test/fakeDeviceController.ts`, `src/test/resetDb.ts`, `src/capture/CaptureContext.test.tsx` (must keep passing), `docs/features/f1-spec.md` §2.2.

**Interfaces:**
- Consumes: `createStrokeSegmenter`, `DEFAULT_MAX_GAP_MS` from `@/capture/segmenter` (Task 2); `createSession`, `updateSession`, `listSessions`; `createNote`, `updateNote`, `listNotes`; `createPage`, `listPages`, `setPageStrokes`, `finalizePage`; `HUION_DEFAULT_PAGE_WIDTH_A5` (1409) / `HUION_DEFAULT_PAGE_HEIGHT_A5` (1869) from `@/utils/huionProtocol`; `createEmitter` from `@/device/emitter`.
- Produces:
```ts
export interface CaptureEngineDeps {
  controller: DeviceController;
  now?: () => number;          // default Date.now
  flushIntervalMs?: number;    // default 1000
  maxGapMs?: number;           // default DEFAULT_MAX_GAP_MS
}
export interface LiveCaptureEngine extends CaptureEngine {
  /**
   * Attaches to the pen stream, starts the flush timer and runs startup
   * recovery. Idempotent; resolves when recovery has finished. Called
   * implicitly by every public method except getState/dispose.
   */
  start(): Promise<void>;
  flush(): Promise<void>;          // persist the active buffer now; resolves after the write
}
export function createCaptureEngine(deps: CaptureEngineDeps): LiveCaptureEngine;
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;
```

Design (binding detail in spec §2.2):
- **Lazy attach (StrictMode)**: `main.tsx` builds the engine in a `useState` initializer, which React StrictMode invokes twice in development and discards one result. An engine that subscribed to the pen at construction would leave the discarded twin auto-starting duplicate notes. So construction has no side effects; `start()` (idempotent) subscribes to the pen, starts the flush timer and kicks off recovery, and every public method except `getState`/`dispose` calls `start()` first (`subscribe` — which `useSyncExternalStore` calls on the kept engine — therefore attaches it in the app). Document this in the file comment.
- **Serial op chain**: `let chain: Promise<unknown> = recover()` (created in `start()`); `function enqueue<T>(op: () => Promise<T>): Promise<T>` appends `op` after `chain` (continuing even if the previous op rejected), stores the new tail (with rejection swallowed + `console.error`), and returns the op's own promise to the caller. `start()` returns the recovery promise (never rejects; errors logged).
- **Buffers**: `interface Buffer { pageId: string | null; strokes: PageStroke[]; dirty: boolean }`. `let buffer: Buffer` is where pen input goes. The segmenter's open stroke belongs to the current buffer. `noteOpen: boolean` flips synchronously in `startNote`/`endNote` and on auto-start so `newPage`/`endNote` calls made before the async creation finishes still queue behind it rather than resolving `null`.
- **Pen handler** (`controller.subscribePen`): `const r = segmenter.push(p, now())`. If `r.closed` push it onto `buffer.strokes`, mark dirty, and schedule a flush (`void flush()`). If a down point arrived and `!noteOpen` → `void startNote()` (auto-start; the buffer is kept and becomes page 0's buffer). If `r.changed` emit ink.
- **flush()**: captures `const b = buffer` and a snapshot `[...b.strokes, openStrokeCopy?]` (open stroke only if `b === buffer`); if `b.pageId === null` or nothing dirty and no open stroke → resolve. Otherwise enqueue `setPageStrokes(b.pageId, snapshot)`; clear `dirty` only if no new stroke was added meanwhile. Errors: log, keep dirty.
- **Timer**: `setInterval(() => { if (buffer.dirty || segmenter.current()) void flush(); }, flushIntervalMs)` started in `start()`, cleared in `dispose`.
- **closeBuffer()** (sync, used by `newPage`/`endNote`/`startNote`-over-active): `const old = buffer; const s = segmenter.end(); if (s) old.strokes.push(s); buffer = fresh(); emitInk();` returns `old`. Then the enqueued op does `if (old.pageId) { await setPageStrokes(old.pageId, old.strokes); await finalizePage(old.pageId, now()); }` and emits `pageFinalized(old.pageId)` after persistence.
- **newPage(reason)**: `if (!noteOpen) return Promise.resolve(null)`; `const old = closeBuffer(); const fresh = buffer;` enqueue: persist + finalize old; `createPage({ noteId, pageIndex: state.pageIndex + 1, devicePageNum: reason === 'device-turn' ? devicePageNum() : null, source: 'live', strokes: [] })`; `fresh.pageId = page.id`; `setState({...state, activePageId, pageIndex})`; emit `pageFinalized(old)`; if `fresh` is dirty or has strokes → flush. Resolve page id.
- **startNote(opts)**: if `noteOpen` → run the endNote closing path first (both synchronous part and its enqueued op). Then `noteOpen = true`; `const b = buffer;` enqueue: `now()`; `createSession({ title, startedAt })`; `createNote({ title, deviceId: ctrl.deviceName || 'huion', deviceType: 'huion', deviceName: ctrl.deviceName || null, pageBaseline: ctrl.isConnected ? ctrl.storedPageCount : 0, pageWidth: 1409, pageHeight: 1869, sessionId, startedAt })`; `createPage({ noteId, pageIndex: 0, devicePageNum: devicePageNum(), source: 'live', strokes: b.strokes })`; `b.pageId = page.id`; publish state `{ activeSessionId, activeNoteId, activePageId, pageIndex: 0 }`; flush if an open stroke exists. Default title `Note ${new Date(t).toLocaleString()}`. Resolves note id. On failure: `noteOpen = false`, rethrow.
- **endNote()**: `if (!noteOpen) return Promise.resolve()`; `const old = closeBuffer(); noteOpen = false;` enqueue: persist + finalize old; `updateNote(noteId, { status: 'complete', endedAt: t })`; `updateSession(sessionId, { status: 'ended', endedAt: t })`; state → idle; emit `pageFinalized(old.pageId)`. Note/session ids are read inside the op from `state` (state is updated only by ops, so it is consistent there).
- **devicePageNum()**: `const s = controller.getState(); return s.isConnected ? s.storedPageCount + 1 : null;`
- **recover()** (runs first on the chain, from `start()`): `for note of await listNotes()` where `!note.legacy && note.status === 'active'`: pages = `listPages(note.id)`; `endedAt` = max over pages of (max stroke `endedAt`, `capturedAt`) or `now()`; for each page with `finalizedAt === null` → `finalizePage(page.id, now())` and remember id; `updateNote(note.id, { status: 'interrupted', endedAt })`; if `note.sessionId` → `updateSession(sessionId, { status: 'ended', endedAt })`. Then every session from `listSessions()` still `active` → ended (`endedAt: now()`). Emit `pageFinalized` for each finalized page id (skip if disposed). Wrap in try/catch → log.
- **getLiveStrokes()**: returns a cached array `[...buffer.strokes, openStroke?]`, rebuilt only when ink changed (so repeated calls between changes return the same reference).
- **dispose()**: `disposed = true`, unsubscribe pen, `clearInterval`, stop emitting (`if (!disposed)` guards).

- [ ] **Step 1: Write failing tests** in `src/capture/engine.test.ts` (replace the placeholder suite; keep `resetDatabase()` in `beforeEach`, `engine.dispose()` in `afterEach`). Helper:

```ts
function stroke(fake: FakeDeviceController, pts: Array<[number, number]>) {
  for (const [x, y] of pts) fake.emitPen({ x, y, status: 1, pressure: 0.5 });
  fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
}
async function settle(engine: LiveCaptureEngine) { await engine.flush(); }
```

Tests (each a separate `it`; every test calls `await engine.start()` before emitting pen input):
1. starts idle; `start()` resolves; constructing an engine without calling any method does not subscribe to the pen (emit pen → no note is created after a tick) — the StrictMode guard.
2. `startNote({ title: 'Bio' })` → Session (active, title) + Note (`sessionId`, `status 'active'`, `pageWidth 1409`, `pageHeight 1869`, `deviceType 'huion'`, `legacy false`) + Page 0 (`source 'live'`, `finalizedAt null`), state matches, subscribers notified.
3. pen input with no note auto-starts one: emit a 3-point stroke synchronously, `await vi.waitFor(() => expect(engine.getState().activeNoteId).not.toBeNull())`, `await engine.flush()`; page 0 has exactly 1 stroke with 3 points, every point has numeric `t`, stroke has `startedAt`/`endedAt`. Only one note exists.
4. pen-up persists: after a note exists, a stroke + `await engine.flush()` → `getPage(pageId).strokes.length === 1` and `pointCount === 3`.
5. periodic flush: `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })` NOT used with IndexedDB — instead construct with `flushIntervalMs: 20`, emit down points without pen-up, wait with `vi.waitFor(async () => expect((await getPage(id))!.pointCount).toBe(2))`.
6. `now` dep drives `t`: `now: () => 5000` → points have `t: 5000`.
7. `newPage('manual')` → resolves new id; old page `finalizedAt` set; new page `pageIndex 1`, `devicePageNum null`; `pageFinalized` fired exactly once with the old id; state `pageIndex 1`.
8. `newPage` with no note resolves `null` and creates nothing.
9. mid-stroke turn: pen down 2 points, `void engine.newPage('device-turn')`, 2 more down points, pen up, `await engine.flush()` → old page has one stroke of 2 points; new page has one stroke of 2 points.
10. devicePageNum: `fake.setDeviceState({ isConnected: true, storedPageCount: 4 })` → startNote page 0 `devicePageNum 5`, note `pageBaseline 4`; `setDeviceState({ storedPageCount: 5 })` + `newPage('device-turn')` → `6`; disconnected → `null`.
11. serialization: `const [a, b] = await Promise.all([engine.newPage('manual'), engine.newPage('manual'), engine.endNote()])` → pages with indices 0,1,2 exist, all finalized, note `complete`, session `ended`, state idle, `pageFinalized` fired 3 times in page-index order.
12. `endNote` when idle is a no-op (no records); `startNote` over an active note → first note `complete`, its page finalized, second note active.
13. recovery: seed storage directly (`createSession`, `createNote({ status: 'active', sessionId })`, `createPage({ finalizedAt: null, strokes: [...] })`, plus a `complete` note with an open page? no — a complete note with finalized page), create engine, subscribe to `pageFinalized`, `await engine.start()` → active note `interrupted` with `endedAt` set, session `ended`, open page finalized, `pageFinalized` received with that page id; complete note untouched.
14. live ink: during a stroke `getLiveStrokes()` includes the open stroke; `subscribeInk` listener called per point; same reference returned when nothing changed.
15. `dispose()` stops listening: pen input after dispose creates no note.

- [ ] **Step 2: Run** `npx vitest run src/capture/engine.test.ts` → FAIL (placeholder engine persists nothing).
- [ ] **Step 3: Implement** `src/capture/engine.ts` per the design. Keep the file-level doc comment explaining the buffer model and the op chain.
- [ ] **Step 4: Run** `npx vitest run src/capture` and `npx vitest run src/app` → PASS (CaptureContext/AppShell tests still pass). `npx eslint src/capture/engine.ts src/capture/engine.test.ts` clean.
- [ ] **Step 5: Commit** `feat(capture): live capture engine with incremental persistence and recovery`.

### Task 4: Prompt registry and Ollama transcriber

**Files:**
- Create: `src/transcription/types.ts`, `src/transcription/prompts.ts`, `src/transcription/prompts.test.ts`, `src/transcription/ollama.ts`, `src/transcription/ollama.test.ts`

**Interfaces:**
- Produces:
```ts
// types.ts
export interface TranscriptionResult { markdown: string; model: string; promptVersion: string }
export interface PageTranscriber {
  transcribePage(image: Blob, opts: { model: string; signal?: AbortSignal }): Promise<TranscriptionResult>;
}
// prompts.ts
export interface PromptSpec { family: string; promptVersion: string; prompt: string }
export function modelFamily(model: string): string;   // 'gemma' | 'qwen-vl' | 'llava' | 'generic' | ...
export function getPromptFor(model: string): PromptSpec;
// ollama.ts
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface OllamaTranscriberOptions { baseUrl: string; fetch?: FetchLike; timeoutMs?: number; numPredict?: number }
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_NUM_PREDICT = 2000;
export class DegenerateOutputError extends Error {}
export function isDegenerateOutput(text: string, doneReason?: string): boolean;
export function createOllamaTranscriber(opts: OllamaTranscriberOptions): PageTranscriber;
export function listOllamaModels(baseUrl: string, fetchImpl?: FetchLike): Promise<string[]>;
```

Details:
- `modelFamily`: lowercase; strip namespace (`library/`, `user/`), strip tag after `:`; then match: `/^gemma/` → `gemma`; `/^qwen.*vl/` → `qwen-vl`; `/^(llava|bakllava)/` → `llava`; `/^(llama3\.2-vision|llama.*vision)/` → `llama-vision`; `/^minicpm-v/` → `minicpm-v`; else `generic`. `getPromptFor` returns a prompt per family (gemma, qwen-vl, llava, generic; others may reuse generic text but keep their own family), `promptVersion = \`${family}-v1\``. Every prompt: transcribe the handwritten page exactly; output Markdown only (headings, lists, indentation preserved; diagrams as simple ASCII/indentation); write `[illegible]` for unreadable words; no commentary, no preamble, no code fences.
- `transcribePage`: `const { family, promptVersion, prompt } = getPromptFor(model)`; base64 of the blob (`arrayBuffer` → chunked `btoa` over `String.fromCharCode` in 32 KiB chunks); body `{ model, prompt, images: [b64], stream: false, think: false, options: { num_predict: numPredict, temperature: 0 } }`; URL `baseUrl.replace(/\/+$/, '') + '/api/generate'`; POST with `Content-Type: application/json`, `signal` = internal controller linked to `opts.signal` and a `setTimeout(timeoutMs)` (cleared in `finally`). If `!res.ok`: read error text (`JSON.parse(body).error ?? body`); if status is 400/500-ish and `/think/i.test(error)` and `think` was sent → retry once without the `think` key; else throw `new Error(\`Ollama ${res.status}: ${error}\`)`. Timeout → `new Error(\`Transcription timed out after ${timeoutMs / 1000}s\`)`; external abort → rethrow an `AbortError`-named error. On success JSON `{ response, done_reason }`: `markdown = cleanOutput(response)`; if `isDegenerateOutput(markdown, done_reason)` throw `DegenerateOutputError('Degenerate output: the model repeated itself')`; return `{ markdown, model, promptVersion }`.
- `cleanOutput`: trim; if it matches `/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/` return the inner text trimmed.
- `isDegenerateOutput` thresholds (spec §3): lines = non-empty trimmed lines; tokens = whitespace split. (a) `lines.length >= 8 && unique/lines < 0.3`; (b) `doneReason === 'length' && lines.length >= 4 && unique/lines < 0.5`; (c) `tokens.length >= 60 && uniqueTokens/tokens < 0.1`.
- `listOllamaModels`: GET `{base}/api/tags`; non-ok → throw `Ollama ${status}`; returns `models.map(m => m.name).sort()` (empty array when `models` missing).

- [ ] **Step 1: Write failing tests.** `prompts.test.ts`: `modelFamily('gemma4:12b') === 'gemma'`, `'gemma3:4b'` → gemma, `'library/gemma4:latest'` → gemma, `'qwen2.5vl:7b'` → `qwen-vl`, `'llava:13b'` → llava, `'mistral:7b'` → generic; `getPromptFor('gemma4:12b').promptVersion === 'gemma-v1'`; unknown → `generic-v1`; every family's prompt contains `[illegible]` and `Markdown`.
  `ollama.test.ts` with `const fetch = vi.fn<FetchLike>()` returning `new Response(JSON.stringify({ response: '# Title\n- a', done_reason: 'stop' }), { status: 200 })`:
  1. request shape: URL `http://h:1/api/generate` for `baseUrl: 'http://h:1/'`; body has `stream:false`, `think:false`, `options.num_predict === 2000`, `images[0] === btoa('png-bytes')` for `new Blob(['png-bytes'], { type: 'image/png' })`, `model`, and `prompt === getPromptFor(model).prompt`.
  2. returns `{ markdown: '# Title\n- a', model, promptVersion: 'gemma-v1' }`.
  3. strips a ```` ```markdown ```` fence.
  4. think fallback: first response `new Response(JSON.stringify({ error: '"llava" does not support thinking' }), { status: 400 })`, second OK → resolves; second call body has no `think` key; exactly 2 calls.
  5. other HTTP error (`404 {error:'model "x" not found'}`) rejects with message containing `model "x" not found`, 1 call.
  6. timeout: fetch that never resolves until its signal aborts (listen to `init.signal` 'abort' and reject with `DOMException('aborted','AbortError')`), `timeoutMs: 20` → rejects `/timed out/`.
  7. external signal abort → rejects (name `AbortError`).
  8. degenerate: 30 lines of `[illegible]` → rejects `DegenerateOutputError`; `isDegenerateOutput('a\nb\na\nb\na', 'length')` true; normal 5 distinct lines with `'length'` → false; 100 tokens of `[illegible]` on one line → true.
  9. `listOllamaModels` returns sorted names from `{ models: [{ name: 'b' }, { name: 'a' }] }`; rejects on 500.
- [ ] **Step 2: Run** `npx vitest run src/transcription` → FAIL.
- [ ] **Step 3: Implement** the four source files.
- [ ] **Step 4: Run** → PASS; `npx eslint src/transcription` clean.
- [ ] **Step 5: Commit** `feat(transcription): Ollama page transcriber with prompt registry and output guards`.

### Task 5: Page rasterizer

**Files:**
- Create: `src/transcription/rasterize.ts`, `src/transcription/rasterize.test.ts`

**Interfaces:**
- Consumes: `PageStroke` (`@/storage/types`), `HUION_DEFAULT_PAGE_WIDTH_A5`/`HEIGHT_A5` (`@/utils/huionProtocol`).
- Produces:
```ts
export interface PageDims { pageWidth: number | null; pageHeight: number | null }
export interface RasterSize { width: number; height: number }
export type InkContext = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineCap' | 'lineJoin' |
  'fillRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'arc' | 'fill'>;
export function rasterGeometry(dims: PageDims, longEdge: number): RasterSize;
export function strokeWidth(pressure: number, longEdge: number): number;
export function drawStrokes(ctx: InkContext, strokes: readonly PageStroke[], size: RasterSize): void;
export interface RenderedPage { blob: Blob; width: number; height: number }
export type CanvasFactory = (w: number, h: number) => {
  getContext(type: '2d'): InkContext | null;
  toBlob(): Promise<Blob>;
};
export const defaultCanvasFactory: CanvasFactory;   // OffscreenCanvas when available, else document canvas
export function renderPage(strokes: readonly PageStroke[], dims: PageDims, longEdge: number, factory?: CanvasFactory): Promise<RenderedPage>;
```
- `rasterGeometry`: null/≤0 dims → 1409×1869. Portrait (h ≥ w): `height = longEdge`, `width = Math.round(longEdge * w / h)`; landscape mirrored.
- `strokeWidth(p, longEdge) = longEdge * (0.0012 + 0.0028 * clamp(p, 0, 1))`.
- `drawStrokes`: `fillStyle '#ffffff'`, `fillRect(0,0,w,h)`; `strokeStyle`/`fillStyle '#000000'`, `lineCap/lineJoin 'round'`; long edge = `max(w,h)`; for each stroke: 1 point → `beginPath(); arc(x*w, y*h, strokeWidth(p)/2, 0, 2π); fill()`; else for each consecutive pair: `beginPath(); lineWidth = strokeWidth(avg pressure); moveTo; lineTo; stroke()`.
- `renderPage`: size = `rasterGeometry`; canvas from factory; `drawStrokes`; `blob = await canvas.toBlob()` (PNG); default factory: `OffscreenCanvas` → `convertToBlob({ type: 'image/png' })`, else `document.createElement('canvas')` + `toBlob(cb, 'image/png')` (reject when null).

- [ ] **Step 1: Write failing tests** with a recording mock ctx (a plain object whose methods push `[name, ...args]` into `calls` and whose property setters record `['set', prop, value]`):
  1. `rasterGeometry({ pageWidth: 1409, pageHeight: 1869 }, 1024)` → `{ width: 772, height: 1024 }`; landscape `{2000, 1000}` → `{1024, 512}`; null dims → same as A5; long edge 768 honoured.
  2. `strokeWidth(0, 1024) ≈ 1.2288`, `strokeWidth(1, 1024) ≈ 4.096`, monotonic in pressure, doubles with long edge, clamps pressure > 1.
  3. `drawStrokes` first fills white over the whole size; a 3-point stroke at `(0.5,0.5)…` produces 2 `stroke()` calls with `moveTo(386, 512)` for size 772×1024; a single-point stroke produces `arc` + `fill`; empty stroke list only fills background; legacy points without `t` work.
  4. `renderPage` with a fake factory returns `{ blob, width: 772, height: 1024 }` and the blob is what the factory's `toBlob` returned.
- [ ] **Step 2: Run** `npx vitest run src/transcription/rasterize.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; eslint clean.
- [ ] **Step 5: Commit** `feat(transcription): rasterize pages as black ink on white`.

### Task 6: Transcription queue and startup wiring

**Files:**
- Create: `src/transcription/queue.ts`, `src/transcription/queue.test.ts`, `src/transcription/startTranscription.ts`, `src/transcription/startTranscription.test.ts`

**Interfaces:**
- Consumes: Task 4 `PageTranscriber`, `createOllamaTranscriber`, `getPromptFor`; Task 5 `renderPage`, `RenderedPage`, `PageDims`; storage `getPage`, `listPages`, `setPageRender`, `setPageTranscript`, `getNote`, `listNotes`, `isPageFinalized`; `getSettingValue` from `@/storage/settingKeys`; `CaptureEngine` type.
- Produces:
```ts
export interface TranscriptionSettingsSnapshot { baseUrl: string; model: string; renderLongEdge: number }
export interface TranscriptionQueueDeps {
  engine: Pick<CaptureEngine, 'subscribePageFinalized'>;
  getSettings(): Promise<TranscriptionSettingsSnapshot>;
  createTranscriber(baseUrl: string): PageTranscriber;
  render(strokes: readonly PageStroke[], dims: PageDims, longEdge: number): Promise<RenderedPage>;
  now?: () => number;
}
export interface TranscriptionQueue {
  start(): Promise<void>;                 // subscribe, then resume from storage
  enqueue(pageId: string): Promise<void>; // resolves once the pending mark is written
  retry(pageId: string): Promise<void>;
  subscribe(fn: (pageId: string) => void): () => void;
  idle(): Promise<void>;                  // resolves when nothing is queued or running (tests)
  stop(): void;
}
export function createTranscriptionQueue(deps: TranscriptionQueueDeps): TranscriptionQueue;
// startTranscription.ts
export function ensureTranscriptionQueue(engine: CaptureEngine): TranscriptionQueue; // module singleton, started once
export function getTranscriptionQueue(): TranscriptionQueue | null;
export function resetTranscriptionQueueForTests(): void;
```

Behaviour (spec §3 queue):
- `enqueue(id)`: if already queued or running → return. Read settings once for the pending mark: `setPageTranscript(id, { markdown: '', model: settings.model, promptVersion: getPromptFor(settings.model).promptVersion, status: 'pending', error: null, updatedAt: now() })`, notify, push id, kick the worker.
- Worker (one at a time): `page = getPage(id)`, missing → skip. `settings = getSettings()`; `promptVersion = getPromptFor(settings.model).promptVersion`. If `page.pointCount === 0` (or no strokes) → write `done` with empty markdown, notify, next. Else `note = getNote(page.noteId)`; `rendered = render(page.strokes, { pageWidth: note?.pageWidth ?? null, pageHeight: note?.pageHeight ?? null }, settings.renderLongEdge)`; `setPageRender(id, rendered.blob, rendered.width, rendered.height)`; write `running` (keep the model/promptVersion), notify; `result = createTranscriber(settings.baseUrl).transcribePage(rendered.blob, { model: settings.model })`; write `done` with `result.markdown/model/promptVersion`. Any throw → write `failed` with `error: err.message` (model/promptVersion as pending), notify. Continue with the next id.
- `start()`: idempotent. Subscribe `engine.subscribePageFinalized(id => void enqueue(id))` FIRST, then scan: for each note in `listNotes()`, for each page in `listPages(note.id)`: status `pending`/`running` → enqueue; or `source === 'live' && isPageFinalized(page) && page.transcript === null` → enqueue. Legacy/ROM pages without transcript are skipped.
- `retry(id)`: remove from any failed state and `enqueue(id)` (even if `done`).
- `stop()`: unsubscribe; the worker finishes its current job and stops taking new ones.
- `ensureTranscriptionQueue(engine)`: if a singleton exists return it; else build with `getSettings` reading `ollama.baseUrl`, `ollama.model`, `transcription.renderLongEdge` via `getSettingValue`, `createTranscriber: baseUrl => createOllamaTranscriber({ baseUrl })`, `render: (s, d, e) => renderPage(s, d, e)`; call `void queue.start().catch(log)`; store and return.

- [ ] **Step 1: Write failing tests** (`resetDatabase()` in `beforeEach`; fake engine = `{ subscribePageFinalized }` backed by `createEmitter<string>()`; fake transcriber `vi.fn()` resolving `{ markdown: 'text', model: 'm', promptVersion: 'generic-v1' }`; fake render resolving `{ blob: new Blob(['x'], { type: 'image/png' }), width: 772, height: 1024 }`; settings `{ baseUrl: 'http://o', model: 'gemma4:12b', renderLongEdge: 1024 }`; seed notes/pages via `createNote`/`createPage`):
  1. a finalized page emitted by the engine ends `done` with markdown `text`, `model 'm'`, `render` meta `{ type: 'image/png', width: 772, height: 1024 }` stored, and `getPageRender` returns a blob; transcriber got the rendered blob and `{ model: 'gemma4:12b' }`; `render` got `longEdge 1024` and the note's dims.
  2. status sequence observed via `subscribe` + `getPage` reads includes `pending`, `running`, `done` in that order.
  3. transcriber rejecting `new Error('boom')` → page `failed`, `error 'boom'`; a second page enqueued after it still reaches `done`.
  4. serial: with a deferred transcriber, two pages enqueued → the second is not `running` while the first's promise is unresolved; max concurrency 1.
  5. empty page (strokes `[]`) → `done`, markdown `''`, transcriber and render never called.
  6. resume: seed a page with transcript `running`, one `pending`, one live finalized with `transcript: null`, one legacy ROM finalized page with null transcript, one `done`; `start()` + `idle()` → first three `done`, legacy still `null`, `done` page untouched (transcriber called 3 times).
  7. `retry` on a `failed` page re-runs and reaches `done`.
  8. enqueuing the same id twice while pending runs the transcriber once.
  9. `ensureTranscriptionQueue` returns the same instance on repeated calls (use `resetTranscriptionQueueForTests()` in `afterEach`), and `getTranscriptionQueue()` returns it.
- [ ] **Step 2: Run** `npx vitest run src/transcription/queue.test.ts src/transcription/startTranscription.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npx vitest run` full suite PASS; eslint clean.
- [ ] **Step 5: Commit** `feat(transcription): serial, resumable page transcription queue`.

### Task 7: Transcription settings

**Files:**
- Modify (replace body): `src/notes/TranscriptionSettings.tsx`
- Create: `src/notes/TranscriptionSettings.test.tsx`

**Interfaces:**
- Consumes: `getSettingValue`, `setSettingValue`, `MIN_RENDER_LONG_EDGE`, `SETTING_DEFAULTS` (`@/storage/settingKeys`); `listOllamaModels`, `FetchLike` (`@/transcription/ollama`); `Input`, `Label`, `Button` from `@/components/ui/*`.
- Produces: `export function TranscriptionSettings(props?: { fetchImpl?: FetchLike })` — the prop exists for tests; `SettingsDialog` renders it with no props.

Behaviour: on mount load the three settings; then fetch models from the loaded base URL. Render: heading "Handwriting transcription"; "Ollama address" `<input>` (saved on blur, then models refetched); "Model" native `<select>` listing installed models, plus the saved model as an option if not installed (labelled `(not installed)`), saved on change; a "Refresh" button; while loading "Loading models…"; on failure a line "Could not reach Ollama at <url>: <message>" (A13 hint: "Is Ollama running, and does OLLAMA_ORIGINS allow this page?"); "Render size (long edge, px)" number input `min=768 step=64`, saved on blur as `Math.max(MIN_RENDER_LONG_EDGE, Math.round(value))` (NaN → default 1024) and the input shows the clamped value.

- [ ] **Step 1: Write failing tests** (`createRoot` + `act`; `resetDatabase()`; `fetchImpl` = `vi.fn` resolving `/api/tags` → `{ models: [{ name: 'llava:7b' }, { name: 'gemma4:12b' }] }`); use `await act(async () => { ... })` and `vi.waitFor` for async loads:
  1. lists installed models as `<option>`s and selects the saved default `gemma4:12b`.
  2. unreachable (`fetchImpl` rejects `TypeError('Failed to fetch')`) → text contains `Could not reach Ollama`.
  3. changing the select to `llava:7b` → `getSettingValue('ollama.model')` resolves `llava:7b`.
  4. entering `500` into the render input and blurring → stored `768`, input value `768`.
  5. changing the address and blurring stores it and refetches from `<new>/api/tags`.
  (To change a controlled input in happy-dom: set `input.value` via the native setter `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '500')`, then dispatch `new Event('input', { bubbles: true })`, then `input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))` for blur; for select use `HTMLSelectElement.prototype` and `'change'`.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/notes src/app` → PASS; eslint clean.
- [ ] **Step 5: Commit** `feat(notes): transcription settings with installed-model picker`.

### Task 8: Notes view

**Files:**
- Modify (replace body): `src/notes/NotesView.tsx`
- Create: `src/notes/InkCanvas.tsx`, `src/notes/TranscriptPanel.tsx`, `src/notes/useNotesData.ts` (data hooks), `src/notes/NotesView.test.tsx`

**Interfaces:**
- Consumes: `useCaptureEngine`, `useCaptureState` (`@/capture/CaptureContext`); `PageTurnControls` (`@/capture/PageTurnControls`, render as-is); `listNotes`, `listPages`, `getPage` (storage); `drawStrokes`, `rasterGeometry` (Task 5); `ensureTranscriptionQueue`, `TranscriptionQueue` (Task 6); `Button` from `@/components/ui/button`.
- Produces: `export function NotesView(props?: { queue?: TranscriptionQueue })` — tests inject a fake queue; with no prop it uses `ensureTranscriptionQueue(engine)` (called once via `useState` initializer). `InkCanvas({ strokes?, live?, dims })`, `TranscriptPanel({ page, isActivePage, onRetry })`.

Behaviour (spec §4):
- Data: `useNotesData` loads `listNotes()` and, for the selected note, `listPages(noteId)`; reloads when capture state changes (`activeNoteId`, `activePageId`, `pageIndex`) and when `queue.subscribe` fires (debounce not required; guard against setState after unmount).
- Layout: `flex h-full` — left `aside` (w-64, border-r) with a "Notes" header and a list of buttons: title, local date, badges `Legacy` for `note.legacy`, `Recording`/`Live` for the active note, `Interrupted` for interrupted. Empty state: "No notes yet — write on the pad to start one."
- Main: toolbar row: selected note title (or "No note selected"); **New note** (`engine.startNote()`), **End note** (enabled only when `activeNoteId`), page nav `‹` `Page {i+1} of {n}` `›` buttons with aria-labels `Previous page` / `Next page`, and `<PageTurnControls />`. Body: two columns — `InkCanvas` and `TranscriptPanel`.
- Selection: `selectedNoteId` state; when `state.activeNoteId` changes to a non-null id, select it and jump to `state.pageIndex`; when `state.pageIndex` changes while viewing the active note, jump to it. Default selection: active note, else the newest note.
- Ink: if the viewed page is the active page (`page.id === state.activePageId`), `InkCanvas live` reads `engine.getLiveStrokes()` and redraws on `engine.subscribeInk` throttled by `requestAnimationFrame` (cancel on unmount); else draws `page.strokes`. Canvas intrinsic size = `rasterGeometry(dims, 1024)`; CSS `w-full h-auto max-h-[75vh] object-contain border bg-white`. Guard `getContext('2d')` returning null (happy-dom) — do nothing then.
- Transcript panel: active unfinalized page → "Transcribed when the page is finished." Otherwise by `page.transcript?.status`: `pending` → "Waiting to transcribe…"; `running` → "Transcribing…"; `done` → markdown in a `whitespace-pre-wrap` block (empty → "Blank page"), with a muted `model · promptVersion` line; `failed` → "Transcription failed: {error}" and a **Retry** button (`queue.retry(page.id)`); no transcript on a finalized page → **Transcribe** button (`queue.retry`).

- [ ] **Step 1: Write failing tests** (`createRoot` + `act`; `resetDatabase()`; render inside `<CaptureProvider engine={createCaptureEngine({ controller: createFakeDeviceController() })}>`; fake queue `{ start, enqueue, retry: vi.fn(async () => {}), subscribe: () => () => {}, idle, stop }`; seed storage with `createNote`/`createPage`/`setPageTranscript`):
  1. renders the "New page" button from `PageTurnControls`.
  2. lists a live note and a legacy note (`legacy: true`) with the `Legacy` label.
  3. clicking **New note** makes `engine.getState().activeNoteId` non-null and the list shows the new note.
  4. selecting a note whose page 0 has a `done` transcript shows the markdown text and `Page 1 of 2`; clicking `Next page` shows page 2's `failed` error text and a Retry button; clicking Retry calls `queue.retry(page2.id)`.
  5. a legacy note with null page dims and points without `t` renders without throwing.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the four source files.
- [ ] **Step 4: Run** `npx vitest run` (full) → PASS; `npm run build` → success; `npx eslint src/notes` clean.
- [ ] **Step 5: Commit** `feat(notes): notes view with live ink, page navigation and transcripts`.

### Task 9: Final verification and summary commit

- [ ] `npm run build`, `npx vitest run`, `npx eslint` on every touched path; record counts.
- [ ] Append any new assumptions to `docs/features/f1-spec.md` → Assumptions.
- [ ] Commit `docs(f1): feature spec, plan and summary` with a body summarising the feature, how the queue starts, and removed deps.
