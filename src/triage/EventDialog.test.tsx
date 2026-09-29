import { describe, expect, it, vi } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import { emptyEventForm, eventFormFromRecord } from '@/triage/eventForm';
import { EventDialog } from '@/triage/EventDialog';
import { click, mount, typeInto, waitFor } from '@/triage/testing';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

const DAY_MS = at(2026, 8, 30); // Wed 30 Sep 2026, local midnight

function noop() {}

function findByText(tag: string, text: string): HTMLElement {
  const el = [...document.body.querySelectorAll(tag)].find((e) => e.textContent === text);
  if (!el) throw new Error(`no <${tag}> with text "${text}"`);
  return el as HTMLElement;
}

function makeEvent(overrides: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id: 'evt-1',
    title: 'Problem set 3',
    kind: 'deadline',
    startsAt: at(2026, 8, 29, 14, 30),
    endsAt: null,
    allDay: false,
    required: true,
    estimatedMinutes: 90,
    notes: 'bring calculator',
    source: 'manual',
    sourceRef: null,
    createdAt: DAY_MS,
    updatedAt: DAY_MS,
    ...overrides,
  };
}

describe('EventDialog', () => {
  it('shows "New event" when creating', () => {
    const m = mount(
      <EventDialog
        open
        onOpenChange={noop}
        initial={emptyEventForm(DAY_MS)}
        eventId={null}
        onSave={async () => {}}
      />,
    );
    expect(document.body.textContent).toContain('New event');
    m.unmount();
  });

  it('create: typing a title and saving with defaults calls onSave with the expected value and closes', async () => {
    const onSave = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    const m = mount(
      <EventDialog
        open
        onOpenChange={onOpenChange}
        initial={emptyEventForm(DAY_MS)}
        eventId={null}
        onSave={onSave}
      />,
    );

    const titleInput = document.body.querySelector('[aria-label="Title"]') as HTMLInputElement;
    typeInto(titleInput, 'Turn in essay');

    await click(findByText('button', 'Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      title: 'Turn in essay',
      kind: 'deadline',
      startsAt: at(2026, 8, 30, 9),
      allDay: false,
      required: true,
      estimatedMinutes: 60,
      notes: '',
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    m.unmount();
  });

  it('empty title shows an alert and does not call onSave', async () => {
    const onSave = vi.fn(async () => {});
    const m = mount(
      <EventDialog open onOpenChange={noop} initial={emptyEventForm(DAY_MS)} eventId={null} onSave={onSave} />,
    );

    await click(findByText('button', 'Save'));

    await waitFor(() => {
      const alert = document.body.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe('Give it a title.');
    });
    expect(onSave).not.toHaveBeenCalled();

    m.unmount();
  });

  it('edit mode prefills from eventFormFromRecord, shows "Edit event" and a Delete button that calls onDelete', async () => {
    const event = makeEvent();
    const onDelete = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    const m = mount(
      <EventDialog
        open
        onOpenChange={onOpenChange}
        initial={eventFormFromRecord(event)}
        eventId={event.id}
        onSave={async () => {}}
        onDelete={onDelete}
      />,
    );

    expect(document.body.textContent).toContain('Edit event');
    const titleInput = document.body.querySelector('[aria-label="Title"]') as HTMLInputElement;
    expect(titleInput.value).toBe('Problem set 3');
    const dateInput = document.body.querySelector('[aria-label="Date"]') as HTMLInputElement;
    expect(dateInput.value).toBe('2026-09-29');
    const notes = document.body.querySelector('[aria-label="Notes"]') as HTMLTextAreaElement;
    expect(notes.value).toBe('bring calculator');

    await click(findByText('button', 'Delete'));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    m.unmount();
  });

  it('toggling All day hides the Time input', async () => {
    const m = mount(
      <EventDialog open onOpenChange={noop} initial={emptyEventForm(DAY_MS)} eventId={null} onSave={async () => {}} />,
    );

    expect(document.body.querySelector('[aria-label="Time"]')).not.toBeNull();
    const allDay = document.body.querySelector('input[type="checkbox"][aria-label="All day"]') as HTMLInputElement;
    await click(allDay);
    expect(document.body.querySelector('[aria-label="Time"]')).toBeNull();

    m.unmount();
  });

  it('a failed save keeps the dialog open with everything typed in it, and shows why', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSave = vi.fn().mockRejectedValue(new Error('storage full'));
    const onOpenChange = vi.fn();
    const m = mount(
      <EventDialog open onOpenChange={onOpenChange} initial={emptyEventForm(DAY_MS)} eventId={null} onSave={onSave} />,
    );

    const titleInput = document.body.querySelector('[aria-label="Title"]') as HTMLInputElement;
    typeInto(titleInput, 'Turn in essay');
    const notes = document.body.querySelector('[aria-label="Notes"]') as HTMLTextAreaElement;
    typeInto(notes, 'draft is in the blue folder');

    await click(findByText('button', 'Save'));

    await waitFor(() => {
      const alert = document.body.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe("Couldn't save this event — your changes are still here.");
    });
    // The dialog is the only copy of these values, so it must not close.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(titleInput.value).toBe('Turn in essay');
    expect(notes.value).toBe('draft is in the blue folder');
    // Save is usable again for a retry.
    expect((findByText('button', 'Save') as HTMLButtonElement).disabled).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('[triage] event save failed', expect.any(Error));

    consoleError.mockRestore();
    m.unmount();
  });

  it('disables Save while a save is in flight', async () => {
    let resolveSave: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const m = mount(
      <EventDialog open onOpenChange={noop} initial={emptyEventForm(DAY_MS)} eventId={null} onSave={onSave} />,
    );
    typeInto(document.body.querySelector('[aria-label="Title"]') as HTMLInputElement, 'Title');

    const saveButton = findByText('button', 'Save') as HTMLButtonElement;
    await click(saveButton);
    await waitFor(() => expect(saveButton.disabled).toBe(true));

    resolveSave();
    await waitFor(() => expect(saveButton.disabled).toBe(false));

    m.unmount();
  });
});
