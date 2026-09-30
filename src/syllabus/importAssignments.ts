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
 */
export async function importAssignments(
  rows: ConfirmedAssignment[],
  importKey: string,
): Promise<ImportResult> {
  if (rows.length === 0) return { created: 0, updated: 0 };

  const existing = new Map<string, string>();
  for (const event of await listEvents()) {
    // Only this import's own events: a manual event is never adopted (P2-A11).
    if (event.source === 'syllabus' && event.sourceRef !== null) {
      existing.set(event.sourceRef, event.id);
    }
  }

  const result: ImportResult = { created: 0, updated: 0 };
  for (const row of rows) {
    const sourceRef = sourceRefFor(importKey, row);
    const fields = {
      title: row.title,
      kind: 'deadline' as const,
      startsAt: row.dueAt,
      allDay: row.allDay,
      required: row.required,
      estimatedMinutes: row.estimatedMinutes,
      notes: row.notes,
    };

    const found = existing.get(sourceRef);
    if (found !== undefined) {
      await updateEvent(found, fields);
      result.updated += 1;
      continue;
    }
    const created = await createEvent({ ...fields, source: 'syllabus', sourceRef });
    // Two rows in one batch can collapse to one ref; the second must update the
    // first, never create a duplicate.
    existing.set(sourceRef, created.id);
    result.created += 1;
  }
  return result;
}
