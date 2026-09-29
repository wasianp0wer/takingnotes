import { beforeEach, describe, expect, it } from 'vitest';

import { createEvent } from '@/storage/events';
import { listTasks } from '@/storage/tasks';
import { resetDatabase } from '@/test/resetDb';
import { click, mount, typeInto, waitFor } from '@/triage/testing';
import { TriageView } from '@/triage/TriageView';

const HOUR = 3_600_000;

beforeEach(resetDatabase);

function section(container: HTMLElement, label: string): HTMLElement {
  const el = container.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`missing section "${label}"`);
  return el as HTMLElement;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`missing button "${text}"`);
  return found;
}

function buttonWithLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
  if (!found) throw new Error(`missing button labelled "${label}"`);
  return found;
}

describe('TriageView', () => {
  it('renders the three sections and shows a stored deadline event in Tasks and the Agenda', async () => {
    await createEvent({ title: 'Submit report', kind: 'deadline', startsAt: Date.now() + 24 * HOUR });

    const m = mount(<TriageView />);

    // All three panels exist immediately, before the async load resolves.
    expect(section(m.container, 'Tasks')).toBeTruthy();
    expect(section(m.container, 'Calendar')).toBeTruthy();
    expect(section(m.container, 'Scratchpad')).toBeTruthy();

    await waitFor(() => {
      expect(section(m.container, 'Tasks').textContent).toContain('Submit report');
    });
    expect(section(m.container, 'Calendar').textContent).toContain('Submit report');

    m.unmount();
  });

  it('promoting a scratchpad line adds an open task with source scratchpad', async () => {
    const m = mount(<TriageView />);

    await waitFor(() => {
      const textarea = m.container.querySelector('textarea[aria-label="Scratchpad"]') as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);
    });

    const textarea = m.container.querySelector('textarea[aria-label="Scratchpad"]') as HTMLTextAreaElement;
    typeInto(textarea, 'Buy milk');
    await click(buttonWithText(m.container, 'Promote line to task'));

    await waitFor(() => {
      expect(section(m.container, 'Tasks').textContent).toContain('Buy milk');
    });

    const tasks = await listTasks();
    const promoted = tasks.find((t) => t.title === 'Buy milk');
    expect(promoted?.source).toBe('scratchpad');

    m.unmount();
  });

  it('clicking Done removes the task from the list and stores it done with a numeric completedAt', async () => {
    await createEvent({ title: 'Submit report', kind: 'deadline', startsAt: Date.now() + 24 * HOUR });
    const m = mount(<TriageView />);

    await waitFor(() => {
      expect(section(m.container, 'Tasks').textContent).toContain('Submit report');
    });

    await click(buttonWithLabel(m.container, 'Done: Submit report'));

    await waitFor(() => {
      expect(section(m.container, 'Tasks').textContent).not.toContain('Submit report');
    });

    const tasks = await listTasks();
    const done = tasks.find((t) => t.title === 'Submit report');
    expect(done?.status).toBe('done');
    expect(typeof done?.completedAt).toBe('number');

    m.unmount();
  });
});
