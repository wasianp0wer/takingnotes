# Chunked, resumable audio transcription — design

Written 2026-10-18. Branch: `phase3`.

## Intent, and the why

A 2 hour 30 minute lecture never finished transcribing, and nothing of the work
survived.

The diagnosis matters, because it rules out the obvious fixes. The owner added a
decode-pass counter (the uncommitted `passes` work on `phase3`) specifically to
find out whether the job was wedged. It was not: the counter kept climbing the
whole time. The decode completed, the model loaded, the pipeline ran, and the
stall watchdog correctly never fired, because the job was genuinely alive. It was
simply going to take longer than anyone would sit and wait, with no partial
output, no knowable end, and no way to stop and pick it up again.

So this is **not a performance feature.** Whisper inference over 2.5 hours of
audio takes hours and this design does not make it faster. What it changes is
that those hours become survivable: the work persists as it is produced, it
resumes after a reload or a deliberate pause, and the owner can see how far along
it is and read what has landed so far.

### What is there now

One recording is one indivisible job. `transcriptionQueue.runJob` reads the whole
blob, decodes it to a single `Float32Array`, transfers that to the Whisper worker,
makes one `pipeline()` call, and writes once at the end. `WHISPER_OPTIONS` sets
`chunk_length_s: 30`, but that is transformers.js chunking internally — the call
still returns only once, when everything is done.

The three persisted states are `pending` → `running` → `done`. A `running` row
carries `text: ''` and `segments: []`. There is no cursor, so `resume()` has
nowhere to restart from and begins again at zero.

### What is already right, and stays

The queue is strictly serial on purpose (two Whisper models cannot run at once),
it already persists status, it already resumes a backlog at launch, it already has
a per-step stall watchdog, and `TranscriptSegment` already carries ms offsets from
the recording start. The data model for a partial transcript is very nearly
present already. This design adds a cursor and per-window writes; it does not
rework the queue.

## Goals

1. A partial transcript persists as it is produced, and survives a reload, a
   crash, or the tab being closed.
2. Transcription resumes from its cursor rather than from zero.
3. Progress has a real denominator (`cursor / durationMs`), not just a climbing
   count with no total.
4. The owner can pause a long job and resume it deliberately.
5. Partial transcripts are searchable, with a visible warning that results may be
   incomplete.

## Non-goals

- **Making Whisper faster.** The inference time is close to irreducible here.
  Model choice (`whisper.model`) remains the owner's speed lever and is untouched.
- **Parallel transcription.** The serial loop is deliberate and stays.
- **Chunked decode / WebM fragment parsing.** See *Decisions taken* below — this
  was considered and dropped.
- **Any change to capture.** The recorder, `recordingChunks`, and startup recovery
  are not touched.

## Anti-goals

Things that would make this a failure even if it technically worked:

- A partial transcript presented anywhere as though it were complete.
- Auto-naming or gap analysis acting on partial content and producing confidently
  wrong output — exactly the defect the Phase 3 process caught once already.
- A resumed backlog job blocking a lecture the owner just recorded.
- Losing the safety property behind today's terminal cancel: `resume()` must never
  silently restart a job the owner deliberately stopped.

## Constraints

- One Whisper job at a time. Non-negotiable.
- The existing stall watchdog must keep working, including its property that every
  phase of a job breaks its own silence.
- Phase 3 invariants hold: `listFinishedRecordings()` is the only way to ask for
  finished work, and `finalizeRecording` remains the one correct close.
- No new runtime dependencies.
- **The uncommitted work on `phase3` lands first.** Eleven modified files, all in
  the audio path this touches (`transcriptionQueue`, `whisperClient`,
  `whisperProtocol`, `whisperWorkerCore`, `types`, `RecordingDetail`,
  `RecordingsView.test`) plus a new `transcriptionQueue.writeStall.test.ts`. This
  design assumes that work as its baseline.

## The design

### Windowing

Decode once, then slice the decoded PCM into windows and call
`transcriber.transcribe()` once per window, rather than once for the recording.

Each window's returned chunks are offset by the window's start before becoming
segments. `chunksToSegments` already maps seconds to ms from the recording start;
it gains an offset addend.

Windows overlap, and the overlap is deduplicated at the seam so a sentence spoken
across a boundary is not transcribed twice. **Window length, overlap length, and
the seam dedupe are the builder's to choose**, with two constraints: the window
must be comfortably longer than `WHISPER_OPTIONS.chunk_length_s` (30s), and it
sets how often partial text appears, so it is a latency/overhead tradeoff rather
than a free parameter.

### Persistence and the cursor

`AudioTranscriptRecord` gains `completedMs?: number` — optional, so no migration,
the same pattern `tags?` and `titleSource?` already use.

After each window the queue writes the accumulated segments, the accumulated text,
and the new cursor, with status `running`. A `running` row therefore now carries
real content, which is the central change this design makes to the data model.

On resume, `runJob` reads `completedMs` and starts at the first window at or after
it, rather than at zero.

