export type SmartSearchBand = 'strong' | 'moderate' | 'weak';

export interface BandResult {
  band: SmartSearchBand | 'none';
  reason: string;
}

/**
 * A reason longer than this is noise, not a reason - same convention as
 * `gaps/validate.ts`'s `GAP_TEXT_MAX` and `naming/validate.ts`'s
 * `NAMING_SUMMARY_MAX`: model output is untrusted input, length included.
 */
export const SEARCH_REASON_MAX = 500;

/** The keys a model reaches for when it wraps its array in an object. */
const WRAPPER_KEYS = ['indices', 'candidates', 'relevant', 'matches', 'ids'];

const BAND_VALUES: ReadonlySet<string> = new Set(['strong', 'moderate', 'weak', 'none']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const cap = (text: string, max: number): string => text.trim().slice(0, max);

function toIndex(row: unknown): number | null {
  if (typeof row === 'number' && Number.isInteger(row)) return row;
  if (isRecord(row) && typeof row.index === 'number' && Number.isInteger(row.index)) {
    return row.index;
  }
  return null;
}

/**
 * The screen stage's `validate` (docs/architecture.md §6.4): the model's
 * JSON is untrusted input. A row outside `1..candidateCount`, or not a
 * number at all, is dropped rather than cast - one bad entry costs one
 * candidate, not the whole screen. A non-array, non-wrapper value throws:
 * the model did not do the task, which must not look like "found nothing".
 * An empty result (nothing survived, or the array was empty) is a valid,
 * non-throwing "no candidates".
 */
export function validateScreenIndices(value: unknown, candidateCount: number): number[] {
  let rows: unknown[];
  if (Array.isArray(value)) {
    rows = value;
  } else if (isRecord(value)) {
    const wrapped = WRAPPER_KEYS.map((key) => value[key]).find((v) => Array.isArray(v));
    if (!Array.isArray(wrapped)) {
      throw new Error('The model did not return a JSON array of note numbers.');
    }
    rows = wrapped;
  } else {
    throw new Error('The model did not return a JSON array of note numbers.');
  }

  const seen = new Set<number>();
  for (const row of rows) {
    const index = toIndex(row);
    if (index === null || index < 1 || index > candidateCount) continue;
    seen.add(index);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The band stage's `validate`. Throws only when the value is not even a
 * JSON object (the model answered in prose). An unrecognised `band`
 * defaults to `'none'` rather than throwing - a malformed label on an
 * otherwise-answered call sinks only this candidate, matching
 * `gaps/validate.ts`'s "an unknown `kind` becomes `'other'`" convention.
 * `reason` is coerced to `''` when absent or not a string, and capped.
 */
export function validateBandResult(value: unknown): BandResult {
  if (!isRecord(value)) {
    throw new Error('The model did not return a JSON object with "band" and "reason".');
  }
  const raw = typeof value.band === 'string' ? value.band.trim().toLowerCase() : '';
  const band = (BAND_VALUES.has(raw) ? raw : 'none') as SmartSearchBand | 'none';
  const reason = typeof value.reason === 'string' ? cap(value.reason, SEARCH_REASON_MAX) : '';
  return { band, reason };
}
