export type NoteStatus = 'active' | 'interrupted' | 'complete';
export type PageSource = 'rom' | 'live' | 'typed';

/**
 * Where a note's title came from, which is what lets auto-naming respect a
 * manual rename (K2). Absent on v1-v3 rows, which reads as `'default'` - the
 * `Note <timestamp>` placeholder `openNote()` writes - so every pre-Phase-3
 * note is eligible for auto-naming. That eligibility is also the summary
 * backfill smart search needs.
 */
export type TitleSource = 'default' | 'auto' | 'manual';

export type TranscriptStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * An audio transcript's status. Deliberately a *separate* union from
 * `TranscriptStatus` rather than a widening of it: `'paused'` can only ever
 * happen to a Whisper job, and widening the shared type would force every
 * page-handwriting reader (`src/transcription/queue.ts`,
 * `src/notes/TranscriptPanel.tsx`, `src/notes/naming/queue.ts`) to handle a
 * state that cannot occur for a page.
 *
 * `'paused'` exists because a lecture-length transcription now keeps a cursor,
 * so stopping one no longer has to mean discarding its work. It is the status
 * the queue's `resume()` deliberately skips at launch - which is what keeps a
 * job the owner stopped from restarting itself on the next reload.
 */
export type AudioTranscriptStatus = TranscriptStatus | 'paused';
/** Mirrors `TabletDeviceType` in src/types/memory.ts. */
export type DeviceType = 'huion' | 'wacom';

export interface StrokePoint {
  /** Normalized 0-1, matching HuionNoteBLE.scaleRawPoint output. */
  x: number;
  y: number;
  pressure: number;
  /**
   * Epoch ms (`Date.now()` clock) when the point was received. Live capture
   * only; ROM and legacy points omit it. This clock is shared with audio
   * segment times, which is what lets Phase 2 align ink with a recording.
   */
  t?: number;
}

export interface PageStroke {
  points: StrokePoint[];
  /** Epoch ms of the first/last point. Live capture only. */
  startedAt?: number;
  endedAt?: number;
}

export interface TranscriptRecord {
  markdown: string;
  /** Ollama model that produced this text, e.g. `gemma3:4b`. */
  model: string;
  /**
   * Identifies the prompt that produced this text. Transcription quality
   * depends at least as much on the prompt as on the model, and prompts get
   * tuned far more often than models get swapped - without this, a prompt
   * change leaves no way to find which transcripts are stale short of
   * re-running every page. Required rather than optional so a caller cannot
   * silently omit it.
   */
  promptVersion: string;
  status: TranscriptStatus;
  error: string | null;
  updatedAt: number;
}

export interface NoteRecord {
  id: string;
  title: string;
  status: NoteStatus;
  deviceId: string;
  deviceType: DeviceType;
  /** Human-readable device name, when the source knew it. */
  deviceName: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Device page count at session start; session pages are baseline..end. */
  pageBaseline: number;
  /**
   * Device page dimensions in device units. Stroke points are normalized 0-1,
   * so rasterizing a page needs this to recover the aspect ratio.
   */
  pageWidth: number | null;
  pageHeight: number | null;
  summary: string | null;
  summaryModel: string | null;
  /** True for notebooks imported from the pre-existing localStorage library. */
  legacy: boolean;
  /**
   * Natural key of the legacy notebook this note was imported from. Lets the
   * migration skip already-imported notebooks when an earlier run failed
   * partway through. `null` for notes captured by this app.
   */
  legacySourceId: string | null;
  /**
   * Session this note belongs to. `null` for legacy or imported notes. Absent
   * on v1 rows, which reads as `null` - optional rather than required so the
   * v2 upgrade needs no data migration.
   */
  sessionId?: string | null;
  /**
   * Free-form tags, normalized on write (K3): trimmed, lowercased,
   * deduplicated, blanks dropped. The displayed form is the stored form, so
   * there is no display name to keep in sync. Absent on pre-v4 rows, which
   * reads as `[]`.
   */
  tags?: string[];
  /** See `TitleSource`. Absent reads as `'default'`. */
  titleSource?: TitleSource;
  /**
   * Identifies the prompt that produced `summary`, for the same reason
   * `TranscriptRecord.promptVersion` exists: prompts get tuned far more often
   * than models get swapped. Absent reads as `null`.
   */
  summaryPromptVersion?: string | null;
}

/** Dimensions and MIME type of a page render. The bytes live in `pageRenders`. */
export interface PageRenderMeta {
  type: string;
  width: number;
  height: number;
}

/**
 * The bytes of a page render, stored in its own object store keyed by page id
 * so that listing pages never drags megabytes of image data into the heap.
 */
export interface PageRenderRecord {
  data: ArrayBuffer;
  type: string;
  width: number;
  height: number;
}

export interface PageRecord {
  id: string;
  noteId: string;
  /** Zero-based position within the note. */
  pageIndex: number;
  /** Page number as reported by the device, when known. */
  devicePageNum: number | null;
  source: PageSource;
  strokes: PageStroke[];
  pointCount: number;
  capturedAt: number;
  /** Metadata only - never the image bytes. See `getPageRender`. */
  render: PageRenderMeta | null;
  transcript: TranscriptRecord | null;
  /**
   * Epoch ms when the page stopped accepting strokes (page turn, new page or
   * note end). `null` while the page is still being written. Absent on v1 rows,
   * which reads as finalized: a legacy page is complete by definition.
   */
  finalizedAt?: number | null;
  /**
   * Result of the last Phase 2 gap analysis of this page. Absent (or `null`)
   * means never analyzed, so the v3 upgrade needs no data migration. See
   * `GapAnalysisMeta` at the end of this file.
   */
  gapAnalysis?: GapAnalysisMeta | null;
  /**
   * The typed content of a `source: 'typed'` page (K32). Absent on ink pages.
   * A typed page's text is also mirrored into its `transcript` (K33), which is
   * what lets transcription skip it while search and gap analysis read it
   * through the one field they already know about.
   */
  text?: string;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export type SessionStatus = 'active' | 'ended';

/**
 * Groups the notes and recordings captured together. Phase 1 creates one
 * session per note; Phase 2 lets one manually started session span several.
 */
export interface SessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  startedAt: number;
  endedAt: number | null;
}

