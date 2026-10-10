import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TagFilterBar } from '@/notes/TagFilterBar';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}
function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) {
    throw new Error(
      `no button ${text}; have ${JSON.stringify(buttons().map((b) => b.textContent?.trim()))}`,
    );
  }
  return found;
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('TagFilterBar', () => {
  it('renders nothing when there is no vocabulary and no selection', async () => {
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={[]}
          selected={[]}
          mode="or"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toBe('');
    expect(container.firstElementChild).toBeNull();
  });

  it('toggles a tag by calling onToggleTag', async () => {
    const onToggleTag = vi.fn();
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar', 'lecture']}
          selected={['seminar']}
          mode="or"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={onToggleTag}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });

    expect(buttonByText('seminar').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText('lecture').getAttribute('aria-pressed')).toBe('false');

    await click(buttonByText('lecture'));
    expect(onToggleTag).toHaveBeenCalledWith('lecture');
  });

  it('shows the AND/OR toggle only once two or more tags are selected', async () => {
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar', 'lecture']}
          selected={['seminar']}
          mode="or"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    expect(container.textContent).not.toContain('Match all');

    const onModeChange = vi.fn();
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar', 'lecture']}
          selected={['seminar', 'lecture']}
          mode="or"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={onModeChange}
          onClear={vi.fn()}
        />,
      );
    });
    expect(buttonByText('Match any').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText('Match all').getAttribute('aria-pressed')).toBe('false');
    await click(buttonByText('Match all'));
    expect(onModeChange).toHaveBeenCalledWith('and');
  });

  it('reflects mode "and" on the AND/OR toggle, not just "or"', async () => {
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar', 'lecture']}
          selected={['seminar', 'lecture']}
          mode="and"
          hiddenCount={0}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    expect(buttonByText('Match all').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText('Match any').getAttribute('aria-pressed')).toBe('false');
  });

  it('states the hidden count and offers Clear filter', async () => {
    const onClear = vi.fn();
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar']}
          selected={['seminar']}
          mode="or"
          hiddenCount={3}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={onClear}
        />,
      );
    });
    expect(container.textContent).toContain('3 notes hidden by this filter');
    await click(buttonByText('Clear filter'));
    expect(onClear).toHaveBeenCalled();
  });

  it('uses the singular for exactly one hidden note', async () => {
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar']}
          selected={['seminar']}
          mode="or"
          hiddenCount={1}
          activeNoteExempted={false}
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain('1 note hidden by this filter');
    expect(container.textContent).not.toContain('1 notes hidden');
  });

  it('states plainly when the active note is shown despite not matching', async () => {
    await act(async () => {
      root.render(
        <TagFilterBar
          vocabulary={['seminar']}
          selected={['seminar']}
          mode="or"
          hiddenCount={0}
          activeNoteExempted
          onToggleTag={vi.fn()}
          onModeChange={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("doesn't match this filter");
  });
});
