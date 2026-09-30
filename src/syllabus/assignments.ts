import { localDayKey } from '@/syllabus/day';
import { resolveDueDate } from '@/syllabus/dates';

/** One assignment as extraction understood it (architecture §6.5). */
export interface ExtractedAssignment {
  title: string;
  /** Epoch ms, or null when the text gave no resolvable date. */
  dueAt: number | null;
  /** What the model read, kept for the review table when `dueAt` is null. */
  rawDate: string;
  estimatedMinutes: number | null;
  notes: string;
}

export interface ResolveContext {
  termStart: number;
  now: number;
}

/**
 * Field ceilings. A model that loops can emit a field of any length, and an
 * unbounded title would wreck the review table, so what we keep is truncated
 * rather than dropped: the row is still the user's assignment.
 */
const MAX_TITLE = 200;
const MAX_RAW_DATE = 100;
const MAX_NOTES = 500;

/**
 * The ceiling on any estimate, however it arrives - stated by the model here, or
 * typed by the user on the review screen, which imports this. One constant for
 * both: a number the user may type by hand must not be one the model is
 * forbidden to state, and this guard exists to reject nonsense (non-finite,
 * zero, negative, absurd), not to second-guess a plausibly large thesis.
 */
export const MAX_ESTIMATED_MINUTES = 100_000;

const YEAR_MS = 365.2425 * 24 * 60 * 60 * 1000;
/** How far from the term start a resolved date may plausibly fall (P2-A2). */
const EARLIEST_BEFORE_TERM = 2 * YEAR_MS;
const LATEST_AFTER_TERM = 5 * YEAR_MS;

/**
 * Case- and whitespace-insensitive identity of a title, for dedupe and `sourceRef`.
 *
 * Deliberately conservative: surrounding quotes and trailing punctuation go,
 * because overlapping chunks quote and punctuate the same item differently, but
 * internal punctuation stays - "Essay #1" and "Essay 1" may be different items.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`‘’“”]+|["'`‘’“”]+$/g, '')
    .replace(/[\s.,;:!?-]+$/, '')
    .trim();
}

/**
 * Truncation by code POINT, not code unit, so a cap can never cut a surrogate
 * pair in half and leave a lone surrogate in a title. (`String.toWellFormed` is
 * ES2024, past this project's lib.)
 */
const clamp = (text: string, limit: number): string =>
  text.length <= limit ? text : [...text].slice(0, limit).join('');

const str = (value: unknown, limit: number): string =>
  typeof value === 'string' ? clamp(value.trim(), limit).trim() : '';

/**
 * A stated estimate, or null. Rounded FIRST and only then required to be
 * positive: rounding a fraction such as 0.4 afterwards would produce the very
 * zero this rejects, and a zero reaching the task-priority formula is a bug.
 */
const estimate = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const minutes = Math.round(value);
  if (minutes <= 0 || minutes > MAX_ESTIMATED_MINUTES) return null;
  return minutes;
};

/**
 * Whether a resolved instant could belong to the term that starts at `termStart`.
 *
 * Exported because the guard is worthless if only one place applies it: the
 * review screen re-reads `rawDate` whenever a row has no date, so it must reject
 * the same dates this does, or a year the model fabricated ("due Oct 15, 1823")
 * reappears there pre-ticked for the calendar write.
 */
export function isPlausibleDueAt(at: number, termStart: number): boolean {
  return at >= termStart - EARLIEST_BEFORE_TERM && at <= termStart + LATEST_AFTER_TERM;
}

/**
 * A date the model resolved but that cannot belong to this term is treated as
 * unreadable, not written: a fabricated year on a real calendar is the worst
 * failure this feature has. Null sends it to the review table as undated, which
 * is the designed remedy (A27).
 */
const plausible = (at: number | null, termStart: number): number | null =>
  at !== null && isPlausibleDueAt(at, termStart) ? at : null;

/**
 * J7: this import creates assignment deadlines only. The label is trimmed and
 * lowercased before comparing, because title-casing an enum value is a routine
 * model deviation and dropping a real deadline over it is the worst direction to
 * fail in. An absent or unusable label is read as a deadline.
 */
const isDeadline = (value: unknown): boolean => {
  const kind = str(value, MAX_TITLE).toLowerCase();
  return kind === '' || kind === 'deadline';
};

/**
 * The mandatory `validate` for the extraction call (architecture §6.4: a model's
 * JSON is untrusted input). A non-array is a failure - the model did not answer
 * the question - but a bad row inside a good array is simply dropped, so one
 * malformed entry does not lose a whole syllabus.
 */
export function parseAssignments(value: unknown, ctx: ResolveContext): ExtractedAssignment[] {
  if (!Array.isArray(value)) {
    throw new Error('The model did not return a JSON array of assignments');
  }

  const rows: ExtractedAssignment[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;

    const title = str(row.title, MAX_TITLE);
    if (title === '') continue;
    if (!isDeadline(row.kind)) continue;

    const rawDate = str(row.dueDate, MAX_RAW_DATE);
    rows.push({
      title,
      dueAt:
        rawDate === ''
          ? null
          : plausible(resolveDueDate(rawDate, ctx.termStart, ctx.now), ctx.termStart),
      rawDate,
      estimatedMinutes: estimate(row.estimatedMinutes),
      notes: str(row.notes, MAX_NOTES),
    });
  }
  return rows;
}

/**
 * Escapes `%` first, then the `|` that separates the key's parts, so a title
 * containing the literal `|raw:` cannot be read as a part boundary and collide
 * with a different row. Same reasoning as `sourceRef`'s own escaping.
 */
const escapeKeyPart = (part: string): string => part.replace(/%/g, '%25').replace(/\|/g, '%7C');

/**
 * The identity two chunks must agree on, and the same notion of "the same day"
 * that `sourceRefFor` uses (A26) - deliberately shared via `day.ts`, because
 * keying on the instant here would leave two review rows for one assignment that
 * the write then collapses into one event. A resolved date fixes the day, so
 * "Oct 15", "October 15", "10/15" and "Oct 15 11:59pm" are one assignment; only
 * an unresolved date leaves `rawDate` as the discriminator.
 */
const dedupeKey = (row: ExtractedAssignment): string => {
  const title = escapeKeyPart(normalizeTitle(row.title));
  return row.dueAt === null
    ? `${title}|raw:${escapeKeyPart(normalizeTitle(row.rawDate))}`
    : `${title}|day:${localDayKey(row.dueAt)}`;
};

/**
 * Chunks overlap, so the same assignment can be reported twice. The first row
 * wins on title and date, but a later duplicate fills in detail the first one
 * lacked: one chunk may read "Essay 1, Oct 15" where the next reads "Essay 1,
 * Oct 15, 180 minutes", and discarding the richer reading loses real information.
 */
export function dedupeAssignments(rows: ExtractedAssignment[]): ExtractedAssignment[] {
  const first = new Map<string, ExtractedAssignment>();
  const out: ExtractedAssignment[] = [];
  for (const row of rows) {
    const key = dedupeKey(row);
    const kept = first.get(key);
    if (kept === undefined) {
      // Copied, so merging never mutates the caller's rows.
      const copy = { ...row };
      first.set(key, copy);
      out.push(copy);
      continue;
    }
    if (kept.estimatedMinutes === null && row.estimatedMinutes !== null) {
      kept.estimatedMinutes = row.estimatedMinutes;
    }
    if (kept.notes === '' && row.notes !== '') kept.notes = row.notes;
  }
  return out;
}
