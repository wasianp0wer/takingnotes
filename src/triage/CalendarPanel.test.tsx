import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSettingValue } from '@/storage/settingKeys';
import type { CalendarEventRecord } from '@/storage/types';
import { CalendarPanel, candidateDaysForAgenda, parseAgendaDays } from '@/triage/CalendarPanel';
import { addLocalDays, startOfLocalDay } from '@/triage/dates';
import { click, flush, mount, typeInto, waitFor } from '@/triage/testing';
import { resetDatabase } from '@/test/resetDb';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

const NOW = at(2026, 8, 28, 15); // Monday 28 Sep 2026, 15:00
const HOUR = 3_600_000;

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

function blur(el: Element): void {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

const DEADLINE_SEP29 = event({ id: 'e1', title: 'Essay due', kind: 'deadline', startsAt: at(2026, 8, 29, 10) });
const ALLDAY_SEP29 = event({ id: 'e2', title: 'Family visit', kind: 'event', startsAt: at(2026, 8, 29), allDay: true });
const EVENT_OCT5 = event({ id: 'e3', title: 'Study group', kind: 'event', startsAt: at(2026, 9, 5, 14) });
const DEADLINE_OCT6 = event({ id: 'e4', title: 'Term paper due', kind: 'deadline', startsAt: at(2026, 9, 6, 9) });
const EVENT_SEP2 = event({ id: 'e5', title: 'Concert', kind: 'event', startsAt: at(2026, 8, 2, 19) });

const EVENTS = [DEADLINE_SEP29, ALLDAY_SEP29, EVENT_OCT5, DEADLINE_OCT6, EVENT_SEP2];

describe('parseAgendaDays (K23 custom horizon validation)', () => {
  it('rejects an empty string', () => expect(parseAgendaDays('')).toBeNull());
  it('rejects zero', () => expect(parseAgendaDays('0')).toBeNull());
  it('rejects a negative number', () => expect(parseAgendaDays('-5')).toBeNull());
  it('rejects a non-numeric string', () => expect(parseAgendaDays('abc')).toBeNull());
  it('rejects anything over 365', () => expect(parseAgendaDays('366')).toBeNull());
  it('accepts exactly 365', () => expect(parseAgendaDays('365')).toBe(365));
  it('accepts 1', () => expect(parseAgendaDays('1')).toBe(1));
  it('floors a fractional value that is still in range', () => expect(parseAgendaDays('7.9')).toBe(7));
  it('rejects a fractional value that floors to zero', () => expect(parseAgendaDays('0.5')).toBeNull());
  it('trims surrounding whitespace', () => expect(parseAgendaDays('  14  ')).toBe(14));
  it('rejects a literal "Infinity"', () => expect(parseAgendaDays('Infinity')).toBeNull());
});

describe('candidateDaysForAgenda (K23, K25)', () => {
  const today = startOfLocalDay(NOW);

  it('a finite agendaDays reproduces the old fixed 8-day window, independent of events', () => {
    const days = candidateDaysForAgenda([], today, 7);
    expect(days).toEqual(Array.from({ length: 8 }, (_, i) => addLocalDays(today, i)));
  });

  it('"All" (Infinity) with no events returns an empty list', () => {
    expect(candidateDaysForAgenda([], today, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('"All" includes every distinct day from today onward with an event, ascending, excluding yesterday', () => {
    const yesterday = event({ id: 'y', title: 'Yesterday', startsAt: addLocalDays(today, -1) + HOUR });
    const todayEvent = event({ id: 'd0', title: 'Today', startsAt: today + HOUR });
    const farEvent = event({ id: 'd40', title: 'Far', startsAt: addLocalDays(today, 40) + HOUR });
    const days = candidateDaysForAgenda([yesterday, todayEvent, farEvent], today, Number.POSITIVE_INFINITY);
    expect(days).toEqual([today, addLocalDays(today, 40)]);
  });

  it('two events on the same day produce that day once', () => {
    const a = event({ id: 'a', title: 'A', startsAt: today + HOUR });
    const b = event({ id: 'b', title: 'B', startsAt: today + 2 * HOUR });
    expect(candidateDaysForAgenda([a, b], today, Number.POSITIVE_INFINITY)).toEqual([today]);
  });
});

describe('CalendarPanel', () => {
  beforeEach(resetDatabase);

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

  describe('agenda horizon control (K23, K25)', () => {
    const today = startOfLocalDay(NOW);
    const DAY10_EVENT = event({ id: 'h10', title: 'Day ten workshop', startsAt: addLocalDays(today, 10) + 9 * HOUR });
    const DAY40_EVENT = event({ id: 'h40', title: 'Far future thing', startsAt: addLocalDays(today, 40) + 9 * HOUR });

    const PRESET_LABELS = ['3 days', '7 days', '14 days', '30 days', 'All'];

    it('shows all five presets and Custom…, with 7 days pressed by default on a fresh mount', () => {
      const m = mount(<CalendarPanel events={EVENTS} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);
      for (const label of [...PRESET_LABELS, 'Custom…']) {
        expect(m.container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
      }
      expect(m.container.querySelector('[aria-label="7 days"]')!.getAttribute('aria-pressed')).toBe('true');
      for (const label of ['3 days', '14 days', '30 days', 'All', 'Custom…']) {
        expect(m.container.querySelector(`[aria-label="${label}"]`)!.getAttribute('aria-pressed')).toBe('false');
      }
      m.unmount();
    });

    it('clicking 14 days reveals a previously-excluded day-10 event and updates pressed state', async () => {
      const m = mount(
        <CalendarPanel events={[...EVENTS, DAY10_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      const agenda = () => m.container.querySelector('section[aria-label="Agenda"]')!;
      expect(agenda().textContent).not.toContain('Day ten workshop');

      await click(m.container.querySelector('[aria-label="14 days"]')!);

      expect(agenda().textContent).toContain('Day ten workshop');
      expect(m.container.querySelector('[aria-label="14 days"]')!.getAttribute('aria-pressed')).toBe('true');
      expect(m.container.querySelector('[aria-label="7 days"]')!.getAttribute('aria-pressed')).toBe('false');
      m.unmount();
    });

    it('a chosen preset persists across a fresh mount (survives a reload)', async () => {
      const m1 = mount(
        <CalendarPanel events={[...EVENTS, DAY10_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      await click(m1.container.querySelector('[aria-label="14 days"]')!);
      await flush();
      expect(await getSettingValue('triage.agendaDays')).toBe(14);
      m1.unmount();

      const m2 = mount(
        <CalendarPanel events={[...EVENTS, DAY10_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      await waitFor(() => {
        expect(m2.container.querySelector('[aria-label="14 days"]')!.getAttribute('aria-pressed')).toBe('true');
      });
      expect(m2.container.querySelector('section[aria-label="Agenda"]')!.textContent).toContain('Day ten workshop');
      m2.unmount();
    });

    it('clicking All shows a day-40 event with no upper bound and persists', async () => {
      const m = mount(
        <CalendarPanel events={[...EVENTS, DAY40_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      await click(m.container.querySelector('[aria-label="All"]')!);

      expect(m.container.querySelector('section[aria-label="Agenda"]')!.textContent).toContain('Far future thing');
      expect(m.container.querySelector('[aria-label="All"]')!.getAttribute('aria-pressed')).toBe('true');
      await flush();
      expect(await getSettingValue('triage.agendaDays')).toBe(Number.POSITIVE_INFINITY);
      m.unmount();
    });

    it('the empty state for "All" reads "Nothing coming up."', async () => {
      const m = mount(<CalendarPanel events={[]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);
      await click(m.container.querySelector('[aria-label="All"]')!);
      expect(m.container.querySelector('section[aria-label="Agenda"]')!.textContent).toContain('Nothing coming up.');
      m.unmount();
    });

    it('empty-state copy is horizon-aware: "Nothing in the next 3 days." after selecting 3', async () => {
      const m = mount(<CalendarPanel events={[]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />);
      await click(m.container.querySelector('[aria-label="3 days"]')!);
      expect(m.container.querySelector('section[aria-label="Agenda"]')!.textContent).toContain('Nothing in the next 3 days.');
      m.unmount();
    });

    it('Custom… reveals a number input; committing a valid value applies, persists it, and unpresses every preset', async () => {
      const m = mount(
        <CalendarPanel events={[...EVENTS, DAY40_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      await click(m.container.querySelector('[aria-label="Custom…"]')!);
      const input = m.container.querySelector('[aria-label="Custom agenda days"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      typeInto(input, '45');
      blur(input);

      expect(m.container.querySelector('section[aria-label="Agenda"]')!.textContent).toContain('Far future thing');
      expect(m.container.querySelector('[aria-label="Custom…"]')!.getAttribute('aria-pressed')).toBe('true');
      for (const label of PRESET_LABELS) {
        expect(m.container.querySelector(`[aria-label="${label}"]`)!.getAttribute('aria-pressed')).toBe('false');
      }
      await flush();
      expect(await getSettingValue('triage.agendaDays')).toBe(45);
      m.unmount();
    });

    it('an invalid custom value shows an inline error, keeps the typed text, and leaves the active horizon unchanged', async () => {
      const m = mount(
        <CalendarPanel events={[...EVENTS, DAY10_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      await click(m.container.querySelector('[aria-label="Custom…"]')!);
      const input = m.container.querySelector('[aria-label="Custom agenda days"]') as HTMLInputElement;
      typeInto(input, '-5');
      blur(input);

      expect(m.container.textContent).toContain('Enter a whole number of days from 1 to 365.');
      expect(input.value).toBe('-5');
      // The previously-applied default (7) is still the active horizon.
      expect(m.container.querySelector('section[aria-label="Agenda"]')!.textContent).not.toContain('Day ten workshop');
      m.unmount();
    });

    it('typing into the custom field shows no error mid-typing, only once the field is committed', async () => {
      const m = mount(
        <CalendarPanel events={[...EVENTS, DAY10_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      await click(m.container.querySelector('[aria-label="Custom…"]')!);
      const input = m.container.querySelector('[aria-label="Custom agenda days"]') as HTMLInputElement;

      // "-5" typed one keystroke at a time: an intermediate "-" alone must
      // never commit (and so must never show an error) before the field is
      // actually committed via blur/Enter.
      typeInto(input, '-');
      expect(m.container.textContent).not.toContain('Enter a whole number');
      typeInto(input, '-5');
      expect(m.container.textContent).not.toContain('Enter a whole number');

      blur(input);
      expect(m.container.textContent).toContain('Enter a whole number of days from 1 to 365.');
      m.unmount();
    });

    it('a stored custom value is restored as Custom… (pressed, prefilled) on a fresh mount', async () => {
      const m1 = mount(
        <CalendarPanel events={[...EVENTS, DAY40_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      await click(m1.container.querySelector('[aria-label="Custom…"]')!);
      typeInto(m1.container.querySelector('[aria-label="Custom agenda days"]') as HTMLInputElement, '45');
      blur(m1.container.querySelector('[aria-label="Custom agenda days"]')!);
      await flush();
      m1.unmount();

      const m2 = mount(
        <CalendarPanel events={[...EVENTS, DAY40_EVENT]} now={NOW} onSaveEvent={vi.fn(async () => {})} onDeleteEvent={vi.fn(async () => {})} />,
      );
      await waitFor(() => {
        expect(m2.container.querySelector('[aria-label="Custom…"]')!.getAttribute('aria-pressed')).toBe('true');
      });
      expect((m2.container.querySelector('[aria-label="Custom agenda days"]') as HTMLInputElement).value).toBe('45');
      m2.unmount();
    });
  });
});
