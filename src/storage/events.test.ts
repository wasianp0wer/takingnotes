import { beforeEach, describe, expect, it } from 'vitest';

import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  listEventsBetween,
  updateEvent,
} from '@/storage/events';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('events repository', () => {
  it('creates an event with sensible defaults', async () => {
    const event = await createEvent({ title: 'Essay due', kind: 'deadline', startsAt: 5_000 });

    expect(event.id).toBeTruthy();
    expect(event.kind).toBe('deadline');
    expect(event.startsAt).toBe(5_000);
    expect(event.endsAt).toBeNull();
    expect(event.allDay).toBe(false);
    expect(event.required).toBe(true);
    // A14: an unset estimate is 60 minutes.
    expect(event.estimatedMinutes).toBe(60);
    expect(event.notes).toBe('');
    expect(event.source).toBe('manual');
    expect(event.sourceRef).toBeNull();
    expect(event.createdAt).toBeGreaterThan(0);
    expect(event.updatedAt).toBe(event.createdAt);
    expect(await getEvent(event.id)).toEqual(event);
  });

  it('keeps the fields a syllabus import needs for idempotent re-import', async () => {
    const event = await createEvent({
      title: 'Problem set 2',
      kind: 'deadline',
      startsAt: 1,
      source: 'syllabus',
      sourceRef: 'syllabus:ps2',
      allDay: true,
      required: false,
      estimatedMinutes: 120,
      notes: 'chapters 3-4',
    });

    expect(event.source).toBe('syllabus');
    expect(event.sourceRef).toBe('syllabus:ps2');
    expect(event.allDay).toBe(true);
    expect(event.required).toBe(false);
    expect(event.estimatedMinutes).toBe(120);
    expect(event.notes).toBe('chapters 3-4');
  });

  it('returns undefined for an unknown id', async () => {
    expect(await getEvent('missing')).toBeUndefined();
  });

  it('applies a partial update and bumps updatedAt', async () => {
    const created = await createEvent({
      title: 'Draft',
      kind: 'event',
      startsAt: 1,
      createdAt: 10,
      updatedAt: 10,
    });
    const updated = await updateEvent(created.id, { title: 'Renamed' });

    expect(updated.title).toBe('Renamed');
    expect(updated.createdAt).toBe(10);
    expect(updated.updatedAt).toBeGreaterThan(10);
    expect(await getEvent(created.id)).toEqual(updated);
  });

  it('lets a caller pin updatedAt explicitly', async () => {
    const created = await createEvent({ title: 'Pinned', kind: 'event', startsAt: 1 });
    const updated = await updateEvent(created.id, { title: 'x', updatedAt: 123 });
    expect(updated.updatedAt).toBe(123);
  });

  it('throws when updating an unknown id', async () => {
    await expect(updateEvent('missing', { title: 'x' })).rejects.toThrow('missing');
  });

  it('persists both writes when two event updates race', async () => {
    const created = await createEvent({ title: 'Race', kind: 'event', startsAt: 1 });

    await Promise.all([
      updateEvent(created.id, { title: 'renamed' }),
      updateEvent(created.id, { notes: 'noted' }),
    ]);

    const loaded = await getEvent(created.id);
    expect(loaded?.title).toBe('renamed');
    expect(loaded?.notes).toBe('noted');
  });

  it('lists events in calendar order, earliest first', async () => {
    const late = await createEvent({ title: 'Late', kind: 'event', startsAt: 3_000 });
    const early = await createEvent({ title: 'Early', kind: 'event', startsAt: 1_000 });

    expect((await listEvents()).map((e) => e.id)).toEqual([early.id, late.id]);
  });

  it('lists events within an inclusive window', async () => {
    await createEvent({ title: 'Before', kind: 'event', startsAt: 999 });
    const from = await createEvent({ title: 'At from', kind: 'event', startsAt: 1_000 });
    const mid = await createEvent({ title: 'Middle', kind: 'event', startsAt: 1_500 });
    const to = await createEvent({ title: 'At to', kind: 'event', startsAt: 2_000 });
    await createEvent({ title: 'After', kind: 'event', startsAt: 2_001 });

    const window = await listEventsBetween(1_000, 2_000);
    expect(window.map((e) => e.id)).toEqual([from.id, mid.id, to.id]);
  });

  it('deletes an event', async () => {
    const created = await createEvent({ title: 'Doomed', kind: 'event', startsAt: 1 });
    await deleteEvent(created.id);
    expect(await getEvent(created.id)).toBeUndefined();
    await expect(deleteEvent('missing')).resolves.toBeUndefined();
  });
});
