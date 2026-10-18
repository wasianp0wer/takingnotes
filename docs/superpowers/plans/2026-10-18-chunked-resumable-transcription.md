# Chunked, Resumable Audio Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe a recording window by window, persisting the partial transcript and a cursor after each window, so a lecture-length job survives a reload, can be paused and resumed, and yields to work the owner cares about more.

**Architecture:** The serial queue in `src/audio/transcriptionQueue.ts` keeps its shape — one job in flight, status on the recording row, `resume()` at launch. What changes is inside `runJob`: it decodes once into a transient Int16 PCM cache, slices the PCM into overlapping windows, calls `transcriber.transcribe()` per window, and writes accumulated segments plus a `completedMs` cursor after each. The cursor is what makes resume, pause, preemption and a multi-tab lease all possible; none of them need a new queue.

**Tech Stack:** TypeScript, React, `idb`, `@huggingface/transformers` (Whisper in a Worker), Vitest + happy-dom, `fake-indexeddb` via the existing storage test setup.

**Spec:** `docs/superpowers/specs/2026-10-18-chunked-resumable-transcription-design.md`

## Global Constraints

- One Whisper job in flight at a time. The serial drain loop is not to be parallelised.
- No new runtime dependencies.
- The baseline is the **uncommitted working tree on `phase3`** (the `passes`/watchdog/download work). Do not revert or rewrite it.
- `listFinishedRecordings()` remains the only way to ask for finished recordings; `finalizeRecording` remains the only correct close.
- Every new field on a persisted record is optional with a documented absent-reading, so no data migration is needed.
- Each `if (oldVersion < N)` block in `src/storage/db.ts` is one schema generation and must never be edited once shipped — add a new block.
- `DEFAULT_WINDOW_MS = 300_000` (5 min), `WINDOW_OVERLAP_MS = 5_000` (matches the existing `WHISPER_OPTIONS.stride_length_s: 5`), `LEASE_STALE_MS = DEFAULT_STALL_TIMEOUT_MS` (15 min — a job that has not written in that long is dead by the watchdog's own definition).
- Test command: `npx vitest run <path>` for one file, `npm test` for all. Typecheck: `npx tsc -b`. Lint: `npm run lint` (5 pre-existing warnings in `src/utils/huionTransport.ts` are expected).
- `AudioTranscriptRecord` has no `id` field. Where a test needs the writes for one recording, capture `(id, record)` pairs from the `setRecordingTranscript` spy and read them through a `writesFor(id)` helper; `written` on its own is the flat record list.

## Review Focus

Five conditions the spec implies that no task's happy-path tests would otherwise reach. Each has a test assigned to the task that owns the code.

1. **A recording shorter than one window.** `planWindows` must return exactly one window covering the whole recording, never zero. A 40-second voice memo transcribing to nothing would be silent data loss. → Task 3.
2. **A window that produces no segments** (silence, or Whisper hearing nothing). The cursor must still advance past it, or the job re-transcribes the same silent window forever. → Task 4.
3. **A cursor at or past the end of the audio.** A resumed job whose stored `completedMs` is `>= durationMs`, or whose re-decoded PCM is shorter than when the cursor was written, must finish cleanly rather than loop or index out of bounds. → Task 5.
4. **A PCM cache row of the wrong length or unreadable.** It must be ignored and the audio re-decoded, never used at a mismatched length — a short cache row silently truncates the lecture. → Task 5.
5. **A paused or partially-transcribed recording that is then deleted.** Pause, resume and the lease paths must treat a missing recording as a no-op, matching how `runJob` already handles a mid-job delete. → Task 6.

---

### Task 1: The transient PCM cache store (DB v5)

**Files:**
- Modify: `src/storage/types.ts` (add `PcmCacheRecord`)
- Modify: `src/storage/db.ts` (`DB_VERSION` 4 → 5, `pcmCache` store, new upgrade block)
- Create: `src/storage/pcmCache.ts`
- Modify: `src/storage/recordings.ts` (`deleteRecording` cascades)
- Test: `src/storage/pcmCache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PcmCacheRecord { recordingId: string; sampleRate: number; samples: ArrayBuffer }` — `samples` is Int16 at `TARGET_SAMPLE_RATE`.
  - `putPcmCache(recordingId: string, pcm: Float32Array): Promise<void>`
  - `getPcmCache(recordingId: string): Promise<Float32Array | null>`
  - `deletePcmCache(recordingId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests** in `src/storage/pcmCache.test.ts`

```ts
it('round-trips PCM within Int16 quantization error', async () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1, 0.123]);
  await putPcmCache('r1', pcm);
  const back = await getPcmCache('r1');
  expect(back).not.toBeNull();
  expect(back!.length).toBe(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) expect(back![i]).toBeCloseTo(pcm[i], 3);
});

