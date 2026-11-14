import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FindableTranscript, findTextRanges } from '@/notes/TranscriptFind';

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

function render() {
  act(() =>
    root.render(
      <>
        <button type="button">elsewhere</button>
        <FindableTranscript>
          <p>
            The cat sat on <strong>the</strong> mat.
          </p>
          <p>And the dog.</p>
        </FindableTranscript>
      </>,
    ),
  );
  return container.querySelector('[data-transcript-find]') as HTMLElement;
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

function findInput(): HTMLInputElement | null {
  return container.querySelector('input[aria-label="Find in transcript"]');
}

function type(value: string) {
  const input = findInput()!;
  act(() => {
    // React tracks the last value it saw; set through the native setter so
    // the change event is not swallowed.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function count() {
  return container.querySelector('[data-find-count]')?.textContent;
}

describe('findTextRanges', () => {
  it('finds case-insensitive matches, including across element boundaries', () => {
    const el = document.createElement('div');
    el.innerHTML = 'The cat <b>sat</b> on th<i>e</i> mat';

    const ranges = findTextRanges(el, 'the');
    expect(ranges.map((r) => r.toString())).toEqual(['The', 'the']);
    expect(findTextRanges(el, 'cat sat').map((r) => r.toString())).toEqual(['cat sat']);
  });

  it('finds nothing for a blank query', () => {
    const el = document.createElement('div');
    el.textContent = 'anything';
    expect(findTextRanges(el, '   ')).toEqual([]);
  });
});

describe('FindableTranscript', () => {
  it('is focusable, so the shortcut has somewhere to land', () => {
    const transcript = render();
    expect(transcript.tabIndex).toBe(0);
  });

  it('opens the find bar on Ctrl+F while the transcript is focused, and stops the browser find', () => {
    const transcript = render();
    transcript.focus();

    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      transcript.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(findInput()).not.toBeNull();
    expect(document.activeElement).toBe(findInput());
  });

  it('opens on Cmd+F too', () => {
    const transcript = render();
    press(transcript, 'f', { metaKey: true });
    expect(findInput()).not.toBeNull();
  });

  it('ignores the shortcut when the focus is outside the transcript', () => {
    render();
    press(container.querySelector('button')!, 'f', { ctrlKey: true });
    expect(findInput()).toBeNull();
  });

  it('counts matches and steps through them with Enter and Shift+Enter, wrapping', () => {
    const transcript = render();
    press(transcript, 'f', { ctrlKey: true });

    type('the');
    expect(count()).toBe('1 of 3');

    press(findInput()!, 'Enter');
    expect(count()).toBe('2 of 3');
    press(findInput()!, 'Enter');
    press(findInput()!, 'Enter');
    expect(count()).toBe('1 of 3');
    press(findInput()!, 'Enter', { shiftKey: true });
    expect(count()).toBe('3 of 3');
  });

  it('says so when nothing matches', () => {
    const transcript = render();
    press(transcript, 'f', { ctrlKey: true });
    type('zebra');
    expect(count()).toBe('No matches');
  });

  it('closes on Escape and hands focus back to the transcript', () => {
    const transcript = render();
    press(transcript, 'f', { ctrlKey: true });
    type('the');

    press(findInput()!, 'Escape');

    expect(findInput()).toBeNull();
    expect(document.activeElement).toBe(transcript);
  });
});