### The PCM cache

Re-decoding on every resume would cost minutes and a ~1.7 GB peak each time the
app reopens. So the decoded PCM is cached: a new object store, Int16 at 16 kHz,
keyed by recording id, written once after the first decode.

It is **transient**, deleted when the transcript reaches `done` or `failed` —
deliberately the same lifecycle `recordingChunks` already has, and for the same
reason. At 32 KB/s that is roughly 288 MB for a 2.5-hour lecture, held only while
that lecture is mid-transcription. The owner has accepted that cost.

A missing or unreadable cache row is never an error: the job re-decodes from
`recordingAudio` and rewrites it.

### Status model

`AudioTranscriptStatus = TranscriptStatus | 'paused'`, declared separately from
the shared `TranscriptStatus`.

This is deliberate. `TranscriptStatus` is shared with `TranscriptRecord` (page
handwriting, via Ollama), and widening the shared union would force
`transcription/queue.ts`, `TranscriptPanel.tsx` and `notes/naming/queue.ts` to
consider a state that cannot occur for a page. Splitting it confines the change to
the audio side: `transcriptionQueue`, `RecordingDetail`, `RecordingsView`,
`gaps/eligibility`, `search/corpus`.

### Pause and resume

`pause(id)` stops the active job and writes status `paused`. A merely queued job
can also be paused, and is dropped from the queue.

**Pause replaces cancel.** `cancel()` and `CANCELLED_MESSAGE` are retired, along
with their tests — two stop buttons differing only in recoverability would be a
worse UI than one. Discarding a transcription entirely is deleting the recording,
which already exists.

**Pause is immediate, not boundary-deferred.** It aborts the controller and
terminates the worker, exactly as `cancel()` does today and for the same stated
reason: work the owner stopped must really stop rather than grind on unwatched. A
button that does nothing visible for a whole window would be worse. The cost is
that the in-flight window's work is lost — the cursor sits at the last completed
boundary — and resume reloads the model from cache, which is seconds.

`resume()` at launch re-enqueues `null`, `pending` and `running` rows as it does
today, and **skips `paused`**. That preserves the exact safety property today's
terminal cancel exists for: a job the owner stopped stays stopped across reloads.
`RecordingDetail` gains a Resume button, which re-enqueues from the cursor.

### The cursor's lifetime

The cursor survives everything **except a model change.** At job entry, if
`getModel()` differs from the stored `transcript.model`, the cursor and
accumulated segments are discarded and the job starts clean. `runJob` already
re-reads the model at entry precisely because the setting may have changed while
a recording sat in the queue; splicing model-B output onto model-A output and
stamping the row with one model id would be a quiet lie about what the transcript
is.

That rule doubles as the escape hatch for a bad partial: change the model, get a
clean run. There is deliberately **no separate "start over" button** in this
version — a known limitation, listed below.

Otherwise `retry` continues to be `enqueue`, and both resume from the cursor,
including after a stall-failure.

### Multi-tab safety

A `running` row carrying real content is new, and it makes two tabs genuinely
dangerous rather than merely wasteful: both build their own queue, both run
`resume()` at launch, and their interleaved per-window writes would ratchet the
cursor backwards and splice two runs together. Today the same race only duplicates
work and the last write wins.

So a job takes a **lease**: an owner id and a heartbeat timestamp written onto the
transcript row, refreshed with each per-window write. A queue takes a job only if
it is unowned or the lease has gone stale. This is the same posture
`recoverInterruptedRecordings` already takes toward a second actor.

The owner intends to move this app into Electron, where a second tab stops being
possible. The lease is cheap safety in the meantime and harmless afterwards.

### Preemption

Because a cursor makes stopping free, the queue becomes preemptible at window
boundaries. At each boundary the active job checks whether anything of higher
priority is waiting; if so it writes its cursor and steps aside.

This replaces picking a static ordering. `resume()`'s current oldest-first order
exists because deferring a job used to mean losing its work; once that is no
longer true, a durable backlog would otherwise always sit in front of the lecture
the owner actually wants.

**Two priority classes.** `enqueue` gains a priority argument:

- *Foreground* — `recorder.onSaved` (just recorded), `recoverInterruptedRecordings`
  (the lecture that was just interrupted), and any button press in
  `RecordingDetail` (the owner is looking right at it).
- *Backlog* — `resume()` at launch, and nothing else.

A yielded job returns to the **front of its own class**, so a backlog job that
steps aside for a fresh recording resumes ahead of the rest of the backlog rather
than going to the back of the line.

**A yielded job stays `running`** and stays in the in-memory queue. No fourth
state: it is in `queuedIds`, so `RecordingDetail`'s `stuck` heuristic (a
`pending`/`running` row that is neither active nor queued) correctly does not
treat it as stranded, and if the tab closes while it is yielded, `resume()` picks
it up at the next launch exactly as intended.

