import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptionQueue, TranscriptionQueueState } from '@/audio/transcriptionQueue';
import { RecordingsView } from '@/recordings/RecordingsView';
import { createRecording, setRecordingTranscript } from '@/storage/recordings';
import type { RecordingRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(async () => {
  await resetDatabase();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  let counter = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake-${counter++}`);
  URL.revokeObjectURL = vi.fn();
  window.confirm = () => true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

interface FakeQueue extends TranscriptionQueue {
  setState(patch: Partial<TranscriptionQueueState>): void;
  fireChange(id: string): void;
}

function createFakeQueue(initial: Partial<TranscriptionQueueState> = {}): FakeQueue {
  let state: TranscriptionQueueState = {
    activeId: null,
    stage: null,
    progress: null,
    queuedIds: [],
    ...initial,
  };
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(id: string) => void>();

  return {
    enqueue: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    subscribeChanges(fn) {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
    whenIdle: vi.fn(async () => {}),
    setState(patch) {
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn();
    },
    fireChange(id) {
      for (const fn of [...changeListeners]) fn(id);
    },
  };
}

function render(queue: TranscriptionQueue) {
  act(() => {
    root.render(<RecordingsView queue={queue} />);
  });
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function flushAll(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await flush();
  }
}

function blob(): Blob {
  return new Blob(['audio-bytes'], { type: 'audio/webm' });
}

async function seed(overrides: Partial<Parameters<typeof createRecording>[0]> = {}): Promise<RecordingRecord> {
  return createRecording(
    {
      title: 'Recording',
      durationMs: 65_000,
      startedAt: 1000,
      ...overrides,
    },
    blob(),
  );
}

function listButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('[data-recording-id]')] as HTMLButtonElement[];
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('RecordingsView', () => {
  it('lists recordings newest first and flags the one linked to a note', async () => {
    await seed({ title: 'First', startedAt: 1000, noteId: null });
    await seed({ title: 'Second', startedAt: 2000, noteId: 'note-1' });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    const buttons = listButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('Second');
    expect(buttons[0].textContent).toContain('Linked to note');
    expect(buttons[1].textContent).toContain('First');
    expect(buttons[1].textContent).not.toContain('Linked to note');
  });

  it("shows the selected recording's transcript segments and seeks on click", async () => {
    const recording = await seed({ title: 'Talk' });
    await setRecordingTranscript(recording.id, {
      text: 'hello world',
      segments: [
        { startMs: 0, endMs: 1000, text: 'hello' },
        { startMs: 65_000, endMs: 66_000, text: 'world' },
      ],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    const segmentButtons = [...container.querySelectorAll('[data-start-ms]')] as HTMLButtonElement[];
    expect(segmentButtons).toHaveLength(2);
    expect(segmentButtons[0].textContent).toContain('0:00');
    expect(segmentButtons[1].textContent).toContain('1:05');

    const audio = container.querySelector('audio') as HTMLAudioElement;
    expect(audio).toBeTruthy();

    await click(segmentButtons[1]);
    expect(audio.currentTime).toBe(65);
  });

  it('shows a failed transcript error and retries', async () => {
    const recording = await seed({ title: 'Broken' });
    await setRecordingTranscript(recording.id, {
      text: '',
      segments: [],
      model: 'Xenova/whisper-base.en',
      language: null,
      status: 'failed',
      error: 'Model download failed',
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Model download failed');

    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    expect(retry).toBeTruthy();
    await click(retry!);

    expect(queue.retry).toHaveBeenCalledWith(recording.id);
  });

  it('shows model download progress while loading', async () => {
    const recording = await seed({ title: 'Loading' });
    await setRecordingTranscript(recording.id, {
      text: '',
      segments: [],
      model: 'Xenova/whisper-base.en',
      language: null,
      status: 'running',
      error: null,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue({ activeId: recording.id, stage: 'loading', progress: 0.42 });

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('Downloading model 42%');
  });

  it('offers a retry for a recording stuck pending outside the queue', async () => {
    const recording = await seed({ title: 'Stuck' });
    await setRecordingTranscript(recording.id, {
      text: '',
      segments: [],
      model: 'Xenova/whisper-base.en',
      language: null,
      status: 'pending',
      error: null,
      updatedAt: Date.now(),
    });
    // Queue has no idea about this recording - neither active nor queued - as
    // would happen after a reload finds a `pending` row left by a crash.
    const queue = createFakeQueue({ activeId: null, queuedIds: [] });

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('Queued for transcription');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    expect(retry).toBeTruthy();
    await click(retry!);

    expect(queue.retry).toHaveBeenCalledWith(recording.id);
  });

  it('revokes object URLs on selection change and unmount', async () => {
    await seed({ title: 'A', startedAt: 2000 });
    await seed({ title: 'B', startedAt: 1000 });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    const firstUrl = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(firstUrl).toBeTruthy();

    const buttons = listButtons();
    const other = buttons.find((b) => b.textContent?.includes('B'))!;
    await click(other);
    await flushAll();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstUrl);

    const secondUrl = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    act(() => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(secondUrl);
    // Re-create so afterEach's unmount is a harmless no-op.
    root = createRoot(container);
  });

  it('deletes a recording, removing it from the store and the list', async () => {
    const recording = await seed({ title: 'DeleteMe' });

    const queue = createFakeQueue();
    render(queue);
    await flushAll();

    const deleteButton = container.querySelector('[aria-label="Delete recording"]') as HTMLButtonElement;
    expect(deleteButton).toBeTruthy();
    await click(deleteButton);
    await flushAll();

    expect(container.textContent).toContain('No recordings yet');
    const { getRecording } = await import('@/storage/recordings');
    expect(await getRecording(recording.id)).toBeUndefined();
  });

  it('reloads the list when the queue reports a change', async () => {
    const recording = await seed({ title: 'Changing' });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('Not transcribed');

    await setRecordingTranscript(recording.id, {
      text: 'done text',
      segments: [],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: Date.now(),
    });
    act(() => queue.fireChange(recording.id));
    await flushAll();

    expect(container.textContent).toContain('done text');
    expect(container.textContent).not.toContain('Not transcribed');
  });

  it('shows an empty state with no recordings', async () => {
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('No recordings yet');
  });
});
