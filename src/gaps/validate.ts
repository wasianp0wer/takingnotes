import { GAP_KINDS } from '@/gaps/prompts';
import type { GapKind, GapSuggestionRecord } from '@/storage/types';

/** One missing point, as the comparison prompt returns it. */
export interface GapPoint {
  text: string;
  kind: GapKind;
  sourceQuote: string;
}

/** A row longer than this is a degenerate answer, not a point; it is truncated. */
export const GAP_TEXT_MAX = 2000;
/** More than this from one page is noise; the rest are dropped. */
export const GAP_MAX_POINTS = 50;

/** The keys a model reaches for when it wraps its array in an object. */
const WRAPPER_KEYS = ['points', 'gaps', 'missing', 'missingPoints', 'items', 'result'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    for (const key of WRAPPER_KEYS) {
      if (Array.isArray(value[key])) return value[key] as unknown[];
    }
  }
  throw new Error('The model did not return a JSON array of missing points.');
}

const cap = (text: string): string => text.trim().slice(0, GAP_TEXT_MAX);

/**
 * Comparison key for "the same point". Deliberately loose - case, whitespace and
 * surrounding punctuation only - because the model restates a point differently
 * between runs, and a near-duplicate shown twice is a worse failure than a
 * reworded one slipping through (P1-A3).
 */
export function normalizeGapText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}

function toPoint(row: unknown): GapPoint | null {
  if (!isRecord(row)) return null;
  const text = typeof row.text === 'string' ? cap(row.text) : '';
  if (text.length === 0) return null;
  const kind = GAP_KINDS.includes(row.kind as GapKind) ? (row.kind as GapKind) : 'other';
  const sourceQuote = typeof row.sourceQuote === 'string' ? cap(row.sourceQuote) : '';
  return { text, kind, sourceQuote };
}

/**
 * The `validate` for `generateJson` (docs/architecture.md §6.4): model JSON is
 * untrusted input. A row that is not a point is dropped, because one bad row
 * should cost one suggestion rather than the whole analysis; a response that is
 * not a list of points at all throws, because a model answering in prose has not
 * done the task and must not look like "no gaps found".
 */
export function validateGapPoints(value: unknown): GapPoint[] {
  const rows = asArray(value);
  const seen = new Set<string>();
  const points: GapPoint[] = [];
  for (const row of rows) {
    const point = toPoint(row);
    if (point === null) continue;
    const key = normalizeGapText(point.text);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    points.push(point);
    if (points.length === GAP_MAX_POINTS) break;
  }
  return points;
}

/**
 * Removes points the user has already ruled on (A23): keeping a rejected record
 * only stops it resurfacing if the analyzer consults it. `proposed` records are
 * not consulted - a re-run replaces those anyway.
 */
export function dropReviewed(
  points: GapPoint[],
  existing: GapSuggestionRecord[],
): GapPoint[] {
  const reviewed = new Set(
    existing
      .filter((g) => g.status === 'accepted' || g.status === 'rejected')
      .map((g) => normalizeGapText(g.text)),
  );
  return points.filter((p) => !reviewed.has(normalizeGapText(p.text)));
}
