import { describe, expect, it, vi } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import { AGENDA_DAYS, CalendarPanel } from '@/triage/CalendarPanel';
import { click, mount, typeInto } from '@/triage/testing';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

const NOW = at(2026, 8, 28, 15); // Monday 28 Sep 2026, 15:00

function event(overrides: Partial<CalendarEventRecord> & Pick<CalendarEventRecord, 'id' | 'title' | 'startsAt'>): CalendarEventRecord {
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

const DEADLINE_SEP29 = event({ id: 'e1', title: 'Essay due', kind: 'deadline', startsAt: at(2026, 8, 29, 10) });
const ALLDAY_SEP29 = event({ id: 'e2', title: 'Family visit', kind: 'event', startsAt: at(2026, 8, 29), allDay: true });
const EVENT_OCT5 = event({ id: 'e3', title: 'Study group', kind: 'event', startsAt: at(2026, 9, 5, 14) });
const DEADLINE_OCT6 = event({ id: 'e4', title: 'Term paper due', kind: 'deadline', startsAt: at(2026, 9, 6, 9) });
const EVENT_SEP2 = event({ id: 'e5', title: 'Concert', kind: 'event', startsAt: at(2026, 8, 2, 19) });

const EVENTS = [DEADLINE_SEP29, ALLDAY_SEP29, EVENT_OCT5, DEADLINE_OCT6, EVENT_SEP2];

describe('CalendarPanel', () => {
  it('AGENDA_DAYS is 8 (today plus the next 7 days)', () => {
    expect(AGENDA_DAYS).toBe(8);
  });

  it('shows the month title, weekday headers, dots per day and today ring', () => {
    const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);

    expect(m.container.textContent).toContain('September 2026');
    for (const wd of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(m.container.textContent).toContain(wd);
    }

    const sep29 = m.container.querySelector('[data-day="2026-09-29"]')!;
    expect(sep29.querySelectorAll('[data-dot="deadline"]')).toHaveLength(1);
    expect(sep29.querySelectorAll('[data-dot="event"]')).toHaveLength(1);

    const sep02 = m.container.querySelector('[data-day="2026-09-02"]')!;
    expect(sep02.querySelectorAll('[data-dot="event"]')).toHaveLength(1);
    expect(sep02.querySelectorAll('[data-dot="deadline"]')).toHaveLength(0);

    const sep28 = m.container.querySelector('[data-day="2026-09-28"]')!;
    expect(sep28.getAttribute('aria-current')).toBe('date');

    m.unmount();
  });

  it('caps the dots on a busy day without ever dropping the deadline dot', () => {
    // As `listEvents` returns them: ascending by startsAt, deadline last.
    const busyDay = [
      event({ id: 'b1', title: 'Class', startsAt: at(2026, 8, 30, 8) }),
      event({ id: 'b2', title: 'Lab', startsAt: at(2026, 8, 30, 9) }),
      event({ id: 'b3', title: 'Coffee', startsAt: at(2026, 8, 30, 10) }),
      event({ id: 'b4', title: 'Thesis chapter due', kind: 'deadline', startsAt: at(2026, 8, 30, 18) }),
    ];
    const m = mount(
      <CalendarPanel events={busyDay} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
    );

    const cell = m.container.querySelector('[data-day="2026-09-30"]')!;
    // Four events, and the cell still shows at most MAX_DOTS (3) dots...
    expect(cell.querySelectorAll('[data-dot]')).toHaveLength(3);
    // ...but the one that must never be the one dropped is the deadline's:
    // past the agenda's 8 days it is the only signal the user gets.
    expect(cell.querySelectorAll('[data-dot="deadline"]')).toHaveLength(1);

    m.unmount();
  });

  it('agenda shows Tomorrow, the day-7 event, and excludes the day-8 event; all-day sorts before timed', () => {
    const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);

    const agenda = m.container.querySelector('section[aria-label="Agenda"]')!;
    expect(agenda.textContent).toContain('Tomorrow');
    expect(agenda.textContent).toContain('Study group');
    expect(agenda.textContent).not.toContain('Term paper due');

    const itemTexts = [...agenda.querySelectorAll('li button')].map((el) => el.textContent ?? '');
    const familyIdx = itemTexts.findIndex((t) => t.includes('Family visit'));
    const essayIdx = itemTexts.findIndex((t) => t.includes('Essay due'));
    expect(familyIdx).toBeGreaterThanOrEqual(0);
    expect(essayIdx).toBeGreaterThanOrEqual(0);
    expect(familyIdx).toBeLessThan(essayIdx);

    m.unmount();
  });

  it('agenda says nothing is in the next 7 days when there are no events', () => {
    const m = mount(<CalendarPanel events={[]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);
    const agenda = m.container.querySelector('section[aria-label="Agenda"]')!;
    expect(agenda.textContent).toContain('Nothing in the next 7 days.');
    m.unmount();
  });

  it('Next month advances to October and shows the day-8 deadline dot there', async () => {
    const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);

    await click(m.container.querySelector('[aria-label="Next month"]')!);

    expect(m.container.textContent).toContain('October 2026');
    const oct06 = m.container.querySelector('[data-day="2026-10-06"]')!;
    expect(oct06.querySelectorAll('[data-dot="deadline"]')).toHaveLength(1);

    m.unmount();
  });

  it('clicking a day cell opens the create dialog prefilled with that day', async () => {
    const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);

    await click(m.container.querySelector('[data-day="2026-09-30"]')!);

    expect(document.body.textContent).toContain('New event');
    const dateInput = document.body.querySelector('[aria-label="Date"]') as HTMLInputElement;
    expect(dateInput.value).toBe('2026-09-30');

    m.unmount();
  });

  it('clicking an agenda item opens the edit dialog for that event', async () => {
    const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);

    const agenda = m.container.querySelector('section[aria-label="Agenda"]')!;
    const item = [...agenda.querySelectorAll('li button')].find((el) => el.textContent?.includes('Essay due'))!;
    await click(item);

    expect(document.body.textContent).toContain('Edit event');
    const titleInput = document.body.querySelector('[aria-label="Title"]') as HTMLInputElement;
    expect(titleInput.value).toBe('Essay due');

    m.unmount();
  });

  it('the header New event button opens the create dialog for today', async () => {
    const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);

    const newEventButton = [...m.container.querySelectorAll('button')].find((b) => b.textContent === 'New event')!;
    await click(newEventButton);

    expect(document.body.textContent).toContain('New event');
    const dateInput = document.body.querySelector('[aria-label="Date"]') as HTMLInputElement;
    expect(dateInput.value).toBe('2026-09-28');

    m.unmount();
  });

  it('saving from the dialog calls onSaveEvent with the value and null id for a new event', async () => {
    const onSaveEvent = vi.fn(async () => {});
    const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={onSaveEvent} onDeleteEvent={vi.fn(async () => {})} />);

    await click(m.container.querySelector('[data-day="2026-09-30"]')!);
    const titleInput = document.body.querySelector('[aria-label="Title"]') as HTMLInputElement;
    typeInto(titleInput, 'Buy supplies');

    const saveButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    await click(saveButton);

    expect(onSaveEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'Buy supplies' }), null);

    m.unmount();
  });

  it('deleting from the edit dialog calls onDeleteEvent with the event id', async () => {
    const onDeleteEvent = vi.fn(async () => {});
    const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={onDeleteEvent} />);

    const agenda = m.container.querySelector('section[aria-label="Agenda"]')!;
    const item = [...agenda.querySelectorAll('li button')].find((el) => el.textContent?.includes('Essay due'))!;
    await click(item);

    const deleteButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!;
    await click(deleteButton);

    expect(onDeleteEvent).toHaveBeenCalledWith('e1');

    m.unmount();
  });
});
