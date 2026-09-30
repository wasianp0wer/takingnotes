import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GapPanel } from '@/notes/GapPanel';
import { createGap, listGapsByPage, type CreateGapInput } from '@/storage/gaps';
import { createNote } from '@/storage/notes';
import { createPage, getPage, setPageTranscript } from '@/storage/pages';
import { createRecording, setRecordingTranscript } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import type { PageStroke, TranscriptStatus } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A stroke written between two epoch-ms instants. */
function stroke(from: number, to: number): PageStroke {
  return {
    points: [
      { x: 0.1, y: 0.1, pressure: 1, t: from },
      { x: 0.2, y: 0.2, pressure: 1, t: to },
    ],
    startedAt: from,
    endedAt: to,
  };
}

function audio(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
}

/**
 * One note with one session, one finalized page (unless overridden) and,
 * unless `withRecording: false`, one recording with a transcribed segment.
 */
async function seedPage(
  opts: {
    strokes?: PageStroke[];
    pageTranscriptStatus?: TranscriptStatus | null;
    withRecording?: boolean;
    recordingTranscriptStatus?: TranscriptStatus;
    finalizedAt?: number | null;
  } = {},
) {
  const startedAt = 1_000_000;
  const session = await createSession({ title: 'Session' });
  const note = await createNote({
    title: 'Note',
    deviceId: 'dev',
    pageBaseline: 0,
    sessionId: session.id,
  });
  const page = await createPage({
    noteId: note.id,
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: opts.strokes ?? [stroke(startedAt + 10_000, startedAt + 20_000)],
    finalizedAt: opts.finalizedAt === undefined ? startedAt + 25_000 : opts.finalizedAt,
  });
  if (opts.pageTranscriptStatus !== null) {
    await setPageTranscript(page.id, {
      markdown: 'What the student wrote.',
      model: 'gemma4:12b',
      promptVersion: 'gemma-v1',
      status: opts.pageTranscriptStatus ?? 'done',
      error: null,
      updatedAt: 0,
    });
  }
  let recordingId: string | null = null;
  if (opts.withRecording !== false) {
    const recording = await createRecording(
      {
        sessionId: session.id,
        noteId: note.id,
        title: 'Rec',
        startedAt,
        endedAt: startedAt + 600_000,
        durationMs: 600_000,
      },
      audio(),
    );
    recordingId = recording.id;
    await setRecordingTranscript(recording.id, {
      text: 'speech',
      segments: [{ startMs: 5_000, endMs: 26_000, text: 'The treaty was signed in 1919.' }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: opts.recordingTranscriptStatus ?? 'done',
      error: null,
      updatedAt: 0,
    });
  }
  return { noteId: note.id, pageId: page.id, recordingId };
}

function gapInput(
  pageId: string,
  noteId: string,
  recordingId: string,
  overrides: Partial<CreateGapInput> = {},
): CreateGapInput {
  return {
    noteId,
    pageId,
    recordingId,
    fromMs: 0,
    toMs: 1000,
    text: 'The treaty was the Treaty of Versailles.',
    kind: 'name-or-date',
    sourceQuote: 'signed in 1919',
    model: 'gemma4:12b',
    promptVersion: 'gap-compare-gemma-v1',
    ...overrides,
  };
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(props: { noteId: string; pageId: string }): Promise<void> {
  act(() => {
    root.render(<GapPanel {...props} />);
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent === text);
  if (!found) {
    throw new Error(
      `no button with text ${JSON.stringify(text)}; have ${JSON.stringify(
        buttons().map((b) => b.textContent),
      )}`,
    );
  }
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('GapPanel', () => {
  it('renders the Gaps section', async () => {
    const { noteId, pageId } = await seedPage();
    await render({ noteId, pageId });

    const section = container.querySelector('[aria-label="Gaps"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Gaps');
  });

  it('lists proposed suggestions with kind and quote', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    await createGap(
      gapInput(pageId, noteId, recordingId!, {
        text: 'The treaty was the Treaty of Versailles.',
        kind: 'name-or-date',
        sourceQuote: 'signed in 1919',
      }),
    );
    await createGap(
      gapInput(pageId, noteId, recordingId!, {
        text: 'The war lasted four years.',
        kind: 'claim',
        sourceQuote: 'four years of fighting',
      }),
    );

    await render({ noteId, pageId });

    expect(container.textContent).toContain('The treaty was the Treaty of Versailles.');
    expect(container.textContent).toContain('The war lasted four years.');
    expect(container.textContent).toContain('Name or date');
    expect(container.textContent).toContain('Claim');
    expect(container.textContent).toContain('signed in 1919');
    expect(container.textContent).toContain('four years of fighting');
  });

  it('Accept moves a suggestion into the accepted block', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    const gap = await createGap(gapInput(pageId, noteId, recordingId!));

    await render({ noteId, pageId });
    await click(buttonByText('Accept'));

    const stored = await listGapsByPage(pageId);
    const updated = stored.find((g) => g.id === gap.id);
    expect(updated?.status).toBe('accepted');
    expect(container.textContent).toContain('From the recording');
  });

  it('Reject moves it into the rejected block', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    const gap = await createGap(gapInput(pageId, noteId, recordingId!));

    await render({ noteId, pageId });
    await click(buttonByText('Reject'));

    const stored = await listGapsByPage(pageId);
    const updated = stored.find((g) => g.id === gap.id);
    expect(updated?.status).toBe('rejected');
    expect(container.textContent).toContain('Rejected');
  });

  it('accepted suggestions are read-only and never touch the transcript', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    await createGap(gapInput(pageId, noteId, recordingId!, { status: 'accepted' }));

    await render({ noteId, pageId });

    const section = container.querySelector('[aria-label="Gaps"]');
    expect(section?.querySelector('input')).toBeNull();
    expect(section?.querySelector('textarea')).toBeNull();
    expect(section?.querySelector('[contenteditable]')).toBeNull();
    expect(buttons().find((b) => b.textContent === 'Accept')).toBeUndefined();
    expect(buttons().find((b) => b.textContent === 'Reject')).toBeUndefined();

    const stored = await getPage(pageId);
    expect(stored?.transcript?.markdown).toBe('What the student wrote.');
  });
});
