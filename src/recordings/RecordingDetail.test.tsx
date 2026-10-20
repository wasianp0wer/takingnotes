// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptionQueue } from '@/audio/transcriptionQueue';
import { RecordingDetail } from '@/recordings/RecordingDetail';
import { createRecording, getRecording, setRecordingTranscript } from '@/storage/recordings';
import type { RecordingRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

const idleState = {
  activeId: null,
  queuedIds: [],
  stage: null,
  progress: null,
  completedMs: null,
  durationMs: null,
  passes: null,
};

function fakeQueue(): TranscriptionQueue {
  return {
    subscribe: () => () => {},
    getState: () => idleState,
    retry: vi.fn(async () => true),
    pause: vi.fn(async () => {}),
  } as unknown as TranscriptionQueue;
}

async function flushAll(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function seed(): Promise<RecordingRecord> {
  return createRecording(
    { title: 'Lecture', durationMs: 65_000, startedAt: 1000, endedAt: 66_000 },
    new Blob(['audio-bytes'], { type: 'audio/webm' }),
  );
}

const queue = fakeQueue();

type Extra = Partial<Parameters<typeof RecordingDetail>[0]>;

function render(recording: RecordingRecord, extra: Extra = {}) {
  act(() => {
    root.render(
      <RecordingDetail recording={recording} queue={queue} onDelete={() => {}} {...extra} />,
    );
  });
}

describe('RecordingDetail seek request', () => {
  it('a seek request sets currentTime once per token', async () => {
    const recording = await seed();
    const onSeekApplied = vi.fn();
    render(recording, { seek: { token: 1, startMs: 42_000 }, onSeekApplied });
    await flushAll();
    const audio = container.querySelector('audio') as HTMLAudioElement;
    expect(audio.currentTime).toBe(42);
    expect(onSeekApplied).toHaveBeenCalledTimes(1);
    expect(onSeekApplied).toHaveBeenCalledWith(1);

    audio.currentTime = 0;
    render(recording, { seek: { token: 1, startMs: 42_000 }, onSeekApplied });
    await flushAll();
    expect(audio.currentTime).toBe(0);
    expect(onSeekApplied).toHaveBeenCalledTimes(1);

    render(recording, { seek: { token: 2, startMs: 42_000 }, onSeekApplied });
    await flushAll();
    expect(audio.currentTime).toBe(42);
    expect(onSeekApplied).toHaveBeenLastCalledWith(2);
  });
});

describe('RecordingDetail rename', () => {
  function titleButton(): HTMLButtonElement {
    return container.querySelector('button[title="Rename recording"]') as HTMLButtonElement;
  }
  function input(): HTMLInputElement {
    return container.querySelector('input[aria-label="Recording title"]') as HTMLInputElement;
  }
  function type(el: HTMLInputElement, value: string) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function key(el: HTMLElement, k: string) {
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
  }

  it('Enter saves the new title and calls onRenamed', async () => {
    const recording = await seed();
    const onRenamed = vi.fn();
    render(recording, { onRenamed });
    await flushAll();
    act(() => titleButton().click());
    type(input(), '  Week 3  ');
    key(input(), 'Enter');
    await flushAll();
    expect((await getRecording(recording.id))?.title).toBe('Week 3');
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(input()).toBeNull();
  });

  it('Escape cancels without saving', async () => {
    const recording = await seed();
    const onRenamed = vi.fn();
    render(recording, { onRenamed });
    await flushAll();
    act(() => titleButton().click());
    type(input(), 'Nope');
    key(input(), 'Escape');
    await flushAll();
    expect((await getRecording(recording.id))?.title).toBe('Lecture');
    expect(onRenamed).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it('rejects a blank title', async () => {
    const recording = await seed();
    const onRenamed = vi.fn();
    render(recording, { onRenamed });
    await flushAll();
    act(() => titleButton().click());
    type(input(), '   ');
    key(input(), 'Enter');
    await flushAll();
    expect((await getRecording(recording.id))?.title).toBe('Lecture');
    expect(onRenamed).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('blank');
    expect(input()).not.toBeNull();
  });
});

describe('RecordingDetail layout', () => {
  it('transcription status and controls render above the segment list', async () => {
    const recording = await seed();
    await setRecordingTranscript(recording.id, {
      status: 'paused',
      text: '',
      segments: [{ startMs: 1000, endMs: 2000, text: 'hello there' }],
      model: 'm',
      completedMs: 1000,
    } as never);
    const fresh = (await getRecording(recording.id))!;
    render(fresh);
    await flushAll();
    const text = container.textContent ?? '';
    expect(text.indexOf('Paused at')).toBeGreaterThan(-1);
    expect(text.indexOf('Paused at')).toBeLessThan(text.indexOf('hello there'));
    expect(text.indexOf('Resume')).toBeLessThan(text.indexOf('hello there'));
    expect(container.querySelector('button[data-start-ms]')?.className).toContain('text-timestamp');
  });
});
