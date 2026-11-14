import { describe, expect, it, vi } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import { DayEventsDialog } from '@/triage/DayEventsDialog';
import { click, mount } from '@/triage/testing';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

const NOW = at(2026, 8, 28, 15);
const DAY = at(2026, 8, 30); // Wed 30 Sep 2026

function event(
  overrides: Partial<CalendarEventRecord> & Pick<CalendarEventRecord, 'id' | 'title' | 'startsAt'>,
): CalendarEventRecord {
  return {
    kind: 'event',
    endsAt: null,
    allDay: false,
    required: true,
    estimatedMinutes: 60,
    notes: '',
    source: 'manual',
    sourceRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const LATE = event({ id: 'a', title: 'Late thing', startsAt: at(2026, 8, 30, 18) });
const EARLY = event({ id: 'b', title: 'Early thing', startsAt: at(2026, 8, 30, 8) });
const ALLDAY = event({ id: 'c', title: 'Whole day', startsAt: at(2026, 8, 30), allDay: true });
const OTHER = event({ id: 'd', title: 'Other day', startsAt: at(2026, 9, 1, 10) });

function render(day: number | null, events: CalendarEventRecord[], handlers = {}) {
  const props = { onClose: vi.fn(), onEdit: vi.fn(), onAdd: vi.fn(), ...handlers };
  const m = mount(<DayEventsDialog day={day} events={events} now={NOW} {...props} />);
  return { m, ...props };
}

describe('DayEventsDialog', () => {
  it('renders nothing when day is null', () => {
    const { m } = render(null, [LATE]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    m.unmount();
  });

  it('titles itself with the day label and lists only that day, in time order', () => {
    const { m } = render(DAY, [LATE, OTHER, EARLY]);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Wed 30 Sep');
    const items = [...dialog.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Early thing');
    expect(items[1]).toContain('Late thing');
    expect(dialog.textContent).not.toContain('Other day');
    m.unmount();
  });

  it('shows All day for an all-day event', () => {
    const { m } = render(DAY, [ALLDAY]);
    expect(document.body.querySelector('li')!.textContent).toContain('All day');
    m.unmount();
  });

  it('clicking an event calls onEdit with it', async () => {
    const { m, onEdit } = render(DAY, [EARLY]);
    await click(document.body.querySelector('li button')!);
    expect(onEdit).toHaveBeenCalledWith(EARLY);
    m.unmount();
  });

  it('Add event calls onAdd with the day', async () => {
    const { m, onAdd } = render(DAY, []);
    const add = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Add event')!;
    await click(add);
    expect(onAdd).toHaveBeenCalledWith(DAY);
    m.unmount();
  });

  it('shows Nothing on this day when empty', () => {
    const { m } = render(DAY, [OTHER]);
    expect(document.body.textContent).toContain('Nothing on this day');
    m.unmount();
  });
});
