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
  noteTitle: 'Lecture 1',
  sessionLocked: false,
  hasActiveNote: true,
  onNewNote: vi.fn(),
  onEndNote: vi.fn(),
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

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) {
    throw new Error(
      `no button with text ${JSON.stringify(text)}; have ${JSON.stringify(
        buttons().map((b) => b.textContent?.trim()),
      )}`,
    );
  }
  return found;
}

describe('NoteToolbar', () => {
  it('shows the note title when no title slot is given', async () => {
    await render();
    expect(container.textContent).toContain('Lecture 1');
  });

  it('falls back to "No note selected" when there is no note', async () => {
    // NotesView.test.tsx:312 asserts this exact string for the empty state;
    // the extraction has to keep producing it.
    await render({ noteTitle: null, hasActiveNote: false });
    expect(container.textContent).toContain('No note selected');
  });

  it('a title slot replaces the plain title', async () => {
    await render({ title: <input aria-label="Note title" defaultValue="x" /> });
    expect(container.querySelector('input[aria-label="Note title"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Lecture 1');
  });

  it('renders the meta, actions and banner slots', async () => {
    await render({
      meta: <span data-testid="meta-slot" />,
      actions: <span data-testid="actions-slot" />,
      banner: <span data-testid="banner-slot" />,
    });
    expect(container.querySelector('[data-testid="meta-slot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="actions-slot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="banner-slot"]')).not.toBeNull();
  });

  it('centres the page navigation and omits the title block when no title props are given', async () => {
    await render({ noteTitle: undefined });
    const prev = container.querySelector('button[aria-label="Previous page"]');
    expect(prev?.parentElement?.className).toContain('justify-center');
    expect(container.textContent).not.toContain('No note selected');
  });

  it('disables New note while a session is locked', async () => {
    await render({ sessionLocked: true });
    expect(buttonByText('New note').disabled).toBe(true);
  });

  it('leaves New note enabled when no session is running', async () => {
    await render({ sessionLocked: false });
    expect(buttonByText('New note').disabled).toBe(false);
  });

  it('keeps End note enabled while locked, so ending is always reachable', async () => {
    await render({ sessionLocked: true, hasActiveNote: true });
    expect(buttonByText('End note').disabled).toBe(false);
  });
});
