// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptionQueue } from '@/audio/transcriptionQueue';
import { AudioHalf } from '@/sessions/AudioHalf';
import type { AudioHalfProps } from '@/sessions/AudioHalf';
import type { RecordingRecord } from '@/storage/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock('@/recordings/RecordingDetail', () => ({
  RecordingDetail: ({ recording }: { recording: RecordingRecord }) => (
    <div data-testid="detail">{recording.id}</div>
  ),
}));

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

function rec(id: string, startedAt: number): RecordingRecord {
  return {
    id,
    title: id,
    noteId: 'n',
    startedAt,
    endedAt: startedAt + 1000,
    durationMs: 1000,
    transcript: null,
  } as unknown as RecordingRecord;
}

const three = [rec('r1', 1), rec('r2', 2), rec('r3', 3)];

function props(overrides: Partial<AudioHalfProps> = {}): AudioHalfProps {
  return {
    recordings: three,
    selectedRecordingId: 'r1',
    onSelectRecording: vi.fn(),
    seek: null,
    onSeekApplied: vi.fn(),
    followNewest: false,
    audioQueue: {} as TranscriptionQueue,
    onChanged: vi.fn(),
    ...overrides,
  };
}

function render(p: AudioHalfProps) {
  act(() => root.render(<AudioHalf {...p} />));
}

function button(label: string): HTMLButtonElement {
  return container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
}

describe('AudioHalf', () => {
  it('shows Recording N of M with arrows that select neighbours', () => {
    const p = props();
    render(p);
    expect(container.textContent).toContain('Recording 1 of 3');
    expect(button('Previous recording').disabled).toBe(true);
    act(() => button('Next recording').click());
    expect(p.onSelectRecording).toHaveBeenCalledWith('r2');
  });

  it('disables the next arrow on the last recording', () => {
    render(props({ selectedRecordingId: 'r3' }));
    expect(button('Next recording').disabled).toBe(true);
    expect(button('Previous recording').disabled).toBe(false);
  });

  it('renders the first recording for an unknown or null selection', () => {
    render(props({ selectedRecordingId: 'gone' }));
    expect(container.querySelector('[data-testid="detail"]')?.textContent).toBe('r1');
    render(props({ selectedRecordingId: null }));
    expect(container.querySelector('[data-testid="detail"]')?.textContent).toBe('r1');
  });

  it('renders an empty half with no player for zero recordings', () => {
    render(props({ recordings: [], selectedRecordingId: null }));
    expect(container.querySelector('[data-testid="detail"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('a new recording for the live session becomes selected', () => {
    const p = props({ recordings: three.slice(0, 2), followNewest: true });
    render(p);
    expect(p.onSelectRecording).not.toHaveBeenCalled();
    render({ ...p, recordings: three });
    expect(p.onSelectRecording).toHaveBeenCalledWith('r3');
  });

  it('with followNewest false a new recording does not change the selection', () => {
    const p = props({ recordings: three.slice(0, 2), followNewest: false });
    render(p);
    render({ ...p, recordings: three });
    expect(p.onSelectRecording).not.toHaveBeenCalled();
  });
});
