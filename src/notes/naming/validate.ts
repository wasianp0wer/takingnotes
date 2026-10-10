export interface NamingResult {
  /** May be blank - `setNoteSummary` treats a blank title as a failed generation, not an instruction to clear it. */
  title: string;
  summary: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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
  return { title: title.trim(), summary: summary.trim() };
}
