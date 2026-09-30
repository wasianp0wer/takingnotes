import type { SpeechWindow } from '@/gaps/window';
import type { PageRecord, RecordingRecord } from '@/storage/types';

export type GapSkipReason =
  | 'no-strokes'
  | 'no-timestamps'
  | 'no-recording'
  | 'recording-transcript'
  | 'page-transcript';

export type GapEligibility = { ok: true } | { ok: false; reason: GapSkipReason };

/**
 * Whether a page can be compared against the recording at all. One place, shared
 * by the analyzer (which skips rather than failing - A22) and the panel (which
 * says why and disables its button), so a press can never look available while
 * the analyzer would silently do nothing (P1-A4).
 *
 * Order matters: the reasons are reported from the page's own shape outwards, so
 * a blank page reads as "nothing written here" rather than "the recording is
 * still transcribing".
 */
export function gapEligibility(
  page: PageRecord,
  recording: RecordingRecord | null,
  window: SpeechWindow | null,
): GapEligibility {
  if (page.strokes.length === 0 || page.pointCount === 0) {
    return { ok: false, reason: 'no-strokes' };
  }
  if (window === null) return { ok: false, reason: 'no-timestamps' };
  if (recording === null) return { ok: false, reason: 'no-recording' };
  if (recording.transcript?.status !== 'done') {
    return { ok: false, reason: 'recording-transcript' };
  }
  // Without the page's own transcript there is nothing to say the page is
  // missing anything (P1-A8).
  if (page.transcript?.status !== 'done') return { ok: false, reason: 'page-transcript' };
  return { ok: true };
}

/** The panel's wording for each reason. Plain sentences, no jargon. */
export function describeGapSkip(reason: GapSkipReason): string {
  switch (reason) {
    case 'no-strokes':
      return 'This page has no writing on it, so there is nothing to compare.';
    case 'no-timestamps':
      return 'This page has no timestamps to line up with the recording.';
    case 'no-recording':
      return 'This note has no linked recording.';
    case 'recording-transcript':
      return 'The recording is still being transcribed.';
    case 'page-transcript':
      return 'This page has not been transcribed yet.';
  }
}
