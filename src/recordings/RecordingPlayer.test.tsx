// @vitest-environment happy-dom
import { act, createRef, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordingPlayer, effectiveDurationMs } from '@/recordings/RecordingPlayer';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let audioRef: RefObject<HTMLAudioElement | null>;
let playSpy: ReturnType<typeof vi.fn>;
const originalPlay = HTMLMediaElement.prototype.play;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  audioRef = createRef<HTMLAudioElement>();
  playSpy = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.play = playSpy as unknown as typeof HTMLMediaElement.prototype.play;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  HTMLMediaElement.prototype.play = originalPlay;
});

function render(props: Partial<Parameters<typeof RecordingPlayer>[0]> = {}) {
  act(() => {
    root.render(
      <RecordingPlayer src="blob:x" durationMs={90_000} audioRef={audioRef} {...props} />,
    );
  });
}

function audio(): HTMLAudioElement {
  return container.querySelector('audio') as HTMLAudioElement;
}

function byLabel(label: string): HTMLElement {
  const el = container.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no element labelled ${label}`);
  return el as HTMLElement;
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function fire(name: string) {
  act(() => {
    audio().dispatchEvent(new Event(name));
  });
}

function setTime(seconds: number) {
  audio().currentTime = seconds;
  fire('timeupdate');
}

describe('effectiveDurationMs', () => {
  it('falls back to the stored duration when the element reports none', () => {
    expect(effectiveDurationMs(Infinity, 90_000)).toBe(90_000);
    expect(effectiveDurationMs(NaN, 90_000)).toBe(90_000);
    expect(effectiveDurationMs(120, 90_000)).toBe(120_000);
  });
});

describe('RecordingPlayer', () => {
  it('renders the audio element without native controls and attaches the ref', () => {
    render();
    expect(audio()).toBeTruthy();
    expect(audio().hasAttribute('controls')).toBe(false);
    expect(audioRef.current).toBe(audio());
  });

  it('plays and pauses', () => {
    render();
    click(byLabel('Play'));
    expect(playSpy).toHaveBeenCalledTimes(1);
    fire('play');
    expect(container.querySelector('[aria-label="Pause"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Play"]')).toBeNull();
    fire('pause');
    expect(container.querySelector('[aria-label="Play"]')).toBeTruthy();
  });

  it('scrubs across the stored duration when the element reports none', () => {
    render();
    const slider = byLabel('Seek');
    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('aria-valuemax')).toBe('90');

    act(() => slider.focus());
    // Shift+Arrow steps ten seconds, Arrow one: 4 x 10 + 5 = 45.
    for (let i = 0; i < 4; i++) {
      act(() => {
        slider.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
        );
      });
    }
    for (let i = 0; i < 5; i++) {
      act(() => {
        slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
    }
    expect(audio().currentTime).toBe(45);
  });

  it('skips back and forward 15 seconds, clamped to the recording', () => {
    render();
    setTime(10);
    click(byLabel('Back 15 seconds'));
    expect(audio().currentTime).toBe(0);
    setTime(80);
    click(byLabel('Forward 15 seconds'));
    expect(audio().currentTime).toBe(90);
  });

  it('shows the elapsed and total time', () => {
    render();
    setTime(65);
    expect(container.textContent).toContain('1:05 / 1:30');
  });

  it('cycles the playback speed', () => {
    render();
    const speed = () => byLabel('Playback speed');
    expect(speed().textContent).toBe('1×');
    for (const [label, rate] of [
      ['1.25×', 1.25],
      ['1.5×', 1.5],
      ['2×', 2],
      ['0.75×', 0.75],
      ['1×', 1],
    ] as const) {
      click(speed());
      expect(speed().textContent).toBe(label);
      expect(audio().playbackRate).toBe(rate);
    }
  });

  it('offers a download only when given a handler', () => {
    render();
    expect(container.querySelector('[aria-label="Download audio"]')).toBeNull();
    const onDownload = vi.fn();
    render({ onDownload });
    click(byLabel('Download audio'));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});
