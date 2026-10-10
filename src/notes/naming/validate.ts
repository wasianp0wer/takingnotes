export interface NamingResult {
  /** May be blank - `setNoteSummary` treats a blank title as a failed generation, not an instruction to clear it. */
  title: string;
  summary: string;
}

/**
 * A title longer than this is not a title (fix round 1, Important 2): it
 * would break the sidebar row and the toolbar, which both assume a short
 * line. Same reasoning and same shape as `gaps/validate.ts`'s `GAP_TEXT_MAX`.
 */
export const NAMING_TITLE_MAX = 200;
/**
 * A summary longer than this is not "one to two sentences" (K18); it is also
 * what Wave 3's smart search screens against, so an unbounded one would be
 * the thing being searched rather than a short pointer to it.
 */
export const NAMING_SUMMARY_MAX = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const cap = (text: string, max: number): string => text.trim().slice(0, max);

/**
 * The `validate` for `generateJson` (docs/architecture.md §6.4): the model's
 * JSON is untrusted input. Unlike the gap comparison's array of droppable
 * rows, this is a single object with nothing to drop, so a shape the model
 * did not follow throws rather than being patched up - the caller logs it
 * and the note keeps its timestamp title (K19's same reasoning: a confident
 * guess from a malformed answer is worse than no answer).
 *
 * A blank `title` is allowed through (K18's "blank generated title is a
 * failed generation" is `setNoteSummary`'s call to make, not this
 * validator's); a blank `summary` is not, since nothing downstream treats an
 * empty summary as meaningful and `setNoteSummary` always writes it verbatim.
 * Both are length-capped (`NAMING_TITLE_MAX`/`NAMING_SUMMARY_MAX`) rather
 * than rejected outright - a rambling answer is still usable once trimmed,
 * and a title or summary this long is otherwise unbounded input landing
 * directly in the sidebar row and in what Wave 3's smart search screens.
 */
export function validateNamingResult(value: unknown): NamingResult {
  if (!isRecord(value)) {
    throw new Error('The model did not return a JSON object with "title" and "summary".');
  }
  const { title, summary } = value;
  if (typeof title !== 'string') {
    throw new Error('The model\'s "title" was not a string.');
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new Error('The model\'s "summary" was missing or blank.');
  }
  return { title: cap(title, NAMING_TITLE_MAX), summary: cap(summary, NAMING_SUMMARY_MAX) };
}