it('clamps samples outside [-1, 1] rather than wrapping', async () => {
  await putPcmCache('r1', new Float32Array([2, -2]));
  const back = await getPcmCache('r1');
  expect(back![0]).toBeCloseTo(1, 3);
  expect(back![1]).toBeCloseTo(-1, 3);
});

it('returns null for a recording with no cache row', async () => {
  expect(await getPcmCache('missing')).toBeNull();
});

it('deleting a recording deletes its PCM cache', async () => {
  // create a recording via createRecording, putPcmCache, deleteRecording
  expect(await getPcmCache(recording.id)).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/storage/pcmCache.test.ts`
Expected: FAIL — module `@/storage/pcmCache` not found.

- [ ] **Step 3: Add `PcmCacheRecord` to `src/storage/types.ts`**

Document it as transient, with the same lifecycle note `RecordingChunkRecord` carries: written once after the first decode, deleted when the transcript reaches a terminal status.

- [ ] **Step 4: Bump `DB_VERSION` to 5 in `src/storage/db.ts`, declare the `pcmCache` store in `NotesDb`, and add an `if (oldVersion < 5)` block**

In-line keys on `recordingId`. No index — every read is by primary key. No data migration.

- [ ] **Step 5: Implement `putPcmCache`, `getPcmCache`, `deletePcmCache` in `src/storage/pcmCache.ts`**

Quantize with `Math.round(clamp(sample, -1, 1) * 32767)` and dequantize with `value / 32767`, so `±1` survives the round trip exactly.

- [ ] **Step 6: Extend `deleteRecording` in `src/storage/recordings.ts` to delete the `pcmCache` row**

Alongside the existing `recordingChunks` cleanup, in the same transaction.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run src/storage/pcmCache.test.ts src/storage/recordings.test.ts && npx tsc -b`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add src/storage/pcmCache.ts src/storage/pcmCache.test.ts src/storage/types.ts src/storage/db.ts src/storage/recordings.ts
git commit -m "feat(storage): transient Int16 PCM cache store (db v5)"
```

---

### Task 2: `AudioTranscriptStatus`, the cursor, and the lease fields

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/recordings/RecordingsView.tsx:9-25` (`statusWord`)
- Test: `src/recordings/RecordingsView.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type AudioTranscriptStatus = TranscriptStatus | 'paused';`
  - `AudioTranscriptRecord.status: AudioTranscriptStatus`
  - `AudioTranscriptRecord.completedMs?: number` — ms of the recording transcribed so far; absent reads as `0`.
  - `AudioTranscriptRecord.leaseOwner?: string | null` — the queue instance holding this job; absent reads as `null`.
  - `AudioTranscriptRecord.leaseAt?: number | null` — epoch ms of the last lease heartbeat; absent reads as `null`.

- [ ] **Step 1: Write the failing test** in `src/recordings/RecordingsView.test.tsx`

```ts
it('labels a paused transcript "Paused"', async () => {
  // render RecordingsView with a recording whose transcript.status is 'paused'
  expect(container.textContent).toContain('Paused');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/recordings/RecordingsView.test.tsx`
Expected: FAIL — renders "Not transcribed" from the `default` branch.

- [ ] **Step 3: Add the type and the three fields in `src/storage/types.ts`**

Declare `AudioTranscriptStatus` separately and use it only on `AudioTranscriptRecord`. `TranscriptRecord` keeps the narrower `TranscriptStatus` — widening the shared union would force the three page consumers (`src/transcription/queue.ts`, `src/notes/TranscriptPanel.tsx`, `src/notes/naming/queue.ts`) to handle a state that cannot occur for a page. Record that reasoning in the doc comment.

- [ ] **Step 4: Add a `case 'paused': return 'Paused'` to `statusWord`**

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/recordings/RecordingsView.test.tsx && npx tsc -b`
Expected: PASS, clean. `tsc` surfaces any other site that must now handle `'paused'`; handle each by leaving partials out (the `done`-only predicates in `src/gaps/eligibility.ts` already do this correctly and need no change).

- [ ] **Step 6: Commit**

```bash
git add src/storage/types.ts src/recordings/RecordingsView.tsx src/recordings/RecordingsView.test.tsx
git commit -m "feat(audio): AudioTranscriptStatus with 'paused', cursor and lease fields"
```

---

### Task 3: Window planning and segment offsetting

**Files:**
- Create: `src/audio/windows.ts`
- Modify: `src/audio/whisperProtocol.ts` (`chunksToSegments` gains an offset)
- Test: `src/audio/windows.test.ts`, `src/audio/whisperProtocol.test.ts`

**Interfaces:**
- Consumes: `TARGET_SAMPLE_RATE` from `@/audio/pcm`, `TranscriptSegment` from `@/storage/types`.
- Produces:
  - `export const DEFAULT_WINDOW_MS = 300_000;`
  - `export const WINDOW_OVERLAP_MS = 5_000;`
  - `export interface PcmWindow { startMs: number; endMs: number; startSample: number; endSample: number }`
  - `planWindows(totalSamples: number, fromMs: number, windowMs?: number): PcmWindow[]` — windows covering `fromMs` to the end. Each window starts `WINDOW_OVERLAP_MS` before its own `startMs` where there is room, so Whisper has lead-in context; `startMs` remains the boundary the cursor advances to.
  - `chunksToSegments(chunks, durationMs, offsetMs?)` — `offsetMs` defaults to `0`.
  - `mergeWindowSegments(existing: readonly TranscriptSegment[], incoming: readonly TranscriptSegment[], cursorMs: number): TranscriptSegment[]` — appends only incoming segments with `startMs >= cursorMs`, which is what drops the overlap's duplicate text at the seam.

- [ ] **Step 1: Write the failing tests**

```ts
// windows.test.ts
it('returns exactly one window for a recording shorter than a window', () => {
  const samples = 40 * TARGET_SAMPLE_RATE; // 40 seconds
  const windows = planWindows(samples, 0);
  expect(windows).toHaveLength(1);
  expect(windows[0].startSample).toBe(0);
  expect(windows[0].endSample).toBe(samples);
});

it('covers the whole recording with no gap between window boundaries', () => {
  const windows = planWindows(20 * 60 * TARGET_SAMPLE_RATE, 0);
  expect(windows[0].startMs).toBe(0);
  for (let i = 1; i < windows.length; i += 1) {
    expect(windows[i].startMs).toBe(windows[i - 1].endMs);
  }
  expect(windows.at(-1)!.endMs).toBe(20 * 60 * 1000);
});

it('reads back lead-in context before a resumed boundary', () => {
  const [first] = planWindows(20 * 60 * TARGET_SAMPLE_RATE, 600_000);
  expect(first.startMs).toBe(600_000);
  expect(first.startSample).toBe(((600_000 - WINDOW_OVERLAP_MS) / 1000) * TARGET_SAMPLE_RATE);
});

it('returns no windows when the cursor is at or past the end', () => {
  expect(planWindows(60 * TARGET_SAMPLE_RATE, 60_000)).toEqual([]);
  expect(planWindows(60 * TARGET_SAMPLE_RATE, 99_000)).toEqual([]);
});

it('drops incoming segments that fall before the cursor', () => {
  const existing = [{ startMs: 0, endMs: 1000, text: 'one' }];
  const incoming = [
    { startMs: 996_000, endMs: 999_000, text: 'lead-in repeat' },
    { startMs: 1_000_500, endMs: 1_002_000, text: 'new' },
  ];
  expect(mergeWindowSegments(existing, incoming, 1_000_000)).toEqual([
    { startMs: 0, endMs: 1000, text: 'one' },
    { startMs: 1_000_500, endMs: 1_002_000, text: 'new' },
  ]);
});

// whisperProtocol.test.ts
it('offsets segment times by the window start', () => {
  const segments = chunksToSegments([{ timestamp: [1, 2], text: 'hi' }], 30_000, 600_000);
  expect(segments[0]).toEqual({ startMs: 601_000, endMs: 602_000, text: 'hi' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/windows.test.ts src/audio/whisperProtocol.test.ts`
Expected: FAIL — `@/audio/windows` not found; the offset assertion fails with unoffset times.

- [ ] **Step 3: Implement `planWindows` and `mergeWindowSegments` in `src/audio/windows.ts`**

- [ ] **Step 4: Add the `offsetMs = 0` parameter to `chunksToSegments`**

Applied after the existing seconds→ms conversion, to both `startMs` and `endMs`, including the `durationMs`-derived fallback end.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/audio/windows.test.ts src/audio/whisperProtocol.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/audio/windows.ts src/audio/windows.test.ts src/audio/whisperProtocol.ts src/audio/whisperProtocol.test.ts
git commit -m "feat(audio): window planning, seam merge and segment offsetting"
```

---

### Task 4: The queue transcribes window by window and persists each one

**Files:**
- Modify: `src/audio/transcriptionQueue.ts` (`runJob`)
- Test: `src/audio/transcriptionQueue.test.ts`

**Interfaces:**
- Consumes: `planWindows`, `mergeWindowSegments`, `DEFAULT_WINDOW_MS` (Task 3); `completedMs` (Task 2).
- Produces: `runJob` writes one `running` record per completed window, carrying accumulated `text`, `segments` and `completedMs`. `TranscriptionQueueDeps` gains `windowMs?: number` so tests can use small windows.

- [ ] **Step 1: Write the failing tests** in `src/audio/transcriptionQueue.test.ts`

```ts
it('writes a partial transcript after each window', async () => {
  // 3 windows of audio, windowMs small, transcriber returns one segment per call
  const running = written.filter((r) => r.status === 'running');
  expect(running.map((r) => r.completedMs)).toEqual([0, 100, 200, 300]);
  expect(running.at(-1)!.text).toContain('window 3');
});

it('calls the transcriber once per window, not once per recording', async () => {
  expect(transcribe).toHaveBeenCalledTimes(3);
});

it('advances the cursor past a window that produces no segments', async () => {
  // middle window resolves with segments: [] and text: ''
  expect(written.at(-1)!.status).toBe('done');
  expect(written.at(-1)!.completedMs).toBe(300);
});

it('keeps the segments it already had when a later window fails', async () => {
  // window 2 rejects
  const failed = written.at(-1)!;
  expect(failed.status).toBe('failed');
  expect(failed.completedMs).toBe(100);
  expect(failed.segments).toHaveLength(1);
});

it('keeps the cursor when the watchdog abandons the job as stalled', async () => {
  // window 2 never settles; fire the manual timer
  const failed = written.at(-1)!;
  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('stalled');
  expect(failed.completedMs).toBe(100);
  expect(failed.segments).toHaveLength(1);
});
```

The last test is the one that makes a stall recoverable: today a stalled lecture repeats the same work on every Retry and stalls in the same place. Use the `manualTimers()` helper that `transcriptionQueue.writeStall.test.ts` already defines rather than a real clock.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts`
Expected: FAIL — one `transcribe` call, one terminal write, no `completedMs`.

- [ ] **Step 3: Rewrite the transcribe phase of `runJob` as a loop over `planWindows(pcm.length, startMs, windowMs)`**

Per window: slice the PCM, `transcribe` it, map chunks with `chunksToSegments(chunks, windowDurationMs, window.startMs)`, merge with `mergeWindowSegments(accumulated, mapped, window.startMs)`, then write `running` with the accumulated text and segments and `completedMs: window.endMs`. After the last window, write `done`.

Two existing behaviours must be preserved and are easy to lose here: the opening `write(id, blank(model, 'running'))` must **not** blank a row that already carries segments (Task 5 makes that reachable), and `fail()` must carry the accumulated segments and cursor rather than the empty ones it writes today.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts src/audio/transcriptionQueue.writeStall.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audio/transcriptionQueue.ts src/audio/transcriptionQueue.test.ts
git commit -m "feat(audio): transcribe window by window, persisting each"
```

---

### Task 5: Resume from the cursor, backed by the PCM cache

**Files:**
- Modify: `src/audio/transcriptionQueue.ts`
- Modify: `src/audio/audioRuntime.ts` (wire the cache deps)
- Test: `src/audio/transcriptionQueue.test.ts`

**Interfaces:**
- Consumes: `putPcmCache`/`getPcmCache`/`deletePcmCache` (Task 1), `completedMs` (Task 2).
- Produces: `TranscriptionQueueDeps` gains `readPcmCache?`, `writePcmCache?`, `dropPcmCache?`, defaulting to the Task 1 functions.

- [ ] **Step 1: Write the failing tests**

```ts
it('starts at the stored cursor instead of at zero', async () => {
  // recording's transcript is { status: 'running', completedMs: 200, segments: [one] }
  await queue.enqueue('r1');
  await queue.whenIdle();
  expect(transcribe).toHaveBeenCalledTimes(1); // only the last window
  expect(written.at(-1)!.segments).toHaveLength(2); // the old one plus the new
});

it('caches the decoded PCM on first decode and reuses it on resume', async () => {
  expect(decode).toHaveBeenCalledTimes(1);
  expect(writePcmCache).toHaveBeenCalledTimes(1);
  // second run
  expect(decode).toHaveBeenCalledTimes(1);
  expect(readPcmCache).toHaveBeenCalledTimes(2);
});

it('deletes the cache once the transcript reaches a terminal status', async () => {
  expect(dropPcmCache).toHaveBeenCalledWith('r1');
});

it('re-decodes when the cached PCM is shorter than the stored cursor implies', async () => {
  // cache returns a Float32Array far too short for completedMs
  expect(decode).toHaveBeenCalledTimes(1);
});

it('finishes cleanly when the cursor is already at or past the end', async () => {
  // completedMs === durationMs
  expect(transcribe).not.toHaveBeenCalled();
  expect(written.at(-1)!.status).toBe('done');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts`
Expected: FAIL — always decodes, always starts at zero.

- [ ] **Step 3: Implement the cache-and-resume path in `runJob`**

Read `completedMs` from the existing transcript. Try `readPcmCache` first; use it only when its length is consistent with the recording (at least as many samples as the cursor requires) — otherwise decode and `writePcmCache`. Call `dropPcmCache` on every terminal exit (`done` and `failed`), never on a `paused` or yielded exit. A cache read that throws is caught and treated as a miss.

- [ ] **Step 4: Wire the real cache functions as defaults in `src/audio/audioRuntime.ts`**

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/audio/ && npx tsc -b`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/audio/transcriptionQueue.ts src/audio/transcriptionQueue.test.ts src/audio/audioRuntime.ts
git commit -m "feat(audio): resume from the cursor using a cached decode"
```

---

### Task 6: Pause replaces cancel

**Files:**
- Modify: `src/audio/transcriptionQueue.ts`
- Test: `src/audio/transcriptionQueue.test.ts`

**Interfaces:**
- Consumes: `'paused'` status (Task 2).
- Produces: `TranscriptionQueue.pause(id: string): Promise<void>` replaces `cancel`. `cancel` and `CANCELLED_MESSAGE` are removed.

- [ ] **Step 1: Write the failing tests**

```ts
it('pausing the active job stops it and keeps its cursor', async () => {
  await queue.pause('r1');
  await queue.whenIdle();
  const last = written.at(-1)!;
  expect(last.status).toBe('paused');
  expect(last.completedMs).toBe(100);
  expect(last.segments).toHaveLength(1);
});

it('pausing a merely queued job drops it from the queue', async () => {
  expect(queue.getState().queuedIds).not.toContain('r2');
});

it('resume() at launch skips a paused recording', async () => {
  await queue.resume();
  expect(queue.getState().activeId).toBeNull();
  expect(queue.getState().queuedIds).toEqual([]);
});

it('re-enqueuing a paused recording continues from its cursor', async () => {
  await queue.enqueue('r1');
  await queue.whenIdle();
  expect(written.at(-1)!.status).toBe('done');
});

it('pausing a recording that no longer exists is a no-op', async () => {
  await expect(queue.pause('deleted')).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts`
Expected: FAIL — `queue.pause` is not a function.

- [ ] **Step 3: Replace `cancel` with `pause` in `src/audio/transcriptionQueue.ts`**

`pause` keeps today's cancel mechanism — abort the controller, which terminates the worker so the work really stops — but the terminal write becomes `status: 'paused'` carrying the accumulated segments and cursor instead of `failed` with `CANCELLED_MESSAGE`. Delete `CANCELLED_MESSAGE` and the `cancelledByUser` → failed path. Add `'paused'` to the set of statuses `resume()` skips (it already only enqueues `null`/`pending`/`running`, so this is a documentation change plus a test).

Update the doc comment that currently explains why cancel is terminal: the reason it gave — that `resume()` would otherwise restart a stopped job — is now served by the `paused` status instead.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/audio/ && npx tsc -b`
Expected: PASS. `tsc` names the `RecordingDetail` call sites still using `cancel`; Task 10 rewrites them, so stub them to `pause` here to keep the build green.

- [ ] **Step 5: Commit**

```bash
git add src/audio/transcriptionQueue.ts src/audio/transcriptionQueue.test.ts src/recordings/RecordingDetail.tsx
git commit -m "feat(audio): pause replaces cancel, keeping the partial transcript"
```

---

### Task 7: A model change discards the cursor

**Files:**
- Modify: `src/audio/transcriptionQueue.ts`
- Test: `src/audio/transcriptionQueue.test.ts`

**Interfaces:**
- Consumes: `completedMs` (Task 2), the cache deps (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```ts
it('starts clean when the model differs from the stored transcript', async () => {
  // stored: { status: 'paused', model: 'Xenova/whisper-tiny.en', completedMs: 200, segments: [one] }
  // getModel now returns 'Xenova/whisper-base.en'
  expect(transcribe).toHaveBeenCalledTimes(3); // every window, not just the last
  expect(written.at(-1)!.segments.map((s) => s.text)).not.toContain('one');
});

it('keeps the cursor when the model is unchanged', async () => {
  expect(transcribe).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts`
Expected: FAIL — the first test resumes from 200 and calls `transcribe` once.

- [ ] **Step 3: Compare `model` against `existing.transcript?.model` at job entry in `runJob`**

When they differ, treat `completedMs` as `0` and the accumulated segments as empty. `runJob` already re-reads `getModel()` at entry for exactly this scenario; this gives that re-read a consequence. Note in the comment that this is also the only way to force a clean re-run.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audio/transcriptionQueue.ts src/audio/transcriptionQueue.test.ts
git commit -m "feat(audio): a model change discards the transcription cursor"
```

---

### Task 8: Priority classes and window-boundary preemption

**Files:**
- Modify: `src/audio/transcriptionQueue.ts`
- Modify: `src/audio/audioRuntime.ts` (`resume()` enqueues as backlog)
- Test: `src/audio/transcriptionQueue.test.ts`

**Interfaces:**
- Consumes: the window loop (Task 4).
- Produces:
  - `export type TranscriptionPriority = 'foreground' | 'backlog';`
  - `enqueue(id: string, priority?: TranscriptionPriority): Promise<void>` — defaults to `'foreground'`.
  - `resume()` enqueues with `'backlog'`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a foreground enqueue preempts a running backlog job at the next window boundary', async () => {
  // r1 (backlog) is mid-run; enqueue r2 as foreground during window 1
  expect(order).toEqual(['r1', 'r2', 'r1']); // r1 yields, r2 runs, r1 resumes
});

it('a yielded job keeps status running and stays queued', async () => {
  expect(writesFor('r1').at(-1)!.status).toBe('running');
  expect(queue.getState().queuedIds).toContain('r1');
});

it('a yielded job returns to the front of its own class', async () => {
  // backlog holds r1 (yielded) and r3; r1 runs before r3
  expect(order).toEqual(['r1', 'r2', 'r1', 'r3']);
});

it('a foreground job is not preempted by another foreground job', async () => {
  expect(order).toEqual(['r1', 'r2']);
});

it('resumes a yielded job after a reload, since its row is still running', async () => {
  await queue.resume();
  expect(queue.getState().queuedIds).toContain('r1');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts`
Expected: FAIL — `enqueue` takes one argument and jobs run to completion.

- [ ] **Step 3: Give `queued` two classes and check for a higher-priority waiter at each window boundary**

The active job records its own priority. At each boundary, if a `foreground` id is waiting and the active job is `backlog`, write the cursor (status stays `running`), push the id onto the **front** of its own class, and return from `runJob` so the drain loop picks the next one. A yielded job must remain in `queuedIds`, which is what keeps `RecordingDetail`'s `stuck` heuristic from flagging it as stranded.

- [ ] **Step 4: Make `resume()` enqueue with `'backlog'`; leave `recorder.onSaved`, `recoverInterruptedRecordings` and the UI buttons on the `'foreground'` default**

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/audio/ && npx tsc -b`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/audio/transcriptionQueue.ts src/audio/transcriptionQueue.test.ts src/audio/audioRuntime.ts
git commit -m "feat(audio): priority classes and window-boundary preemption"
```

---

### Task 9: The multi-tab lease

**Files:**
- Modify: `src/audio/transcriptionQueue.ts`
- Test: `src/audio/transcriptionQueue.test.ts`

**Interfaces:**
- Consumes: `leaseOwner`/`leaseAt` (Task 2).
- Produces: `TranscriptionQueueDeps` gains `ownerId?: string` (default: `newId()`) and `leaseStaleMs?: number` (default `LEASE_STALE_MS`).

- [ ] **Step 1: Write the failing tests**

```ts
it('stamps its owner and heartbeat on every window write', async () => {
  const running = written.filter((r) => r.status === 'running');
  expect(new Set(running.map((r) => r.leaseOwner))).toEqual(new Set(['owner-a']));
  expect(running.every((r) => typeof r.leaseAt === 'number')).toBe(true);
});

it('skips a job another owner is actively holding', async () => {
  // stored: { status: 'running', leaseOwner: 'owner-b', leaseAt: now }
  expect(transcribe).not.toHaveBeenCalled();
});

it('takes over a job whose lease has gone stale', async () => {
  // leaseAt: now - (LEASE_STALE_MS + 1)
  expect(transcribe).toHaveBeenCalled();
});

it('takes a job with no lease at all (a pre-upgrade row)', async () => {
  expect(transcribe).toHaveBeenCalled();
});

it('clears the lease on every terminal write', async () => {
  expect(written.at(-1)!.leaseOwner).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts`
Expected: FAIL — no lease is written and a held job is picked up anyway.

- [ ] **Step 3: Write the lease on each window write and check it at job entry**

At entry, re-read the recording: if `leaseOwner` is set, is not this queue's `ownerId`, and `leaseAt` is within `leaseStaleMs` of `now()`, skip the job without writing anything. Clear `leaseOwner`/`leaseAt` to `null` on `done`, `failed` and `paused`; keep them on a yield, since the same queue is coming back to it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audio/transcriptionQueue.ts src/audio/transcriptionQueue.test.ts
git commit -m "feat(audio): single-writer lease so two tabs cannot splice a transcript"
```

---

### Task 10: Real progress, partial text, and Pause/Resume in the UI

**Files:**
- Modify: `src/audio/transcriptionQueue.ts` (`TranscriptionQueueState`)
- Modify: `src/recordings/RecordingDetail.tsx`
- Test: `src/audio/transcriptionQueue.test.ts`, `src/recordings/RecordingsView.test.tsx`

**Interfaces:**
- Consumes: `pause` (Task 6), `completedMs` (Task 2).
- Produces: `TranscriptionQueueState.completedMs: number | null` and `durationMs: number | null`, both `null` when idle.

- [ ] **Step 1: Write the failing tests**

```ts
// transcriptionQueue.test.ts
it('reports the cursor and the recording duration while transcribing', async () => {
  expect(queue.getState().completedMs).toBe(100);
  expect(queue.getState().durationMs).toBe(300);
});

// RecordingsView.test.tsx
it('shows the partial transcript text while a job is running', async () => {
  expect(container.textContent).toContain('window 1 text');
});

it('offers Pause while transcribing and Resume once paused', async () => {
  expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  // after pausing
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
});

it('shows how far a paused transcription got', async () => {
  expect(container.textContent).toContain('Paused at');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/transcriptionQueue.test.ts src/recordings/RecordingsView.test.tsx`
Expected: FAIL — no `completedMs` on the state, no Pause/Resume buttons.

- [ ] **Step 3: Add `completedMs` and `durationMs` to `TranscriptionQueueState`, `sameState` and `emit`**

- [ ] **Step 4: Update `RecordingDetail.tsx`**

Drive the `running` branch's `<Progress>` from `completedMs / durationMs` rather than `queueState.progress`, which stays for the `loading` stage only. Render the accumulated transcript text while `running` and `paused`. Replace the Cancel button with Pause, and add Resume on a `paused` row (calling `queue.retry`). Keep `passes` where it is as the liveness line — it is still the only within-window signal.

- [ ] **Step 5: Run tests and lint**

Run: `npx vitest run src/audio/ src/recordings/ && npm run lint`
Expected: PASS; lint clean except the 5 known `huionTransport.ts` warnings.

- [ ] **Step 6: Commit**

```bash
git add src/audio/transcriptionQueue.ts src/audio/transcriptionQueue.test.ts src/recordings/RecordingDetail.tsx src/recordings/RecordingsView.test.tsx
git commit -m "feat(recordings): real progress, partial text and Pause/Resume"
```

---

### Task 11: Search reads partial transcripts, and says so

**Files:**
- Modify: `src/search/corpus.ts`
- Modify: `src/search/SearchView.tsx`
- Test: `src/search/corpus.test.ts`, `src/search/SearchView.test.tsx`

**Interfaces:**
- Consumes: `'paused'` and `completedMs` (Task 2).
- Produces:
  - `SearchCorpus.partialTranscriptCount: number` — recordings in the corpus whose transcript is absent, `running` or `paused`.
  - `corpus.ts`'s `isDoneTranscribed` becomes `hasSearchableTranscript(recording)`: `status` is `done`, `running` or `paused` **and** `text` is non-blank.

- [ ] **Step 1: Write the failing tests**

```ts
// corpus.test.ts
it('includes a running transcript with real text in audioText', async () => {
  expect(corpus.notes[0].audioText).toContain('partial words');
});

it('still excludes a running transcript with no text yet', async () => {
  expect(corpus.notes[0].audioText).toBe('');
  expect(corpus.notes[0].primaryRecordingId).toBeNull();
});

it('counts recordings that are not fully transcribed', async () => {
  // one done, one running, one paused, one with transcript null
  expect(corpus.partialTranscriptCount).toBe(3);
});

// SearchView.test.tsx
it('warns that Find results may be incomplete', async () => {
  expect(container.textContent).toContain('not fully transcribed');
});

it('warns in smart mode too', async () => { /* … */ });

it('shows no warning when everything is transcribed', async () => {
  expect(container.textContent).not.toContain('not fully transcribed');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/search/`
Expected: FAIL — `partialTranscriptCount` is undefined, partials excluded, no warning rendered.

- [ ] **Step 3: Widen the predicate in `src/search/corpus.ts` and compute `partialTranscriptCount`**

Note in the comment why `find.ts` needs no change: it already reads `transcript?.segments` with no status gate, so partial hits arrive there for free — which is precisely why the warning has to render in both modes rather than only the smart one.

- [ ] **Step 4: Render the caveat in `SearchView.tsx` in both modes**

One line, in the established `text-xs text-muted-foreground` shape the existing caveats use, rendered whenever `corpus.partialTranscriptCount > 0` and a query is active — above the Find list and inside the smart block. Singular/plural handled like the neighbouring lines.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/search/ && npx tsc -b`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/search/corpus.ts src/search/corpus.test.ts src/search/SearchView.tsx src/search/SearchView.test.tsx
git commit -m "feat(search): read partial transcripts and warn that results may be incomplete"
```

---

### Task 12: Whole-suite verification and documentation

**Files:**
- Modify: `docs/architecture.md` (new §8.6)

- [ ] **Step 1: Run the whole suite, typecheck, lint and build**

Run: `npm test && npx tsc -b && npm run lint && npm run build`
Expected: all pass; lint shows only the 5 known `huionTransport.ts` warnings. Record the test count — the baseline is 1498 across 115 files plus whatever the uncommitted work added.

- [ ] **Step 2: Write `docs/architecture.md` §8.6**

The cursor and what invalidates it; the PCM cache's transient lifecycle; the two priority classes and the yield rule; the lease and its staleness threshold; and the known limitations from the design doc's final section, including that transcription now runs during capture and that there is no "start over" control.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): §8.6 chunked resumable transcription"
```
