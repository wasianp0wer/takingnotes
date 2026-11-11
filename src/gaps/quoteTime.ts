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
  return withFragments(quote, (piece) => findWholeQuoteInSegments(segments, piece));
}

function findWholeQuoteInSegments(
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

/**
 * The range of the first summary bullet containing the quote as whole words, or
 * `null`. A quote the model stitched together from several bullets - or
 * shortened with an ellipsis - spans every bullet one of its pieces is in.
 */
export function findQuoteInBullets(bullets: TimedText[], quote: string): TimeRange | null {
  return withFragments(quote, (piece) => findWholeQuoteInBullets(bullets, piece));
}

function findWholeQuoteInBullets(bullets: TimedText[], quote: string): TimeRange | null {
  const needle = normalizeForMatch(quote);
  if (needle.length === 0) return null;
  const padded = padWords(needle);
  const hit = bullets.find((b) => padWords(normalizeForMatch(b.text)).includes(padded));
  return hit ? { startMs: hit.startMs, endMs: hit.endMs } : null;
}

/** A piece shorter than this many words says too little to place a quote by. */
const MIN_FRAGMENT_WORDS = 3;

/**
 * Where a model breaks a quote it did not copy in one piece: an ellipsis, or a
 * sentence or clause end followed by more text. A period inside a number
 * (`1.5`) has no space after it, so it is not a break.
 */
const FRAGMENT_BREAK = /\.{2,}|…|[.;:!?](?=\s)|\n/;

/**
 * `find` on the whole quote, or else on each of its pieces, spanning every piece
 * that was found. Models copy a "verbatim" quote as several spans joined - two
 * summary bullets run together, a sentence elided with `...` - and the whole
 * never matches, though each piece does. A piece too short to be evidence on
 * its own is not looked for.
 */
function withFragments(
  quote: string,
  find: (piece: string) => TimeRange | null,
): TimeRange | null {
  const whole = find(quote);
  if (whole !== null) return whole;

  const pieces = quote
    .split(FRAGMENT_BREAK)
    .filter((piece) => normalizeForMatch(piece).split(' ').length >= MIN_FRAGMENT_WORDS);
  if (pieces.length < 2) return null;

  let range: TimeRange | null = null;
  for (const piece of pieces) {
    const hit = find(piece);
    if (hit === null) continue;
    range =
      range === null
        ? hit
        : { startMs: Math.min(range.startMs, hit.startMs), endMs: Math.max(range.endMs, hit.endMs) };
  }
  return range;
}

/** A citation mark: square brackets holding only line numbers, commas and ranges. */
const CITATION = /\s*\[\s*\d+(?:\s*(?:,|-|–)\s*\d+)*\s*\]/g;

/**
 * One summary bullet, with the citation marks the summarize prompt asks for
 * (`[4]`, `[4, 5]`, `[4-6]`) stripped from its text and turned into its span:
 * from the first cited line's start to the last one's end. `lines` maps each
 * passage line number to its span in the recording. A bullet that cites no
 * known line keeps `fallback`, the span of the whole chunk it came from - the
 * most that can honestly be said about where it was made.
 */
export function citedBullet(
  line: string,
  lines: ReadonlyMap<number, TimeRange>,
  fallback: TimeRange,
): TimedText {
  const cited: TimeRange[] = [];
  const text = line
    .replace(CITATION, (mark) => {
      for (const part of mark.replace(/[[\]\s]/g, '').split(',')) {
        const [from, to = from] = part.split(/-|–/).map(Number);
        for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) {
          const span = lines.get(n);
          if (span) cited.push(span);
          if (n - Math.min(from, to) > lines.size) break; // a garbled range, not a citation
        }
      }
      return '';
    })
    .trim();
  if (cited.length === 0) return { text, startMs: fallback.startMs, endMs: fallback.endMs };
  return {
    text,
    startMs: Math.min(...cited.map((c) => c.startMs)),
    endMs: Math.max(...cited.map((c) => c.endMs)),
  };
}
