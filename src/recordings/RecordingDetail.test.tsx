// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptionQueue, TranscriptionQueueState } from '@/audio/transcriptionQueue';
import { RecordingDetail } from '@/recordings/RecordingDetail';
import {
  createRecording,
  deleteRecording,
  getRecording,
  setRecordingTranscript,
} from '@/storage/recordings';
import type { RecordingRecord, AudioTranscriptRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

// Wraps (rather than replaces) `deleteRecording`, so only the failing-delete
// test below overrides it.
vi.mock('@/storage/recordings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/recordings')>();
  return { ...actual, deleteRecording: vi.fn(actual.deleteRecording) };
});

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
  let counter = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake-${counter++}`);
  URL.revokeObjectURL = vi.fn();
  window.confirm = () => true;
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

// Ported from RecordingsView.test.tsx when the Recordings tab was removed: the
// detail behaviour it pinned now lives in RecordingDetail alone (the audio half
// mounts it unchanged).
describe('RecordingDetail (ported from RecordingsView)', () => {
  type FakeQueue = TranscriptionQueue & {
    retry: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  };

  function liveQueue(initial: Partial<TranscriptionQueueState> = {}): FakeQueue {
    const state: TranscriptionQueueState = { ...idleState, ...initial };
    return {
      enqueue: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      getState: () => state,
      subscribe: () => () => {},
      subscribeChanges: () => () => {},
      whenIdle: vi.fn(async () => {}),
    } as unknown as FakeQueue;
  }

  async function seedWith(
    title: string,
    transcript: Partial<AudioTranscriptRecord> | null,
  ): Promise<RecordingRecord> {
    const recording = await createRecording(
      { title, durationMs: 65_000, startedAt: 1000, endedAt: 66_000 },
      new Blob(['audio-bytes'], { type: 'audio/webm' }),
    );
    if (transcript !== null) {
      await setRecordingTranscript(recording.id, {
        text: '',
        segments: [],
        model: 'Xenova/whisper-base.en',
        language: null,
        status: 'done',
        error: null,
        updatedAt: Date.now(),
        ...transcript,
      } as AudioTranscriptRecord);
    }
    return (await getRecording(recording.id))!;
  }

  async function show(recording: RecordingRecord, q: TranscriptionQueue): Promise<void> {
    act(() => {
      root.render(<RecordingDetail recording={recording} queue={q} onDelete={() => {}} />);
    });
    await flushAll();
  }

  function segmentButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll('[data-start-ms]')] as HTMLButtonElement[];
  }

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  }

  async function click(el: HTMLElement) {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it("shows the recording's transcript segments and seeks on click", async () => {
    const recording = await seedWith('Talk', {
      text: 'hello world',
      language: 'en',
      segments: [
        { startMs: 0, endMs: 1000, text: 'hello' },
        { startMs: 65_000, endMs: 66_000, text: 'world' },
      ],
    });
    await show(recording, liveQueue());

    const buttons = segmentButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('0:00');
    expect(buttons[1].textContent).toContain('1:05');
    const audio = container.querySelector('audio') as HTMLAudioElement;
    expect(audio).toBeTruthy();
    await click(buttons[1]);
    expect(audio.currentTime).toBe(65);
  });

  it("sets transcript text in the theme's transcript font", async () => {
    const segmented = await seedWith('Talk', {
      text: 'hello',
      segments: [{ startMs: 0, endMs: 1000, text: 'hello' }],
    });
    await show(segmented, liveQueue());
    const segmentText = [...container.querySelectorAll('li span')].find(
      (el) => el.textContent === 'hello',
    );
    expect(segmentText?.classList.contains('font-transcript')).toBe(true);

    const textOnly = await seedWith('Talk', { text: 'joined text only', segments: [] });
    await show(textOnly, liveQueue());
    const para = [...container.querySelectorAll('p')].find(
      (el) => el.textContent === 'joined text only',
    );
    expect(para?.classList.contains('font-transcript')).toBe(true);
  });

  it('shows the partial transcript text while a job is running', async () => {
    const recording = await seedWith('In progress', {
      text: 'the first few minutes',
      segments: [{ startMs: 0, endMs: 1000, text: 'the first few minutes' }],
      status: 'running',
      completedMs: 30_000,
    });
    await show(recording, liveQueue({ activeId: recording.id }));

    expect(container.textContent).toContain('the first few minutes');
  });

  it('keeps the clickable timestamps on a partial transcript, as the finished one has', async () => {
    const recording = await seedWith('In progress', {
      text: 'first bit second bit',
      segments: [
        { startMs: 0, endMs: 1000, text: 'first bit' },
        { startMs: 65_000, endMs: 66_000, text: 'second bit' },
      ],
      status: 'running',
      completedMs: 70_000,
    });
    await show(recording, liveQueue({ activeId: recording.id }));

    const buttons = segmentButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('0:00');
    expect(buttons[1].textContent).toContain('1:05');
    const audio = container.querySelector('audio') as HTMLAudioElement;
    await click(buttons[1]);
    expect(audio.currentTime).toBe(65);
  });

  it('keeps the clickable timestamps on a paused transcript too', async () => {
    const recording = await seedWith('Half done', {
      text: 'what it heard',
      segments: [{ startMs: 65_000, endMs: 66_000, text: 'what it heard' }],
      status: 'paused',
      completedMs: 70_000,
    });
    await show(recording, liveQueue());

    const buttons = segmentButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('1:05');
  });

  it('shows how far a transcription has got as a real proportion', async () => {
    const recording = await seedWith('In progress', {
      text: 'so far',
      segments: [{ startMs: 0, endMs: 1000, text: 'so far' }],
      status: 'running',
      completedMs: 30_000,
    });
    await show(
      recording,
      liveQueue({
        activeId: recording.id,
        stage: 'transcribing',
        completedMs: 30_000,
        durationMs: 120_000,
      }),
    );

    expect(container.textContent).toContain('25%');
  });

  it('offers Resume on a paused transcription and shows what it kept', async () => {
    const recording = await seedWith('Half done', {
      text: 'the part it heard',
      segments: [{ startMs: 0, endMs: 1000, text: 'the part it heard' }],
      status: 'paused',
      completedMs: 30_000,
    });
    const q = liveQueue();
    await show(recording, q);

    expect(container.textContent).toContain('Paused at');
    expect(container.textContent).toContain('the part it heard');
    const resume = buttonByText('Resume');
    expect(resume).toBeTruthy();
    await click(resume!);
    expect(q.retry).toHaveBeenCalledWith(recording.id);
  });

  it('shows a failed transcript error and retries', async () => {
    const recording = await seedWith('Broken', {
      status: 'failed',
      error: 'Model download failed',
    });
    const q = liveQueue();
    await show(recording, q);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Model download failed',
    );
    const retry = buttonByText('Retry');
    expect(retry).toBeTruthy();
    await click(retry!);
    expect(q.retry).toHaveBeenCalledWith(recording.id);
  });

  it('shows model download progress while loading', async () => {
    const recording = await seedWith('Loading', { status: 'running' });
    await show(recording, liveQueue({ activeId: recording.id, stage: 'loading', progress: 0.42 }));

    expect(container.textContent).toContain('Downloading model 42%');
  });

  it('shows decode passes as a count, with the real proportion coming from the cursor', async () => {
    const recording = await seedWith('Lecture 4', { status: 'running', completedMs: 0 });
    await show(
      recording,
      liveQueue({
        activeId: recording.id,
        stage: 'transcribing',
        progress: 0,
        passes: 137,
        completedMs: 16_250,
        durationMs: 65_000,
      }),
    );

    // A count, never a percentage: there is no total number of passes.
    expect(container.textContent).toContain('137 passes');
    expect(container.textContent).not.toContain('137 passes decoded so far (');
    expect(container.textContent).toContain('25%');
  });

  it('says an active job that has not reported a stage yet is still preparing', async () => {
    const recording = await seedWith('Lecture 5', { status: 'running' });
    await show(recording, liveQueue({ activeId: recording.id, stage: null, progress: null }));

    expect(container.textContent).toContain('Preparing the audio');
  });

  it('offers Pause for the job the queue is running and calls it with that recording', async () => {
    const recording = await seedWith('Lecture 6', { status: 'running' });
    const q = liveQueue({ activeId: recording.id, stage: 'transcribing', progress: 0, passes: 12 });
    await show(recording, q);

    const pause = buttonByText('Pause');
    expect(pause).toBeTruthy();
    await click(pause!);
    expect(q.pause).toHaveBeenCalledWith(recording.id);
  });

  it('downloads the whole recording as a file rather than opening it as a stream', async () => {
    const recording = await seedWith('Lecture 7', null);
    await show(recording, liveQueue());
    const clicked: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });
    const button = buttonByText('Download audio');
    expect(button).toBeTruthy();
    await click(button!);
    await flushAll();

    expect(clicked).toEqual([expect.stringMatching(/^Lecture 7 \d{4}-\d{2}-\d{2}\.webm$/)]);
    // Re-typed as a generic binary payload, so the browser saves it rather than playing it.
    const types = vi.mocked(URL.createObjectURL).mock.calls.map(([value]) => (value as Blob).type);
    expect(types).toContain('application/octet-stream');
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('offers a retry for a recording stuck pending outside the queue', async () => {
    const recording = await seedWith('Stuck', { status: 'pending' });
    // Neither active nor queued, as after a reload finds a crash's `pending` row.
    const q = liveQueue({ activeId: null, queuedIds: [] });
    await show(recording, q);

    expect(container.textContent).toContain('Queued for transcription');
    const retry = buttonByText('Retry');
    expect(retry).toBeTruthy();
    await click(retry!);
    expect(q.retry).toHaveBeenCalledWith(recording.id);
  });

  it('revokes object URLs when the recording changes and on unmount', async () => {
    const a = await seedWith('A', null);
    const b = await seedWith('B', null);
    const q = liveQueue();
    // Keyed by id, as the audio half mounts it.
    const mount = (r: RecordingRecord) =>
      act(() => {
        root.render(<RecordingDetail key={r.id} recording={r} queue={q} onDelete={() => {}} />);
      });
    mount(a);
    await flushAll();
    const firstUrl = vi.mocked(URL.createObjectURL).mock.results[0]?.value;
    expect(firstUrl).toBeTruthy();

    mount(b);
    await flushAll();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstUrl);

    const secondUrl = vi.mocked(URL.createObjectURL).mock.results.at(-1)?.value;
    act(() => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(secondUrl);
    root = createRoot(container);
  });

  it('keeps the recording and reports the error when the delete fails', async () => {
    const recording = await seedWith('KeepMe', null);
    vi.mocked(deleteRecording).mockRejectedValueOnce(new Error('Database is closed'));
    const onDelete = vi.fn();
    act(() => {
      root.render(<RecordingDetail recording={recording} queue={liveQueue()} onDelete={onDelete} />);
    });
    await flushAll();

    await click(container.querySelector('[aria-label="Delete recording"]') as HTMLButtonElement);
    await flushAll();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Database is closed');
    expect(onDelete).not.toHaveBeenCalled();
    expect(await getRecording(recording.id)).toBeDefined();
  });
});