**Transcription does not hold for capture.** An earlier draft had the queue pause
while the recorder was active; taken literally that meant a 2.5-hour lecture
bought 2.5 hours of zero backlog progress, which is a regression against the very
throughput this design exists to recover. The owner chose never to hold. Chunks
persist every second, so contention costs at most a second of audio, and startup
recovery already handles that case.

### Progress

`TranscriptionQueueState` reports `cursor / durationMs` as a real fraction. The
`passes` counter stays as the liveness signal that re-arms the watchdog — it is
still the only honest within-window signal — but it is no longer what the owner
reads to judge how far along a job is.

### The watchdog

Unchanged in mechanism, and still re-armed by every progress report. One
improvement falls out of the cursor: a job abandoned as stalled is written
`failed` **with its cursor intact**, so pressing Retry resumes from the last
completed window rather than starting the recording over. Today a stall on a long
recording is unrecoverable in practice, because every retry repeats the same work
and stalls in the same place.

### Consumers of a partial transcript

**Smart search and Find: yes, with a warning in both.**

`search/corpus.ts:62` gates on `recording.transcript?.status === 'done'`, but that
gate only feeds `audioText`/`primaryRecordingId`, which is **smart search alone**.
`find.ts:94` iterates `corpus.recordings` and reads `transcript?.segments` with no
status check at all — so Find starts returning partial hits the moment `running`
rows carry real segments, with no code change and, without this, no warning. That
makes the warning a two-path job, not a one-line predicate change:

- `corpus.ts` widens its predicate to include `running` and `paused` rows with
  non-empty text.
- Both paths carry a count of recordings in the corpus whose transcript is absent,
  `running` or `paused`. `FindResult` widens to hold it; smart search already has
  somewhere to put it.
- `SearchView` renders the caveat in **both** modes. Today its caveat lines render
  only in smart mode, off `smart.unsummarizedCount`/`titleOnlyCount`; that is the
  right shape to copy, but Find needs its own.

The count is global across the corpus, not per note — "some of what you searched
isn't fully transcribed yet" is the honest claim, and a per-note count would imply
a precision this doesn't have.

**Gap analysis: no.** It compares a page's speech window against the transcript,
so a page from the untranscribed tail would be compared against silence and
reported as a page that missed everything. `gaps/eligibility.ts:33` already
excludes anything that is not `done`, so no change is needed to keep partials out.
A later coverage-aware version that analyzes only pages inside the cursor is
possible but is **not** in scope here.

**Auto-naming: no change.** It waits for `done` or `failed`, for the reason it
already does: titling a lecture from its first 40% is how a note gets a
confidently wrong name, and that defect has been caught here before.

## Decisions taken on the owner's behalf

Recorded so they can be overturned rather than discovered.

- **Chunked decode was dropped.** Decoding the recording in slices would cut the
  peak from ~1.7 GB to tens of MB, and the pieces for it exist (chunk boundaries
  are known at `finalizeRecording` time; an EBML cluster walker already exists in
  `incrementalRecovery.decode.test.ts` and could be promoted). It was dropped for
  two reasons: the decode demonstrably succeeded at 2:30, so it is not the
  blocker; and it depends on a browser accepting a synthetic WebM fragment, which
  architecture.md §8.2 records as explicitly unproven. The PCM cache removes the
  only recurring cost it would have avoided. If a longer recording later fails in
  the decode itself, this is the named next step.
- **Preemption at window boundaries** rather than a static queue order, with two
  priority classes and a yielded job staying `running`.
- **Gap analysis stays `done`-only** rather than becoming coverage-aware now.
- **The PCM cache is transient**, not permanent.
- **`AudioTranscriptStatus` is split** from the shared `TranscriptStatus`.
- **Pause is immediate and replaces cancel**, losing at most the in-flight window.
- **A model change is the only thing that discards the cursor**, and is therefore
  also the only way to force a clean re-run.

## Left to the builder

- Window length, overlap length, and the seam dedupe algorithm.
- Int16 quantization details and the PCM cache's store shape, plus the
  `DB_VERSION` bump and upgrade block that store needs, and hooking its delete
  into `deleteRecording` alongside `recordingChunks`.
- How partial transcript text is laid out in `RecordingDetail` while a job runs.
- Where the preemption and lease checks sit in the drain loop, and what counts as
  a stale lease.
- Preserving accumulated segments on the `fail()` write, and not blanking the row
  in `runJob`'s opening `write(blank(...))`.

## Open risks and known limitations

- **Background tab throttling is unverified.** The lost lecture was transcribing
  while the owner worked in other tabs. A background tab may have been
  deprioritized, particularly on WebGPU. This design does not address it and it
  has not been measured.
- **Disk during long jobs.** Several half-transcribed long lectures at once would
  hold the PCM cache for each. Accepted.
- **No "start over" control.** A clean re-run is only reachable by changing the
  model. If a partial transcript is bad and the model is right, there is no way
  to discard and restart short of deleting the recording.
- **Transcription runs during capture.** Chosen deliberately for throughput; the
  mitigation is per-second chunk persistence and startup recovery, not avoidance.
