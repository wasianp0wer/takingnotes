import { beforeEach, describe, expect, it } from 'vitest';

import { createEvent, listEvents } from '@/storage/events';
import { importAssignments, type ConfirmedAssignment } from '@/syllabus/importAssignments';
import { sourceRefFor } from '@/syllabus/sourceRef';
import { resetDatabase } from '@/test/resetDb';

const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).getTime();

const KEY = 'file:hist101.pdf';

const row = (over?: Partial<ConfirmedAssignment>): ConfirmedAssignment => ({
  title: 'Essay 1',
  dueAt: local(2026, 10, 15),
  allDay: true,
  required: true,
  estimatedMinutes: 180,
  notes: '5 pages',
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
});

describe('importAssignments', () => {
  it('writes a deadline that carries the import’s identity', async () => {
    await expect(importAssignments([row()], KEY)).resolves.toEqual({ created: 1, updated: 0 });

    const [event] = await listEvents();
    expect(event).toMatchObject({
      title: 'Essay 1',
      kind: 'deadline',
      source: 'syllabus',
      sourceRef: sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15) }),
      startsAt: local(2026, 10, 15),
      allDay: true,
      required: true,
      estimatedMinutes: 180,
      notes: '5 pages',
    });
  });

  it('stores a timed row as not all-day, at its instant', async () => {
    await importAssignments([row({ dueAt: local(2026, 10, 15, 23, 59), allDay: false })], KEY);
    const [event] = await listEvents();
    expect(event.allDay).toBe(false);
    expect(event.startsAt).toBe(local(2026, 10, 15, 23, 59));
  });

  it('updates in place on a re-import instead of duplicating', async () => {
    await importAssignments([row(), row({ title: 'Midterm', dueAt: local(2026, 11, 2) })], KEY);
    const first = await listEvents();

    await expect(
      importAssignments([row({ estimatedMinutes: 240 }), row({ title: 'Midterm', dueAt: local(2026, 11, 2) })], KEY),
    ).resolves.toEqual({ created: 0, updated: 2 });

    const second = await listEvents();
    expect(second).toHaveLength(first.length);
    expect(second.map((e) => e.id).sort()).toEqual(first.map((e) => e.id).sort());
    expect(second.find((e) => e.title === 'Essay 1')?.estimatedMinutes).toBe(240);
  });

  it('creates a new event when the title was edited (A26)', async () => {
    await importAssignments([row()], KEY);
    await expect(importAssignments([row({ title: 'Essay one' })], KEY)).resolves.toEqual({
      created: 1,
      updated: 0,
    });
    expect(await listEvents()).toHaveLength(2);
  });

  it('collapses two rows that share one sourceRef within a single batch', async () => {
    await expect(
      importAssignments([row(), row({ estimatedMinutes: 240 })], KEY),
    ).resolves.toEqual({ created: 1, updated: 1 });

    const events = await listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].estimatedMinutes).toBe(240);
  });

  it('never adopts or modifies a manual event, whatever its title', async () => {
    const manual = await createEvent({
      title: 'Essay 1',
      kind: 'deadline',
      startsAt: local(2026, 10, 15),
      allDay: true,
    });

    await expect(importAssignments([row()], KEY)).resolves.toEqual({ created: 1, updated: 0 });

    const events = await listEvents();
    expect(events).toHaveLength(2);
    const untouched = events.find((e) => e.id === manual.id);
    expect(untouched).toMatchObject({ source: 'manual', sourceRef: null, estimatedMinutes: 60 });
  });

  it('writes nothing for an empty confirmation', async () => {
    await expect(importAssignments([], KEY)).resolves.toEqual({ created: 0, updated: 0 });
    expect(await listEvents()).toEqual([]);
  });

  it('separates two syllabuses that name an assignment the same', async () => {
    await importAssignments([row()], 'file:a.pdf');
    await expect(importAssignments([row()], 'file:b.pdf')).resolves.toEqual({
      created: 1,
      updated: 0,
    });
    expect(await listEvents()).toHaveLength(2);
  });
});
