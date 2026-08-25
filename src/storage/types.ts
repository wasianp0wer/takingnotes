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
}

export interface PageStroke {
  points: StrokePoint[];
}

export interface TranscriptRecord {
  markdown: string;
  model: string;
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
}

export interface SettingRecord {
  key: string;
  value: unknown;
}
