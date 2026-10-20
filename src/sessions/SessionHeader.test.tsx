// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { resetResumeLockForTests } from '@/notes/resumeLock';
import type { SessionEntry } from '@/sessions/catalog';
import { SessionHeader } from '@/sessions/SessionHeader';
import type { SessionHeaderProps } from '@/sessions/SessionHeader';
import type { NoteRecord, RecordingRecord } from '@/storage/types';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  resetResumeLockForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
});

const note: NoteRecord = {
  id: 'n1',
  title: 'Seminar notes',
  status: 'complete',
  deviceId: 'huion',
  deviceType: 'huion',
  deviceName: null,
  startedAt: 1,
  endedAt: 2,
  pageBaseline: 0,
  pageWidth: null,
  pageHeight: null,
  summary: null,
  summaryModel: null,
  legacy: false,
  legacySourceId: null,
  sessionId: 's1',
  tags: ['thesis'],
};

const recording: RecordingRecord = {
  id: 'r1',
  sessionId: null,
  noteId: null,
  title: 'Lecture audio',
  startedAt: 1,
  endedAt: 2,
  durationMs: 1,
  mimeType: 'audio/webm',
  byteLength: 1,
  transcript: null,
};

const noteEntry: SessionEntry = { kind: 'note', key: 'note:n1', note, recordings: [] };
const recordingEntry: SessionEntry = { kind: 'recording', key: 'recording:r1', recording };

async function render(props: Partial<SessionHeaderProps> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={engine}>
        <SessionHeader
          entry={noteEntry}
          activeNoteId={null}
          sessionLocked={false}
          writingDestinationTitle={null}
          onChanged={() => {}}
          {...props}
        />
      </CaptureProvider>,
    );
  });
}

function hasButton(text: string): boolean {
  return Array.from(container.querySelectorAll('button')).some(
    (b) => b.textContent?.trim() === text,
  );
}

describe('SessionHeader', () => {
  it('renders the title editor, tag editor and Resume for a note entry', async () => {
    await render();
    expect(container.textContent).toContain('Seminar notes');
    expect(container.querySelector('input[aria-label="Add a tag"]')).not.toBeNull();
    expect(container.textContent).toContain('thesis');
    expect(hasButton('Resume')).toBe(true);
  });

  it('renders the recording title and no Resume for a recording entry', async () => {
    await render({ entry: recordingEntry });
    expect(container.textContent).toContain('Lecture audio');
    expect(hasButton('Resume')).toBe(false);
    expect(container.querySelector('input[aria-label="Add a tag"]')).toBeNull();
  });

  it('renders nothing for a null entry', async () => {
    await render({ entry: null });
    expect(container.innerHTML).toBe('');
  });

  it('shows the K16 banner only when a writing destination is given', async () => {
    await render();
    expect(container.querySelector('[role="status"]')).toBeNull();

    await render({ writingDestinationTitle: 'Live note' });
    const banner = container.querySelector('[role="status"]');
    expect(banner?.textContent).toBe('Writing still goes to "Live note"');
  });
});
