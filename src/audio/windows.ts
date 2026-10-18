// Slicing a decoded recording into the windows the transcription queue
// transcribes one at a time, and merging each window's segments back onto the
// ones already persisted.
//
// This exists because a lecture used to be one `pipeline()` call: hours long,
// reporting nothing until it finished, and persisting nothing until it
// finished either. Windowing is what gives the job a cursor - and a cursor is
// what makes it resumable, pausable and preemptible.
import { TARGET_SAMPLE_RATE } from '@/audio/pcm';
import type { TranscriptSegment } from '@/storage/types';

/**
 * How much of the recording one window covers. Long enough that the per-window
 * overheads (a pipeline call, a storage write) stay negligible, short enough
 * that partial text appears while the owner is still watching, and comfortably
 * longer than `WHISPER_OPTIONS.chunk_length_s` so each window still contains
 * several of the pipeline's own internal chunks.
 */
export const DEFAULT_WINDOW_MS = 300_000;

/**
 * How much audio before a window's boundary is fed to Whisper as lead-in
 * context, so the first words after a boundary are transcribed against what
 * preceded them rather than against silence. Matches
 * `WHISPER_OPTIONS.stride_length_s`, which is the same idea applied to the
 * pipeline's own internal chunking.
 *
 * The lead-in is transcribed twice by construction; `mergeWindowSegments`
 * drops the repeat.
 */
export const WINDOW_OVERLAP_MS = 5_000;

export interface PcmWindow {
  /**
   * The boundary this window is responsible for. Everything from here to
   * `endMs` is new transcript, and `endMs` is what the cursor advances to.
   */
  startMs: number;
  endMs: number;
  /**
   * Where to start slicing PCM - up to `WINDOW_OVERLAP_MS` *earlier* than
   * `startMs`, for lead-in context. Equal to `startMs`'s sample only for the
   * first window of a recording, which has nothing before it to read.
   */
  startSample: number;
  endSample: number;
}

function samplesAt(ms: number): number {
  return Math.round((ms / 1000) * TARGET_SAMPLE_RATE);
}

/**
 * The windows covering `fromMs` to the end of a recording of `totalSamples`
 * 16 kHz samples.
 *
 * Empty when there is nothing left to do - an empty recording, or a cursor at
 * or past the end. A cursor *past* the end is not an error: a recording can be
 * re-decoded slightly shorter than it was when the cursor was written, and the
 * honest reading of "I have already transcribed more than this" is "there is
 * nothing left", not a crash.
 */
export function planWindows(
  totalSamples: number,
  fromMs: number,
  windowMs: number = DEFAULT_WINDOW_MS,
): PcmWindow[] {
  const totalMs = (totalSamples / TARGET_SAMPLE_RATE) * 1000;
  const start = Math.max(0, fromMs);
  if (totalSamples <= 0 || start >= totalMs) return [];

  const windows: PcmWindow[] = [];
  for (let at = start; at < totalMs; at += windowMs) {
    const endMs = Math.min(at + windowMs, totalMs);
    windows.push({
      startMs: at,
      endMs,
      startSample: samplesAt(Math.max(0, at - WINDOW_OVERLAP_MS)),
      // Clamped, so float rounding on the last window can never slice past
      // the end of the buffer.
      endSample: Math.min(totalSamples, samplesAt(endMs)),
    });
  }
  return windows;
}

/**
 * Appends a window's segments to the ones already persisted, dropping the
 * lead-in's duplicates.
 *
 * The rule is the cursor: a segment that starts before the boundary this
 * window is responsible for is the lead-in being heard a second time, and the
 * first pass over it is already stored. A segment starting exactly on the
 * boundary is new.
 */
export function mergeWindowSegments(
  existing: readonly TranscriptSegment[],
  incoming: readonly TranscriptSegment[],
  cursorMs: number,
): TranscriptSegment[] {
  return [...existing, ...incoming.filter((segment) => segment.startMs >= cursorMs)];
}
