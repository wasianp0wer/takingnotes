export type NoteStatus = 'active' | 'interrupted' | 'complete';
export type PageSource = 'rom' | 'live';
export type TranscriptStatus = 'pending' | 'running' | 'done' | 'failed';
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
  status: TranscriptStatus;
  error: string | null;
  updatedAt: number;
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
