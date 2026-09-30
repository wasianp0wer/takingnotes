import type { CalendarEventRecord } from '@/storage/types';
import {
  localDateTimeFromInputs,
  toDateInputValue,
  toTimeInputValue,
} from '@/triage/dates';
import type { ExtractedAssignment } from '@/syllabus/assignments';
import { parseSyllabusDate } from '@/syllabus/dates';
import type { ConfirmedAssignment } from '@/syllabus/importAssignments';
import { sourceRefFor } from '@/syllabus/sourceRef';

/**
 * One row of the mandatory review table (A25). Dates and minutes are held as
 * `<input>` strings, because the user is editing them and a half-typed date is
 * not a number; `toConfirmed` is the single place they become a write.
 */
export interface ReviewRow {
  id: string;
  title: string;
  /** `YYYY-MM-DD`, or `''` when nothing could be resolved (A27). */
  dueDate: string;
  /** `HH:MM`, or `''` for an all-day deadline. */
  dueTime: string;
  required: boolean;
  estimatedMinutes: string;
  include: boolean;
  /** What the model read, so a term-start change can re-resolve it. */
  rawDate: string;
  notes: string;
  /** A previous import already wrote this row. */
  existing: boolean;
  /** The user has edited the date, so re-resolution must leave it alone. */
  edited: boolean;
}

/** A14: an unset estimate is 60 minutes. */
export const DEFAULT_ESTIMATED_MINUTES = 60;

/** A guard against a typo of many digits becoming a priority-warping estimate. */
export const MAX_ESTIMATED_MINUTES = 100_000;

function fields(raw: string, termStart: number, now: number): { dueDate: string; dueTime: string } {
  const parsed = raw.trim() === '' ? null : parseSyllabusDate(raw, termStart, now);
  if (parsed === null) return { dueDate: '', dueTime: '' };
  return {
    dueDate: toDateInputValue(parsed.at),
    dueTime: parsed.hasTime ? toTimeInputValue(parsed.at) : '',
  };
}

export function rowsFromExtracted(
  rows: ExtractedAssignment[],
  termStart: number,
  now: number,
): ReviewRow[] {
  return rows.map((row, index) => {
    // Prefer what the row already resolved to, and fall back to reading rawDate
    // so a stated time survives (P2-A6).
    const fromRaw = fields(row.rawDate, termStart, now);
    const dueDate = row.dueAt !== null ? toDateInputValue(row.dueAt) : fromRaw.dueDate;
    const dueTime = row.dueAt !== null ? fromRaw.dueTime : '';
    return {
      id: `row-${index}-${row.title.slice(0, 24)}`,
      title: row.title,
      dueDate,
      dueTime,
      required: true,
      estimatedMinutes: row.estimatedMinutes === null ? '' : String(row.estimatedMinutes),
      // A27: a row with no resolvable date is excluded until it has one.
      include: dueDate !== '',
      rawDate: row.rawDate,
      notes: row.notes,
      existing: false,
      edited: false,
    };
  });
}

/**
 * A new term start re-reads the rows the user has not touched. A row that gains
 * a date becomes includable; one that still has none stays excluded (A27).
 */
export function reresolveRows(rows: ReviewRow[], termStart: number, now: number): ReviewRow[] {
  return rows.map((row) => {
    if (row.edited) return row;
    const next = fields(row.rawDate, termStart, now);
    return { ...row, ...next, include: next.dueDate !== '' };
  });
}

export function markExisting(
  rows: ReviewRow[],
  events: readonly CalendarEventRecord[],
  importKey: string,
): ReviewRow[] {
  const refs = new Set(
    events
      .filter((event) => event.source === 'syllabus' && event.sourceRef !== null)
      .map((event) => event.sourceRef as string),
  );
  return rows.map((row) => ({
    ...row,
    existing: refs.has(sourceRefFor(importKey, { title: row.title, dueAt: rowDueAt(row) })),
  }));
}

/** The instant a row currently means, or null while its date is empty or invalid. */
export function rowDueAt(row: ReviewRow): number | null {
  if (row.dueDate === '') return null;
  return localDateTimeFromInputs(row.dueDate, row.dueTime);
}

function minutes(typed: string): number {
  const value = Number(typed.trim());
  if (typed.trim() === '' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_ESTIMATED_MINUTES;
  }
  return Math.min(Math.round(value), MAX_ESTIMATED_MINUTES);
}

/**
 * The rows that may be written. A row that is unticked, untitled, or has no
 * valid date is dropped here - which is what makes "excluded until it has a
 * date" (A27) true of the write and not only of the checkbox.
 */
export function toConfirmed(rows: readonly ReviewRow[]): ConfirmedAssignment[] {
  const out: ConfirmedAssignment[] = [];
  for (const row of rows) {
    if (!row.include) continue;
    const title = row.title.trim();
    if (title === '') continue;
    const dueAt = rowDueAt(row);
    if (dueAt === null) continue;
    out.push({
      title,
      dueAt,
      allDay: row.dueTime === '',
      required: row.required,
      estimatedMinutes: minutes(row.estimatedMinutes),
      notes: row.notes,
    });
  }
  return out;
}
