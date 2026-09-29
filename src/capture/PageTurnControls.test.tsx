import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { PageTurnControls } from '@/capture/PageTurnControls';
import { createStubCaptureEngine, type StubCaptureEngine } from '@/capture/pageTurnTestEngine';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: StubCaptureEngine;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createStubCaptureEngine();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render() {
  act(() => {
    root.render(
      <CaptureProvider engine={engine}>
        <PageTurnControls />
      </CaptureProvider>,
    );
  });
}

function button(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === 'New page');
  if (!found) throw new Error('no New page button');
  return found;
}

function indicator(): string {
  return container.querySelector('[role="status"]')?.textContent ?? '';
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function startNote() {
  await act(async () => {
    await engine.startNote();
  });
}

describe('PageTurnControls - New page button', () => {
  it('is disabled with no active note and enabled with one', async () => {
    render();
    expect(button().disabled).toBe(true);
    await startNote();
    expect(button().disabled).toBe(false);
  });

  it('calls newPage("manual") once per click', async () => {
    render();
    await startNote();
    await click(button());
    expect(engine.newPageCalls).toEqual(['manual']);
    expect(engine.getState().pageIndex).toBe(1);
  });

  it('is disabled while its newPage is pending, so a double click makes one page', async () => {
    render();
    await startNote();
    let finish: (id: string | null) => void = () => {};
    engine.newPageImpl = () => new Promise((resolve) => {
      finish = resolve;
    });

    await click(button());
    expect(button().disabled).toBe(true);
    await click(button());
    expect(engine.newPageCalls).toEqual(['manual']);

    await act(async () => {
      finish('page-x');
    });
    expect(button().disabled).toBe(false);
  });

  it('logs a failed newPage and re-enables the button', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render();
    await startNote();
    const failure = new Error('disk full');
    engine.newPageImpl = () => Promise.reject(failure);

    await click(button());

    expect(spy).toHaveBeenCalledWith('[page-turn] manual new page failed', failure);
    expect(button().disabled).toBe(false);
  });

  it('unmounting mid-request is quiet', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render();
    await startNote();
    let finish: (id: string | null) => void = () => {};
    engine.newPageImpl = () => new Promise((resolve) => {
      finish = resolve;
    });

    await click(button());
    act(() => root.unmount());
    await act(async () => {
      finish('page-x');
    });

    expect(spy).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});

describe('PageTurnControls - Page N indicator', () => {
  it('shows the new page number after a turn, whatever caused it', async () => {
    render();
    await startNote();
    expect(indicator()).toBe('');

    // A device turn: the engine changes page without the button.
    await act(async () => {
      await engine.newPage('device-turn');
    });
    expect(indicator()).toBe('Page 2');

    await click(button());
    expect(indicator()).toBe('Page 3');
  });

  it('does not show when a note starts', async () => {
    render();
    await startNote();
    expect(indicator()).toBe('');
  });

  it('hides after two seconds, and a new turn restarts the timer', async () => {
    vi.useFakeTimers();
    render();
    await startNote();

    await act(async () => {
      await engine.newPage('device-turn');
    });
    expect(indicator()).toBe('Page 2');

    act(() => vi.advanceTimersByTime(1500));
    await act(async () => {
      await engine.newPage('device-turn');
    });
    expect(indicator()).toBe('Page 3');

    act(() => vi.advanceTimersByTime(1500));
    expect(indicator()).toBe('Page 3');

    act(() => vi.advanceTimersByTime(500));
    expect(indicator()).toBe('');
  });

  it('still hides when the note ends while it is showing', async () => {
    vi.useFakeTimers();
    render();
    await startNote();
    await act(async () => {
      await engine.newPage('device-turn');
    });
    await act(async () => {
      await engine.endNote();
    });

    act(() => vi.advanceTimersByTime(2000));
    expect(indicator()).toBe('');
  });
});
