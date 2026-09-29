import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEvent, listEvents } from '@/storage/events';
import { resetDatabase } from '@/test/resetDb';
import { flush, mount, waitFor } from '@/triage/testing';
import { useTriageData, type TriageData } from '@/triage/useTriageData';

/**
 * `listEvents` delegates to the real repository unless a test overrides it
 * once, which is how the error-then-recovery case is provoked (mirrors
 * generateTasks.sync.test.ts).
 */
vi.mock('@/storage/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/events')>();
  return { ...actual, listEvents: vi.fn(actual.listEvents) };
});

const HOUR = 3_600_000;

beforeEach(resetDatabase);

let latest: TriageData;

function Probe({ syncIntervalMs }: { syncIntervalMs?: number }) {
  // eslint-disable-next-line react-hooks/globals -- test probe: exposes hook state for assertions outside render.
  latest = useTriageData({ syncIntervalMs });
  return (
    <ul data-testid="tasks">
      {latest.tasks.map((t) => (
        <li key={t.id}>
          {t.title}:{t.status}
        </li>
      ))}
    </ul>
  );
}

describe('useTriageData', () => {
  it('turns a stored deadline event into an open task after mount', async () => {
    await createEvent({ title: 'Essay', kind: 'deadline', startsAt: Date.now() + 24 * HOUR });

    const m = mount(<Probe />);
    await waitFor(() => {
      expect(latest.tasks.some((t) => t.title === 'Essay' && t.status === 'open')).toBe(true);
    });

    m.unmount();
    await flush();
  });

  it('picks up a repository change made directly, on window focus', async () => {
    const m = mount(<Probe />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    await createEvent({ title: 'Quiz', kind: 'deadline', startsAt: Date.now() + 24 * HOUR });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(latest.tasks.some((t) => t.title === 'Quiz' && t.status === 'open')).toBe(true);
    });

    m.unmount();
    await flush();
  });

  it('saveEvent creates an event and its generated task', async () => {
    const m = mount(<Probe />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    await act(async () => {
      await latest.saveEvent({
        title: 'Reading',
        kind: 'deadline',
        startsAt: Date.now() + 24 * HOUR,
        allDay: false,
        required: true,
        estimatedMinutes: 30,
        notes: '',
      });
    });

    expect(latest.events.some((e) => e.title === 'Reading')).toBe(true);
    expect(latest.tasks.some((t) => t.title === 'Reading' && t.status === 'open')).toBe(true);

    m.unmount();
    await flush();
  });

  it('saveEvent with an id updates the existing event', async () => {
    const event = await createEvent({
      title: 'Draft',
      kind: 'deadline',
      startsAt: Date.now() + 24 * HOUR,
    });
    const m = mount(<Probe />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    await act(async () => {
      await latest.saveEvent(
        {
          title: 'Final draft',
          kind: 'deadline',
          startsAt: event.startsAt,
          allDay: false,
          required: true,
          estimatedMinutes: 30,
          notes: '',
        },
        event.id,
      );
    });

    expect(latest.events).toHaveLength(1);
    expect(latest.events[0]?.title).toBe('Final draft');
    expect(latest.tasks.some((t) => t.title === 'Final draft' && t.status === 'open')).toBe(true);

    m.unmount();
    await flush();
  });

  it('removeEvent deletes the event and dismisses its task', async () => {
    const event = await createEvent({ title: 'Lab', kind: 'deadline', startsAt: Date.now() + 24 * HOUR });

    const m = mount(<Probe />);
    await waitFor(() => {
      expect(latest.tasks.some((t) => t.eventId === event.id && t.status === 'open')).toBe(true);
    });

    await act(async () => {
      await latest.removeEvent(event.id);
    });

    expect(latest.events.some((e) => e.id === event.id)).toBe(false);
    const task = latest.tasks.find((t) => t.eventId === event.id);
    expect(task?.status).toBe('dismissed');

    m.unmount();
    await flush();
  });

  it('completeTask sets status done with a completedAt', async () => {
    await createEvent({ title: 'Homework', kind: 'deadline', startsAt: Date.now() + 24 * HOUR });

    const m = mount(<Probe />);
    await waitFor(() => {
      expect(latest.tasks.some((t) => t.title === 'Homework' && t.status === 'open')).toBe(true);
    });
    const task = latest.tasks.find((t) => t.title === 'Homework')!;

    await act(async () => {
      await latest.completeTask(task.id);
    });

    const updated = latest.tasks.find((t) => t.id === task.id);
    expect(updated?.status).toBe('done');
    expect(typeof updated?.completedAt).toBe('number');

    m.unmount();
    await flush();
  });

  it('dismissTask sets status dismissed', async () => {
    const m = mount(<Probe />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    await act(async () => {
      await latest.addTask({ title: 'Manual task' });
    });
    const task = latest.tasks.find((t) => t.title === 'Manual task')!;

    await act(async () => {
      await latest.dismissTask(task.id);
    });

    const updated = latest.tasks.find((t) => t.id === task.id);
    expect(updated?.status).toBe('dismissed');

    m.unmount();
    await flush();
  });

  it('patchTask updates the given fields', async () => {
    const m = mount(<Probe />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    await act(async () => {
      await latest.addTask({ title: 'Read chapter 3' });
    });
    const task = latest.tasks.find((t) => t.title === 'Read chapter 3')!;

    await act(async () => {
      await latest.patchTask(task.id, { title: 'Read chapter 4', estimatedMinutes: 45 });
    });

    const updated = latest.tasks.find((t) => t.id === task.id);
    expect(updated?.title).toBe('Read chapter 4');
    expect(updated?.estimatedMinutes).toBe(45);

    m.unmount();
    await flush();
  });

  it('re-syncs on an interval and picks up a repository change', async () => {
    const m = mount(<Probe syncIntervalMs={30} />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    await createEvent({ title: 'Interval item', kind: 'deadline', startsAt: Date.now() + 24 * HOUR });

    await waitFor(() => {
      expect(latest.tasks.some((t) => t.title === 'Interval item' && t.status === 'open')).toBe(true);
    });

    m.unmount();
    await flush();
  });

  it('surfaces a refresh error and clears it on the next successful refresh', async () => {
    const m = mount(<Probe />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    vi.mocked(listEvents).mockRejectedValueOnce(new Error('storage offline'));
    await act(async () => {
      await latest.refresh();
    });
    await waitFor(() => expect(latest.error).toBe('storage offline'));

    await act(async () => {
      await latest.refresh();
    });
    await waitFor(() => expect(latest.error).toBeNull());

    m.unmount();
    await flush();
  });
});
