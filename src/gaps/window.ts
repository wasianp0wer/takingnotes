import { GAP_LEAD_MS, GAP_TRAIL_MS } from '@/gaps/constants';
import type { PageRecord, PageStroke, RecordingRecord, TranscriptSegment } from '@/storage/types';

export interface SpeechWindow {
  fromMs: number;
  toMs: number;
}

export interface SpeechWindowOptions {
  leadMs?: number;
  trailMs?: number;
}

/**
 * A usable epoch-ms instant, or `undefined`. `NaN` and the infinities are not
 * instants: a non-finite value that reached the window would make every segment
 * comparison false, so the page would read as "the recording said nothing here"
 * when the truth is "this stroke carries no time to align against".
 */
function instant(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Epoch ms of a stroke's first and last point, or `null` when it carries no times. */
function strokeSpan(stroke: PageStroke): SpeechWindow | null {
  const times = stroke.points
    .map((p) => p.t)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  // Each end falls back to the other: a stroke carrying exactly one of
  // `startedAt` / `endedAt` and no point times still says when it was written,
  // and a zero-length span at that instant is the honest reading of it.
  const started = instant(stroke.startedAt) ?? instant(times.at(0));
  const ended = instant(stroke.endedAt) ?? instant(times.at(-1));
  const first = started ?? ended;
  const last = ended ?? started;
  if (first === undefined || last === undefined) return null;
  return { fromMs: Math.min(first, last), toMs: Math.max(first, last) };
}

/**
 * The absolute-time window of speech that belongs to a page: its writing span,
 * widened by a lead (speech precedes writing) and a smaller trail.
 *
 * `null` when the page has no strokes, or none of them carries a timestamp -
 * a ROM or legacy page has nothing to align against, which A22 makes a skip
 * rather than a failure.
 *
 * The end is `finalizedAt` when the page has one: writing often stops well
 * before the page is turned, and the speech in between is exactly what a gap
 * analysis is looking for. An absent `finalizedAt` (a v1 row) is not a
 * timestamp, so it falls back to the last stroke like an open page does. It is
 * taken as `max(finalizedAt, last stroke)`, never the bare `finalizedAt`: a
 * `finalizedAt` that predates the last stroke (a clock adjustment, a repaired
 * row) would otherwise truncate or invert the window.
 */
export function speechWindowForPage(
  page: PageRecord,
  opts: SpeechWindowOptions = {},
): SpeechWindow | null {
  const spans = page.strokes.map(strokeSpan).filter((s): s is SpeechWindow => s !== null);
  if (spans.length === 0) return null;

  const firstStroke = Math.min(...spans.map((s) => s.fromMs));
  const lastStroke = Math.max(...spans.map((s) => s.toMs));
  const end = typeof page.finalizedAt === 'number' ? page.finalizedAt : lastStroke;

  const leadMs = opts.leadMs ?? GAP_LEAD_MS;
  const trailMs = opts.trailMs ?? GAP_TRAIL_MS;
  return { fromMs: firstStroke - leadMs, toMs: Math.max(end, lastStroke) + trailMs };
}

/**
 * Overlap, in ms, between a speech window and a finished recording's time
 * span (K45). `0` when they do not overlap at all, including a mere boundary
 * touch - the margins in `speechWindowForPage` are already an estimate, so a
 * zero-width touch is not real overlap the way a touching transcript segment
 * is treated as one in `segmentsInWindow`.
 */
export function overlapMs(
  window: SpeechWindow,
  recording: { startedAt: number; endedAt: number },
): number {
  const from = Math.max(window.fromMs, recording.startedAt);
  const to = Math.min(window.toMs, recording.endedAt);
  return Math.max(0, to - from);
}

/**
 * The recording's segments overlapping an absolute-time window, in order.
 * Segment times are offsets from `recording.startedAt` (see `TranscriptSegment`).
 *
 * Overlap is inclusive at both ends: the margins are already an estimate, so a
 * segment that merely touches the boundary is speech worth comparing.
 */
export function segmentsInWindow(
  recording: RecordingRecord,
  fromMs: number,
  toMs: number,
): TranscriptSegment[] {
  const segments = recording.transcript?.segments ?? [];
  const base = recording.startedAt;
  return segments
    .filter((s) => base + s.endMs >= fromMs && base + s.startMs <= toMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** One flat string for the comparison (or the chunker), skipping silent segments. */
export function speechTextOf(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(' ');
}
