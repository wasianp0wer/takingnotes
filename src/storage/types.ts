export type NoteStatus = 'active' | 'interrupted' | 'complete';
export type PageSource = 'rom' | 'live';
export type TranscriptStatus = 'pending' | 'running' | 'done' | 'failed';

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
  deviceType: 'huion';
  startedAt: number;
  endedAt: number | null;
  /** Device page count at session start; session pages are baseline..end. */
  pageBaseline: number;
  summary: string | null;
  summaryModel: string | null;
  /** True for notebooks imported from the pre-existing localStorage library. */
  legacy: boolean;
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
  render: ArrayBuffer | null;
  renderType: string | null;
  renderW: number | null;
  renderH: number | null;
  transcript: TranscriptRecord | null;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}
