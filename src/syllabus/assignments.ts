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

/** Case- and whitespace-insensitive identity of a title, for dedupe and `sourceRef`. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.,;:!-]+$/, '').trim();
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

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

    const title = str(row.title);
    if (title === '') continue;

    // J7: this import creates assignment deadlines only. A row the model labelled
    // as something else is not ours to write.
    if (row.kind !== undefined && row.kind !== 'deadline') continue;

    const rawDate = str(row.dueDate);
    const minutes = row.estimatedMinutes;
    rows.push({
      title,
      dueAt: rawDate === '' ? null : resolveDueDate(rawDate, ctx.termStart, ctx.now),
      rawDate,
      estimatedMinutes:
        typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
          ? Math.round(minutes)
          : null,
      notes: str(row.notes),
    });
  }
  return rows;
}

/** Chunks overlap, so the same assignment can be reported twice. First wins. */
export function dedupeAssignments(rows: ExtractedAssignment[]): ExtractedAssignment[] {
  const seen = new Set<string>();
  const out: ExtractedAssignment[] = [];
  for (const row of rows) {
    const key = `${normalizeTitle(row.title)}|${row.rawDate.toLowerCase().trim()}|${row.dueAt ?? 'none'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
