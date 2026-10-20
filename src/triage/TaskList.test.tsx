import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { TaskRecord } from '@/storage/types';
import { endOfLocalDay, localDateTimeFromInputs } from '@/triage/dates';
import { rankTasks } from '@/triage/priority';
import { TaskList } from '@/triage/TaskList';
import { click, mount, typeInto, waitFor } from '@/triage/testing';

const NOW = new Date(2026, 8, 28, 9).getTime(); // Monday 28 Sep 2026, 09:00
const HOUR = 3_600_000;

function task(overrides: Partial<TaskRecord> & { id: string; title: string }): TaskRecord {
  return {
    required: true,
    estimatedMinutes: 60,
    dueAt: null,
    status: 'open',
    source: 'manual',
    eventId: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
}

const URGENT = task({ id: 'a', title: 'Urgent', required: true, dueAt: NOW + 2 * HOUR, estimatedMinutes: 240 });
const MEDIUM = task({ id: 'b', title: 'Medium', required: true, dueAt: NOW + 48 * HOUR, estimatedMinutes: 120 });
const LOW = task({ id: 'c', title: 'Low', required: false, dueAt: null, estimatedMinutes: 60 });
// Score 86 (I7 reference value): required, due in 12 h, 8 h estimate.
const AMBER_TASK = task({ id: 'f', title: 'Amber', required: true, dueAt: NOW + 12 * HOUR, estimatedMinutes: 480 });
// Score 200 (the cap): required, 100 h overdue, no estimate.
const RED_TASK = task({ id: 'g', title: 'Red', required: true, dueAt: NOW - 100 * HOUR, estimatedMinutes: 0 });

// Deliberately out of score order, so the test would fail if rankTasks were
// not actually applied to sort the rendered rows.
const FIXTURE_TASKS = [MEDIUM, URGENT, LOW];

function noop() {}

function blur(el: Element): void {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

/**
 * Async because the submit handler awaits `onAdd` before it decides whether to
 * clear the fields; a synchronous `act` would return before that decision.
 */
async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('TaskList', () => {
  it('renders rows in rankTasks score order with a score badge per row', () => {
    const m = mount(
      <TaskList tasks={FIXTURE_TASKS} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />,
    );

    const expected = rankTasks(FIXTURE_TASKS, NOW).map((r) => String(r.score));
    const badges = [...m.container.querySelectorAll('[data-testid="task-score"]')].map((e) => e.textContent);
    expect(badges).toEqual(expected);
    // Sanity: the fixture actually exercises a non-trivial order.
    expect(expected).toEqual(['108', '34', '5']);

    const rowIds = [...m.container.querySelectorAll('[data-task-id]')].map((e) => e.getAttribute('data-task-id'));
    expect(rowIds).toEqual(['a', 'b', 'c']);

    m.unmount();
  });

  describe('score band colour (K22)', () => {
    const BAND_CLASSES = ['text-score-red', 'text-score-orange', 'text-score-amber', 'text-score-lime', 'text-score-green'];
    const bandClassOf = (className: string): string | undefined => BAND_CLASSES.find((c) => className.includes(c));

    it('red: a score of 200 (the cap) gets text-score-red and no other band class', () => {
      const m = mount(<TaskList tasks={[RED_TASK]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
      const badge = m.container.querySelector('[data-testid="task-score"]')!;
      expect(badge.textContent).toBe('200');
      expect(bandClassOf(badge.className)).toBe('text-score-red');
      m.unmount();
    });

    it('orange: a score of 108 gets text-score-orange', () => {
      const m = mount(<TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
      const badge = m.container.querySelector('[data-testid="task-score"]')!;
      expect(badge.textContent).toBe('108');
      expect(bandClassOf(badge.className)).toBe('text-score-orange');
      m.unmount();
    });

    it('amber: a score of 86 gets text-score-amber', () => {
      const m = mount(<TaskList tasks={[AMBER_TASK]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
      const badge = m.container.querySelector('[data-testid="task-score"]')!;
      expect(badge.textContent).toBe('86');
      expect(bandClassOf(badge.className)).toBe('text-score-amber');
      m.unmount();
    });

    it('lime: a score of 34 gets text-score-lime', () => {
      const m = mount(<TaskList tasks={[MEDIUM]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
      const badge = m.container.querySelector('[data-testid="task-score"]')!;
      expect(badge.textContent).toBe('34');
      expect(bandClassOf(badge.className)).toBe('text-score-lime');
      m.unmount();
    });

    it('green: a score of 5 gets text-score-green', () => {
      const m = mount(<TaskList tasks={[LOW]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
      const badge = m.container.querySelector('[data-testid="task-score"]')!;
      expect(badge.textContent).toBe('5');
      expect(bandClassOf(badge.className)).toBe('text-score-green');
      m.unmount();
    });

    it('never applies the retired destructive badge treatment', () => {
      const m = mount(<TaskList tasks={[RED_TASK]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
      const badge = m.container.querySelector('[data-testid="task-score"]')!;
      expect(badge.className).not.toContain('bg-destructive');
      expect(badge.className).not.toContain('text-destructive');
      m.unmount();
    });

    it('the score chip keeps its neutral bg-secondary background in every band', () => {
      const m = mount(
        <TaskList tasks={[RED_TASK, URGENT, AMBER_TASK, MEDIUM, LOW]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />,
      );
      const badges = [...m.container.querySelectorAll('[data-testid="task-score"]')];
      expect(badges).toHaveLength(5);
      for (const b of badges) expect(b.className).toContain('bg-secondary');
      m.unmount();
    });
  });

  it('shows the empty state when there are no open tasks', () => {
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    expect(m.container.textContent).toContain('No open tasks.');
    m.unmount();
  });

  it('renders the Tasks heading', () => {
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    expect(m.container.textContent).toContain('Tasks');
    m.unmount();
  });

  it('clicking Done calls onComplete with the task id', async () => {
    const onComplete = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={noop} onComplete={onComplete} onDismiss={noop} />,
    );
    await click(m.container.querySelector(`[aria-label="Done: ${URGENT.title}"]`)!);
    expect(onComplete).toHaveBeenCalledWith('a');
    m.unmount();
  });

  it('clicking Dismiss calls onDismiss with the task id', async () => {
    const onDismiss = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={onDismiss} />,
    );
    await click(m.container.querySelector(`[aria-label="Dismiss: ${URGENT.title}"]`)!);
    expect(onDismiss).toHaveBeenCalledWith('a');
    m.unmount();
  });

  it('toggling the required button calls onPatch with the flipped value', async () => {
    const onPatch = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={onPatch} onComplete={noop} onDismiss={noop} />,
    );
    const toggle = m.container.querySelector('[aria-label="Required"]')!;
    expect(toggle.textContent).toBe('Required');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await click(toggle);
    expect(onPatch).toHaveBeenCalledWith('a', { required: false });
    m.unmount();
  });

  it('shows Optional for a non-required task', () => {
    const m = mount(<TaskList tasks={[LOW]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    const toggle = m.container.querySelector('[aria-label="Required"]')!;
    expect(toggle.textContent).toBe('Optional');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    m.unmount();
  });

  it('committing a valid estimate on blur calls onPatch with the rounded value', () => {
    const onPatch = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={onPatch} onComplete={noop} onDismiss={noop} />,
    );
    const input = m.container.querySelector('[aria-label="Estimate (minutes)"]') as HTMLInputElement;
    expect(input.value).toBe('240');
    typeInto(input, '90');
    blur(input);
    expect(onPatch).toHaveBeenCalledWith('a', { estimatedMinutes: 90 });
    m.unmount();
  });

  it('a fractional estimate commits rounded to the nearest minute', () => {
    const onPatch = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={onPatch} onComplete={noop} onDismiss={noop} />,
    );
    const input = m.container.querySelector('[aria-label="Estimate (minutes)"]') as HTMLInputElement;
    typeInto(input, '90.6');
    blur(input);
    expect(onPatch).toHaveBeenCalledWith('a', { estimatedMinutes: 91 });
    // The field keeps what was typed; it follows the stored value only once
    // the save round-trips back in as a changed prop.
    expect(input.value).toBe('90.6');
    m.unmount();
  });

  it('a fractional estimate that rounds back to the stored value reverts instead of patching', () => {
    const onPatch = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={onPatch} onComplete={noop} onDismiss={noop} />,
    );
    const input = m.container.querySelector('[aria-label="Estimate (minutes)"]') as HTMLInputElement;
    typeInto(input, '240.2');
    blur(input);
    expect(onPatch).not.toHaveBeenCalled();
    expect(input.value).toBe('240');
    m.unmount();
  });

  it('committing the unchanged estimate does not call onPatch', () => {
    const onPatch = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={onPatch} onComplete={noop} onDismiss={noop} />,
    );
    const input = m.container.querySelector('[aria-label="Estimate (minutes)"]') as HTMLInputElement;
    blur(input);
    expect(onPatch).not.toHaveBeenCalled();
    m.unmount();
  });

  it('an invalid (negative) estimate reverts to the stored value without calling onPatch', () => {
    const onPatch = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={onPatch} onComplete={noop} onDismiss={noop} />,
    );
    const input = m.container.querySelector('[aria-label="Estimate (minutes)"]') as HTMLInputElement;
    typeInto(input, '-3');
    blur(input);
    expect(onPatch).not.toHaveBeenCalled();
    expect(input.value).toBe('240');
    m.unmount();
  });

  it('pressing Enter in the estimate field commits like blur', () => {
    const onPatch = vi.fn();
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={onPatch} onComplete={noop} onDismiss={noop} />,
    );
    const input = m.container.querySelector('[aria-label="Estimate (minutes)"]') as HTMLInputElement;
    typeInto(input, '15');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onPatch).toHaveBeenCalledWith('a', { estimatedMinutes: 15 });
    m.unmount();
  });

  it('follows a stored estimate that changes after a save', () => {
    const m = mount(
      <TaskList tasks={[URGENT]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />,
    );
    const input = () => m.container.querySelector('[aria-label="Estimate (minutes)"]') as HTMLInputElement;
    expect(input().value).toBe('240');

    m.render(
      <TaskList
        tasks={[{ ...URGENT, estimatedMinutes: 90 }]}
        now={NOW}
        onAdd={noop}
        onPatch={noop}
        onComplete={noop}
        onDismiss={noop}
      />,
    );
    expect(input().value).toBe('90');
    m.unmount();
  });

  it('shows an overdue due label in the destructive color', () => {
    const overdue = task({ id: 'd', title: 'Late thing', dueAt: NOW - HOUR });
    const m = mount(<TaskList tasks={[overdue]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    const row = m.container.querySelector('[data-task-id="d"]')!;
    expect(row.textContent).toContain('Overdue');
    const dueEl = [...row.querySelectorAll('span')].find((el) => el.textContent?.startsWith('Overdue'));
    expect(dueEl?.className).toContain('text-destructive');
    m.unmount();
  });

  it('shows a source hint for calendar-sourced tasks but not manual ones', () => {
    const calendarTask = task({ id: 'e', title: 'From cal', source: 'calendar' });
    const m = mount(
      <TaskList tasks={[calendarTask, URGENT]} now={NOW} onAdd={noop} onPatch={noop} onComplete={noop} onDismiss={noop} />,
    );
    const calRow = m.container.querySelector('[data-task-id="e"]')!;
    const manualRow = m.container.querySelector('[data-task-id="a"]')!;
    expect(calRow.textContent).toContain('calendar');
    expect(manualRow.textContent).not.toContain('calendar');
    m.unmount();
  });

  it('add form: empty title shows an error and does not call onAdd', async () => {
    const onAdd = vi.fn();
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    const form = m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement;
    await submit(form);
    expect(m.container.textContent).toContain('Give the task a title.');
    expect(onAdd).not.toHaveBeenCalled();
    m.unmount();
  });

  it('add form: title with a date but no time defaults estimate to 60 and due to end of day', async () => {
    const onAdd = vi.fn();
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    const titleInput = m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement;
    const dateInput = m.container.querySelector('[aria-label="Due date"]') as HTMLInputElement;
    typeInto(titleInput, 'Read chapter 5');
    typeInto(dateInput, '2026-10-02');

    const form = m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement;
    await submit(form);

    const expectedDueAt = endOfLocalDay(localDateTimeFromInputs('2026-10-02', '')!);
    expect(onAdd).toHaveBeenCalledWith({
      title: 'Read chapter 5',
      dueAt: expectedDueAt,
      required: true,
      estimatedMinutes: 60,
      source: 'manual',
    });
    m.unmount();
  });

  it('add form: title with date and time uses the exact instant', async () => {
    const onAdd = vi.fn();
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    typeInto(m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement, 'Meet advisor');
    typeInto(m.container.querySelector('[aria-label="Due date"]') as HTMLInputElement, '2026-10-02');
    typeInto(m.container.querySelector('[aria-label="Due time"]') as HTMLInputElement, '14:30');

    await submit(m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement);

    const expectedDueAt = localDateTimeFromInputs('2026-10-02', '14:30');
    expect(onAdd).toHaveBeenCalledWith({
      title: 'Meet advisor',
      dueAt: expectedDueAt,
      required: true,
      estimatedMinutes: 60,
      source: 'manual',
    });
    m.unmount();
  });

  it('add form: no date at all means no due date', async () => {
    const onAdd = vi.fn();
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    typeInto(m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement, 'Someday task');
    await submit(m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement);
    expect(onAdd).toHaveBeenCalledWith({
      title: 'Someday task',
      dueAt: null,
      required: true,
      estimatedMinutes: 60,
      source: 'manual',
    });
    m.unmount();
  });

  it('add form: an empty estimate defaults to 60', async () => {
    const onAdd = vi.fn();
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    typeInto(m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement, 'Task with default estimate');
    await submit(m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ estimatedMinutes: 60 }));
    m.unmount();
  });

  it('add form: a negative estimate shows an error and does not call onAdd', async () => {
    const onAdd = vi.fn();
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    typeInto(m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement, 'Bad estimate task');
    typeInto(m.container.querySelector('[aria-label="New task estimate (minutes)"]') as HTMLInputElement, '-5');
    await submit(m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement);
    expect(onAdd).not.toHaveBeenCalled();
    expect(m.container.textContent).toMatch(/estimate/i);
    m.unmount();
  });

  it('add form: unchecking Required calls onAdd with required: false', async () => {
    const onAdd = vi.fn();
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    typeInto(m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement, 'Optional task');
    const checkbox = m.container.querySelector('input[type="checkbox"][aria-label="Required"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await click(checkbox);
    expect(checkbox.checked).toBe(false);

    await submit(m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ required: false }));
    m.unmount();
  });

  it('add form: clears every field after a successful add', async () => {
    const onAdd = vi.fn(async () => {});
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    const titleInput = m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement;
    const dateInput = m.container.querySelector('[aria-label="Due date"]') as HTMLInputElement;
    const timeInput = m.container.querySelector('[aria-label="Due time"]') as HTMLInputElement;
    const estimateInput = m.container.querySelector('[aria-label="New task estimate (minutes)"]') as HTMLInputElement;
    typeInto(titleInput, 'Task to reset');
    typeInto(dateInput, '2026-10-02');
    typeInto(timeInput, '14:30');
    typeInto(estimateInput, '45');

    await submit(m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement);

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(titleInput.value).toBe('');
    expect(dateInput.value).toBe('');
    expect(timeInput.value).toBe('');
    expect(estimateInput.value).toBe('');
    m.unmount();
  });

  it('add form: a failed add keeps every field the user typed and reports it in the form', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onAdd = vi.fn().mockRejectedValue(new Error('storage full'));
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    const titleInput = m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement;
    const dateInput = m.container.querySelector('[aria-label="Due date"]') as HTMLInputElement;
    const timeInput = m.container.querySelector('[aria-label="Due time"]') as HTMLInputElement;
    const estimateInput = m.container.querySelector('[aria-label="New task estimate (minutes)"]') as HTMLInputElement;
    typeInto(titleInput, 'Keep me');
    typeInto(dateInput, '2026-10-02');
    typeInto(timeInput, '14:30');
    typeInto(estimateInput, '45');

    await submit(m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement);

    // Nothing was saved, so the only copy of this input is the form itself.
    expect(titleInput.value).toBe('Keep me');
    expect(dateInput.value).toBe('2026-10-02');
    expect(timeInput.value).toBe('14:30');
    expect(estimateInput.value).toBe('45');
    expect(m.container.textContent).toContain("Couldn't add that task — your text is still here.");
    expect(consoleError).toHaveBeenCalledWith('[triage] add task failed', expect.any(Error));

    consoleError.mockRestore();
    m.unmount();
  });

  it('add form: guards against a double submit while onAdd is in flight', async () => {
    let resolveAdd: () => void = () => {};
    const onAdd = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const m = mount(<TaskList tasks={[]} now={NOW} onAdd={onAdd} onPatch={noop} onComplete={noop} onDismiss={noop} />);
    typeInto(m.container.querySelector('[aria-label="Task title"]') as HTMLInputElement, 'Double click me');

    const form = m.container.querySelector('form[aria-label="Add task"]') as HTMLFormElement;
    const submitButton = form.querySelector('button[type="submit"]') as HTMLButtonElement;

    await submit(form);
    await waitFor(() => expect(submitButton.disabled).toBe(true));

    // A second submit lands while the first write is still in flight.
    await submit(form);
    expect(onAdd).toHaveBeenCalledTimes(1);

    resolveAdd();
    await waitFor(() => expect(submitButton.disabled).toBe(false));

    m.unmount();
  });
});
