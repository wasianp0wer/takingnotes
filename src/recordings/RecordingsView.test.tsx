import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptionQueue, TranscriptionQueueState } from '@/audio/transcriptionQueue';
import { RecordingsView } from '@/recordings/RecordingsView';
import type { RecordingsExternalSelection } from '@/recordings/RecordingsView';
import { createRecording, listFinishedRecordings, setRecordingTranscript } from '@/storage/recordings';
import type { RecordingRecord } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

// Wraps (rather than replaces) `listFinishedRecordings` so every test still
// reads the real store by default; only the reload-ordering test below
// overrides its next calls to control resolution order.
vi.mock('@/storage/recordings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/recordings')>();
  return {
    ...actual,
    listFinishedRecordings: vi.fn(actual.listFinishedRecordings),
    deleteRecording: vi.fn(actual.deleteRecording),
  };
});

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
    passes: null,
    completedMs: null,
    durationMs: null,
    queuedIds: [],
    ...initial,
  };
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(id: string) => void>();

  return {
    enqueue: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
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

function render(
  queue: TranscriptionQueue,
  extra: {
    external?: RecordingsExternalSelection;
    onExternalSelectionApplied?: () => void;
  } = {},
) {
  act(() => {
    root.render(<RecordingsView queue={queue} {...extra} />);
  });
}

function selectedRecordingButton(): HTMLButtonElement | undefined {
  return listButtons().find((b) => b.getAttribute('aria-current') === 'true');
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

// endedAt defaults to a real finished timestamp - not the createRecording
// default of null (K5's "still recording" shape) - since every test here
// means "a recording that's done" unless it explicitly overrides endedAt to
// null to test the opposite.
async function seed(overrides: Partial<Parameters<typeof createRecording>[0]> = {}): Promise<RecordingRecord> {
  const startedAt = overrides.startedAt ?? 1000;
  const durationMs = overrides.durationMs ?? 65_000;
  return createRecording(
    {
      title: 'Recording',
      durationMs,
      startedAt,
      endedAt: startedAt + durationMs,
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

  it('labels a paused transcript "Paused" in the list', async () => {
    const recording = await seed({ title: 'Half done' });
    await setRecordingTranscript(recording.id, {
      text: 'the first half',
      segments: [{ startMs: 0, endMs: 1000, text: 'the first half' }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'paused',
      error: null,
      completedMs: 30_000,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    const row = listButtons().find((b) => b.textContent?.includes('Half done'));
    expect(row?.textContent).toContain('Paused');
  });

  it('shows the partial transcript text while a job is running', async () => {
    const recording = await seed({ title: 'In progress' });
    await setRecordingTranscript(recording.id, {
      text: 'the first few minutes',
      segments: [{ startMs: 0, endMs: 1000, text: 'the first few minutes' }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'running',
      error: null,
      completedMs: 30_000,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue({ activeId: recording.id });

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('the first few minutes');
  });

  it('shows how far a transcription has got as a real proportion', async () => {
    const recording = await seed({ title: 'In progress' });
    await setRecordingTranscript(recording.id, {
      text: 'so far',
      segments: [{ startMs: 0, endMs: 1000, text: 'so far' }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'running',
      error: null,
      completedMs: 30_000,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue({
      activeId: recording.id,
      stage: 'transcribing',
      completedMs: 30_000,
      durationMs: 120_000,
    });

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('25%');
  });

  it('offers Resume on a paused transcription and shows what it kept', async () => {
    const recording = await seed({ title: 'Half done' });
    await setRecordingTranscript(recording.id, {
      text: 'the part it heard',
      segments: [{ startMs: 0, endMs: 1000, text: 'the part it heard' }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'paused',
      error: null,
      completedMs: 30_000,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('Paused at');
    expect(container.textContent).toContain('the part it heard');
    const resume = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Resume');
    expect(resume).toBeTruthy();
    await click(resume!);

    expect(queue.retry).toHaveBeenCalledWith(recording.id);
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

  it('shows decode passes as a count, with the real proportion coming from the cursor', async () => {
    const recording = await seed({ title: 'Lecture 4' });
    await setRecordingTranscript(recording.id, {
      text: '',
      segments: [],
      model: 'Xenova/whisper-base.en',
      language: null,
      status: 'running',
      error: null,
      completedMs: 0,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue({
      activeId: recording.id,
      stage: 'transcribing',
      progress: 0,
      passes: 137,
      completedMs: 16_250,
      durationMs: 65_000,
    });

    render(queue);
    await flushAll();

    // ⚑ The passes count is still a count, never a percentage: the pipeline
    // decides how many decode passes the window in flight needs as it goes,
    // so there is no total to be a fraction of. Presenting one pinned this at
    // "100%" partway through a lecture, which read as stuck.
    expect(container.textContent).toContain('137 passes');
    expect(container.textContent).not.toContain('137 passes decoded so far (');
    // The honest proportion is windows finished against the recording length,
    // which the cursor now gives.
    expect(container.textContent).toContain('25%');
  });

  it('says an active job that has not reported a stage yet is still preparing', async () => {
    const recording = await seed({ title: 'Lecture 5' });
    await setRecordingTranscript(recording.id, {
      text: '',
      segments: [],
      model: 'Xenova/whisper-base.en',
      language: null,
      status: 'running',
      error: null,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue({ activeId: recording.id, stage: null, progress: null });

    render(queue);
    await flushAll();

    // Reading and decoding the audio, or loading an already-cached model: the
    // two steps that report nothing of their own.
    expect(container.textContent).toContain('Preparing the audio');
  });

  it('offers Pause for the job the queue is running and calls it with that recording', async () => {
    const recording = await seed({ title: 'Lecture 6' });
    await setRecordingTranscript(recording.id, {
      text: '',
      segments: [],
      model: 'Xenova/whisper-base.en',
      language: null,
      status: 'running',
      error: null,
      updatedAt: Date.now(),
    });
    const queue = createFakeQueue({
      activeId: recording.id,
      stage: 'transcribing',
      progress: 0,
      passes: 12,
    });

    render(queue);
    await flushAll();
    const pause = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Pause');
    expect(pause).toBeTruthy();
    await click(pause!);

    expect(queue.pause).toHaveBeenCalledWith(recording.id);
  });

  it('downloads the whole recording as a file rather than opening it as a stream', async () => {
    await seed({ title: 'Lecture 7' });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();
    const clicked: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Download audio',
    );
    expect(button).toBeTruthy();
    await click(button!);
    await flushAll();

    // One anchor click, carrying the filename.
    expect(clicked).toEqual([expect.stringMatching(/^Lecture 7 \d{4}-\d{2}-\d{2}\.webm$/)]);
    // ⚑ The downloaded blob is re-typed as a generic binary payload. A blob URL
    // that still advertises `audio/webm` is media the browser would rather play
    // than save - Safari ignores `download` on a blob URL and navigates to it -
    // which opened the recording as a stream in a new window instead of saving it.
    const types = vi.mocked(URL.createObjectURL).mock.calls.map(([value]) => (value as Blob).type);
    expect(types).toContain('application/octet-stream');
    // The URL made for the download is released again.
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    clickSpy.mockRestore();
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

  it('keeps the recording and reports the error when the delete fails', async () => {
    await seed({ title: 'KeepMe' });
    const { deleteRecording } = await import('@/storage/recordings');
    vi.mocked(deleteRecording).mockRejectedValueOnce(new Error('Database is closed'));

    const queue = createFakeQueue();
    render(queue);
    await flushAll();

    const deleteButton = container.querySelector('[aria-label="Delete recording"]') as HTMLButtonElement;
    await click(deleteButton);
    await flushAll();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Database is closed');
    expect(container.textContent).toContain('KeepMe');
    expect(container.textContent).not.toContain('No recordings yet');
    vi.mocked(deleteRecording).mockClear();
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

  it('applies the newest reload even if an older one resolves later', async () => {
    const recording = await seed({ title: 'Race' });
    const queue = createFakeQueue();

    // Only the next two calls (the mount load, then the reload triggered by
    // `fireChange` below) are deferred; any later call falls back to the
    // real `listFinishedRecordings` via the module mock's default
    // implementation.
    const resolvers: ((list: RecordingRecord[]) => void)[] = [];
    const deferred = () =>
      new Promise<RecordingRecord[]>((resolve) => {
        resolvers.push(resolve);
      });
    vi.mocked(listFinishedRecordings).mockImplementationOnce(deferred).mockImplementationOnce(deferred);

    render(queue);
    await flushAll();
    // The mount effect started the first (soon-to-be-stale) load.
    expect(resolvers).toHaveLength(1);

    act(() => queue.fireChange(recording.id));
    await flushAll();
    // `subscribeChanges` started a second, newer load while the first was
    // still in flight.
    expect(resolvers).toHaveLength(2);

    const staleSnapshot: RecordingRecord[] = [{ ...recording, transcript: null }];
    const freshSnapshot: RecordingRecord[] = [
      {
        ...recording,
        transcript: {
          text: 'fresh text',
          segments: [],
          model: 'Xenova/whisper-base.en',
          language: 'en',
          status: 'done',
          error: null,
          updatedAt: Date.now(),
        },
      },
    ];

    // Resolve the newer (second) call first, then the older (first, stale)
    // call - the stale snapshot must not win.
    resolvers[1](freshSnapshot);
    await flushAll();
    resolvers[0](staleSnapshot);
    await flushAll();

    expect(container.textContent).toContain('fresh text');
    expect(container.textContent).not.toContain('Not transcribed');
  });

  it('⚑ Wave 1 review finding #2: an unfinished (endedAt: null) recording is hidden; a finished one still shows', async () => {
    await seed({ title: 'Still recording', startedAt: 1000, endedAt: null, durationMs: 0 });
    await seed({ title: 'Done recording', startedAt: 2000 });
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('Done recording');
    expect(container.textContent).not.toContain('Still recording');
  });

  it('shows an empty state with no recordings', async () => {
    const queue = createFakeQueue();

    render(queue);
    await flushAll();

    expect(container.textContent).toContain('No recordings yet');
  });
});

describe('RecordingsView - external selection (Fix round 1, Finding 1)', () => {
  it('selects the recording an external request names, over the newest-first default', async () => {
    await seed({ title: 'Newest', startedAt: 2000 });
    const target = await seed({ title: 'Target', startedAt: 1000 });
    const queue = createFakeQueue();

    render(queue, { external: { token: 1, recordingId: target.id } });
    await flushAll();

    expect(selectedRecordingButton()?.textContent).toContain('Target');
  });

  it('shows the "look for the segment at" hint when the request names a timestamp, and clears it on a manual pick', async () => {
    const target = await seed({ title: 'Target' });
    await seed({ title: 'Other' });
    const queue = createFakeQueue();

    render(queue, { external: { token: 1, recordingId: target.id, startMs: 65_000 } });
    await flushAll();

    expect(container.textContent).toContain('1:05');
    expect(container.textContent).toContain('look for the segment');

    const other = listButtons().find((b) => b.textContent?.includes('Other'))!;
    await click(other);
    await flushAll();

    expect(container.textContent).not.toContain('look for the segment');
  });

  it('calls onExternalSelectionApplied once the request has been applied', async () => {
    const target = await seed({ title: 'Target' });
    const applied = vi.fn();
    const queue = createFakeQueue();

    render(queue, { external: { token: 1, recordingId: target.id }, onExternalSelectionApplied: applied });
    await flushAll();

    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('re-applies the same recording on a second request (a new token)', async () => {
    const target = await seed({ title: 'Target', startedAt: 1000 });
    await seed({ title: 'Other', startedAt: 2000 });
    const queue = createFakeQueue();

    render(queue, { external: { token: 1, recordingId: target.id } });
    await flushAll();
    expect(selectedRecordingButton()?.textContent).toContain('Target');

    await click(listButtons().find((b) => b.textContent?.includes('Other'))!);
    await flushAll();
    expect(selectedRecordingButton()?.textContent).toContain('Other');

    // Same recording, fresh token - must re-select it, not silently do
    // nothing because this view has already "seen" that id once before.
    render(queue, { external: { token: 2, recordingId: target.id } });
    await flushAll();
    expect(selectedRecordingButton()?.textContent).toContain('Target');
  });

  it('an unrelated reload (the queue reporting a change) does not re-snap to an already-applied request after a manual pick', async () => {
    const target = await seed({ title: 'Target', startedAt: 1000 });
    const other = await seed({ title: 'Other', startedAt: 2000 });
    const queue = createFakeQueue();
    // The *same* external value for the whole test - this is what makes the
    // scenario meaningful: nothing about the request itself ever changes,
    // so only the "already applied" token guard can be what keeps a later
    // reload from reverting the user's own, subsequent manual pick.
    const external: RecordingsExternalSelection = { token: 1, recordingId: target.id };

    render(queue, { external });
    await flushAll();
    expect(selectedRecordingButton()?.textContent).toContain('Target');

    await click(listButtons().find((b) => b.textContent?.includes('Other'))!);
    await flushAll();
    expect(selectedRecordingButton()?.textContent).toContain('Other');

    // A reload with no new request at all (e.g. a transcript status
    // change) must not snap back to `target`.
    act(() => queue.fireChange(other.id));
    await flushAll();
    expect(selectedRecordingButton()?.textContent).toContain('Other');
  });

  it('a request naming an unknown recording id is ignored, falling back to the normal default', async () => {
    await seed({ title: 'Only One', startedAt: 1000 });
    const queue = createFakeQueue();

    render(queue, { external: { token: 1, recordingId: 'does-not-exist' } });
    await flushAll();

    expect(selectedRecordingButton()?.textContent).toContain('Only One');
  });
});