export interface TranscriptSegment {
  /** Offset from `RecordingRecord.startedAt`, in ms. Absolute = startedAt + startMs. */
  startMs: number;
  endMs: number;
  text: string;
}

/** Audio transcript of a recording. Distinct from `TranscriptRecord`, which is page handwriting. */
export interface AudioTranscriptRecord {
  text: string;
  segments: TranscriptSegment[];
  /** Whisper model id, e.g. `Xenova/whisper-base.en`. */
  model: string;
  language: string | null;
  status: AudioTranscriptStatus;
  error: string | null;
  updatedAt: number;
  /**
   * How much of the recording has been transcribed, in ms from its start.
   * Absent reads as `0`. A `running` row carries real `text` and `segments`
   * up to this point, which is what lets a reload, a pause or a preemption
   * pick the job up where it stopped instead of starting it over.
   *
   * The one thing that discards it is a model change: resuming model-B onto
   * model-A's output and stamping the row with one model id would be a lie
   * about what the transcript is.
   */
  completedMs?: number;
  /**
   * The transcription queue instance currently working this recording, or
   * `null`/absent when nobody holds it. Two tabs each build their own queue
   * and each run `resume()` at launch; without a lease their interleaved
   * per-window writes would ratchet `completedMs` backwards and splice two
   * runs into one transcript.
   */
  leaseOwner?: string | null;
  /**
   * Epoch ms of the last heartbeat on `leaseOwner`, refreshed with every
   * per-window write. A lease older than the stall timeout is taken over:
   * a job that has not written in that long is dead by the watchdog's own
   * definition. Absent reads as `null`.
   */
  leaseAt?: number | null;
}

export interface RecordingRecord {
  id: string;
  sessionId: string | null;
  /** Convenience link to the note that was active at record start. */
  noteId: string | null;
  title: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  mimeType: string;
  byteLength: number;
  transcript: AudioTranscriptRecord | null;
}

/**
 * The bytes of a recording, in their own store keyed by recording id so that
 * listing recordings never drags megabytes of audio into the heap - the same
 * reasoning as `PageRenderRecord` (spec D7).
 */
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
  /** Epoch ms. For a deadline this is the due moment unless `allDay`. */
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
  /** Set when `source === 'calendar'`; at most one open task per event. */
  eventId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** Review state of one gap suggestion. A re-run replaces only `proposed` ones (A23). */
export type GapStatus = 'proposed' | 'accepted' | 'rejected';

/** What kind of substantive point was missed (spec-phase2 J6). */
export type GapKind =
  | 'claim'
  | 'definition'
  | 'name-or-date'
  | 'example'
  | 'argument-step'
  | 'other';

/**
 * One point present in the recording but missing from a page's handwriting.
 * Stored separately from the transcript with its provenance (J2): accepting a
 * suggestion never rewrites `TranscriptRecord.markdown`.
 */
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
  /**
   * True when the speech was summarized into bullets before comparison (J5), so
   * the UI can say the source was lossy.
   */
  summarized: boolean;
  createdAt: number;
  updatedAt: number;
}

export type GapAnalysisStatus = 'pending' | 'running' | 'done' | 'failed';

/** Per-page record of the last gap analysis. Lives on `PageRecord.gapAnalysis`. */
export interface GapAnalysisMeta {
  status: GapAnalysisStatus;
  at: number;
  model: string;
  promptVersion: string;
  error: string | null;
  summarized: boolean;
}

/**
 * One `MediaRecorder` chunk, persisted as it arrives so an interrupted session
 * keeps its audio (K4). Transient: `stop()` stitches these into
 * `recordingAudio` and deletes them, so a row here means a recording that is
 * either in progress or was interrupted.
 */
export interface RecordingChunkRecord {
  id: string;
  recordingId: string;
  /** Monotonic per recording, starting at 0. Stitch order (K6). */
  seq: number;
  data: ArrayBuffer;
  /** The `MediaRecorder` MIME type, carried so stitching needs no second read. */
  type: string;
}

/**
 * A recording's decoded audio, held only while its transcription is unfinished
 * (the chunked transcription design, architecture.md §8.6). Transient in
 * exactly the way `RecordingChunkRecord` is: written once after the first
 * decode and deleted when the transcript reaches a terminal status, so a row
 * here means a transcription that is in progress, paused, or was interrupted.
 *
 * It exists so a resumed job never re-decodes. Decoding a lecture-length
 * recording costs minutes and peaks above a gigabyte (`decodeAudioData`
 * allocates at the source rate before the 16 kHz render), and a job that
 * resumes on every app launch would pay that every time.
 *
 * Int16 rather than Float32: 32 KB/s instead of 64, at a quantization error
 * far below what Whisper can hear.
 */
export interface PcmCacheRecord {
  recordingId: string;
  /** Always `TARGET_SAMPLE_RATE`; stored so a future rate change is detectable rather than silent. */
  sampleRate: number;
  /** Int16 samples. */
  samples: ArrayBuffer;
}
