import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { NoteToolbar } from '@/notes/NoteToolbar';
import type { NoteToolbarProps } from '@/notes/NoteToolbar';
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
  // The engine runs its startup recovery against storage on first subscribe.
  await resetDatabase();
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

const base: NoteToolbarProps = {
  pageCount: 2,
  viewedIndex: 0,
  onGoToPage: vi.fn(),
};

async function render(props: Partial<NoteToolbarProps> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={engine}>
        <NoteToolbar {...base} {...props} />
      </CaptureProvider>,
    );
  });
}

describe('NoteToolbar', () => {
  it('centres the page navigation and renders no title block (the session header owns it)', async () => {
    await render();
    const prev = container.querySelector('button[aria-label="Previous page"]');
    expect(prev?.parentElement?.className).toContain('justify-center');
    expect(container.textContent).not.toContain('No note selected');
  });

  it('has no New note or End note button and no page-turn controls (NotesHalf mounts those)', async () => {
    await render();
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels).not.toContain('New note');
    expect(labels).not.toContain('End note');
    expect(container.querySelector('button[aria-label="New page"]')).toBeNull();
  });
});
