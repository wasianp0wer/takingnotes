import type { TranscriptSegment } from '@/storage/types';

/** A span of the recording, as offsets from its start in ms. */
export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface TimedText extends TimeRange {
  text: string;
}

/**
 * Text reduced to what a quote match should compare: lowercase letters and
 * numbers separated by single spaces. The model may re-case, re-punctuate or
 * add a list dash to a quote, and Whisper punctuation is unreliable anyway.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Normalized text with a space either side, for whole-word matching. */
function padWords(normalized: string): string {
  return ` ${normalized} `;
}

/**
 * The time range of the segments a quote was spoken across, or `null` when the
 * quote is empty or not found. Matching is on whole words of normalized text
 * joined across segment boundaries, so a quote may start and end mid-segment
 * but never mid-word (`ATP` does not match `ATPase`).
 */
export function findQuoteInSegments(
  segments: TranscriptSegment[],
  quote: string,
): TimeRange | null {
  const needle = normalizeForMatch(quote);
  if (needle.length === 0) return null;

  let haystack = '';
  const spans: { segment: TranscriptSegment; from: number; to: number }[] = [];
  for (const segment of segments) {
    const text = normalizeForMatch(segment.text);
    if (text.length === 0) continue;
    if (haystack.length > 0) haystack += ' ';
    spans.push({
      segment,
      from: haystack.length,
      to: haystack.length + text.length,
    });
    haystack += text;
  }

  // Padded on both sides so only whole words match. A hit in the padded
  // haystack at `i` starts the needle at `i + 1` there, which is `i` in the
  // unpadded one, so the span offsets need no adjusting.
  const at = padWords(haystack).indexOf(padWords(needle));
  if (at < 0) return null;
  const last = at + needle.length - 1;
  const first = spans.find((s) => at >= s.from && at < s.to);
  const end = spans.find((s) => last >= s.from && last < s.to);
  if (!first || !end) return null;
  return { startMs: first.segment.startMs, endMs: end.segment.endMs };
}

/** The range of the first summary bullet containing the quote as whole words, or `null`. */
export function findQuoteInBullets(bullets: TimedText[], quote: string): TimeRange | null {
  const needle = normalizeForMatch(quote);
  if (needle.length === 0) return null;
  const padded = padWords(needle);
  const hit = bullets.find((b) => padWords(normalizeForMatch(b.text)).includes(padded));
  return hit ? { startMs: hit.startMs, endMs: hit.endMs } : null;
}
