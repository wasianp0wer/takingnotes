import { createEvent, listEvents, updateEvent } from '@/storage/events';
import { sourceRefFor } from '@/syllabus/sourceRef';

/** One review-table row the user ticked and confirmed. Its date is resolved by definition. */
export interface ConfirmedAssignment {
  title: string;
  dueAt: number;
  allDay: boolean;
  required: boolean;
  estimatedMinutes: number;
  notes: string;
}

export interface ImportResult {
  created: number;
  updated: number;
}

/**
 * Writes the confirmed rows as `kind: 'deadline'`, `source: 'syllabus'` events
 * (J7, architecture §6.5). A row whose `sourceRef` already exists updates that
 * event rather than adding a second one, so re-importing a syllabus is
 * idempotent.
 *
 * It does not generate tasks: `kind: 'deadline'` is all F3's
 * `syncTasksFromCalendar` needs, and the caller runs it afterwards.
 *
 * One import at a time, for the same reason `syncTasksFromCalendar` serializes:
 * a double-clicked Confirm or a StrictMode double-invoke would give two runs the
 * same "no event for this ref yet" answer and both would create one.
 */
let queue: Promise<unknown> = Promise.resolve();

export function importAssignments(
  rows: ConfirmedAssignment[],
  importKey: string,
): Promise<ImportResult> {
  const run = queue.then(() => runImport(rows, importKey));
  // The queue swallows the failure so one rejected import cannot wedge the next.
  queue = run.catch(() => undefined);
  return run;
}

async function runImport(
  rows: ConfirmedAssignment[],
  importKey: string,
): Promise<ImportResult> {
  if (rows.length === 0) return { created: 0, updated: 0 };

  // Before any write: a non-finite `startsAt` is not a valid IndexedDB key, so
  // the event would be stored yet absent from `listEvents`, leaving an orphan
  // that no re-import could ever match or clean up.
  for (const row of rows) {
    if (!Number.isFinite(row.dueAt)) {
      throw new Error(`Cannot import "${row.title}": its due date is not a finite timestamp`);
    }
  }

  const existing = new Map<string, string>();
  for (const event of await listEvents()) {
    // Only this import's own events: a manual event is never adopted (P2-A11),
    // however its title or `sourceRef` may happen to read.
    if (event.source === 'syllabus' && event.sourceRef !== null) {
      existing.set(event.sourceRef, event.id);
    }
  }

  const result: ImportResult = { created: 0, updated: 0 };
  for (const row of rows) {
    const sourceRef = sourceRefFor(importKey, row);
    /**
     * A re-import deliberately reverts these to the row's values, unlike task
     * sync, which preserves the user's `required` and estimate (A16). The
     * difference: task sync invented those numbers, whereas the user has just
     * confirmed every column of this row on the review screen, and a confirmed
     * edit that silently did nothing would be worse than an overwrite.
     */
    const fields = {
      title: row.title,
      kind: 'deadline' as const,
      startsAt: row.dueAt,
      allDay: row.allDay,
      required: row.required,
      estimatedMinutes: row.estimatedMinutes,
    };

    const found = existing.get(sourceRef);
    if (found !== undefined) {
      // `notes` is the exception: extraction leaves it empty when the syllabus
      // said nothing, which is an absence of information, not an instruction to
      // erase what the user wrote on this deadline. Clearing a note stays a
      // direct edit of the event.
      await updateEvent(found, row.notes === '' ? fields : { ...fields, notes: row.notes });
      result.updated += 1;
      continue;
    }
    const created = await createEvent({
      ...fields,
      notes: row.notes,
      source: 'syllabus',
      sourceRef,
    });
    // Writing the new id back is what makes a second row that collapses to the
    // same ref update this event instead of adding a duplicate.
    existing.set(sourceRef, created.id);
    result.created += 1;
  }
  return result;
}
