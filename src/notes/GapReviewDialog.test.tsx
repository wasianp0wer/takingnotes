import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDraft, resetAllDrafts, setDraftChoice } from '@/gaps/reviewDraft';
import { GapReviewDialog, type GapReviewDialogProps } from '@/notes/GapReviewDialog';
import { createGap, getGap, updateGap, type CreateGapInput } from '@/storage/gaps';
import { createNote } from '@/storage/notes';
import { createPage, listPages } from '@/storage/pages';
import { createRecording } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import { resetDatabase } from '@/test/resetDb';

vi.mock('@/storage/gaps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/gaps')>();
  return { ...actual, updateGap: vi.fn(actual.updateGap) };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const STARTED_AT = 1_000_000;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  resetAllDrafts();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.mocked(updateGap).mockClear();
});

async function seed() {
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
    strokes: [],
    finalizedAt: STARTED_AT + 25_000,
  });
  const recording = await createRecording(
    {
      sessionId: session.id,
      noteId: note.id,
      title: 'Lecture 4',
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 600_000,
      durationMs: 600_000,
    },
    new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
  );
  const input = (overrides: Partial<CreateGapInput>): CreateGapInput => ({
    noteId: note.id,
    pageId: page.id,
    recordingId: recording.id,
    fromMs: STARTED_AT + 10_000,
    toMs: STARTED_AT + 20_000,
    text: 'A point',
    kind: 'claim',
    sourceQuote: 'a quote',
    model: 'gemma4:12b',
    promptVersion: 'gap-compare-gemma-v1',
    ...overrides,
  });
  const a = await createGap(
    input({
      text: 'The treaty was signed in 1919.',
      kind: 'name-or-date',
      sourceQuote: 'signed in 1919',
      quoteStartMs: 65_000,
      quoteEndMs: 72_000,
    }),
  );
  const b = await createGap(
    input({ text: 'The war lasted four years.', sourceQuote: 'four years of fighting' }),
  );
  const c = await createGap(
    input({ text: 'Wilson proposed fourteen points.', kind: 'example', sourceQuote: 'fourteen points' }),
  );
  return { noteId: note.id, gaps: [a, b, c] };
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function props(overrides: Partial<GapReviewDialogProps> & { noteId: string }): GapReviewDialogProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    noteIsLive: false,
    running: false,
    onSubmitted: vi.fn(),
    ...overrides,
  };
}

async function render(p: GapReviewDialogProps): Promise<void> {
  act(() => {
    root.render(<GapReviewDialog {...p} />);
  });
  await settle();
}

function rows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[data-gap-row]'));
}

function rowFor(id: string): HTMLElement {
  const row = document.body.querySelector<HTMLElement>(`[data-gap-row="${id}"]`);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

function buttonIn(el: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!found) throw new Error(`no button ${JSON.stringify(text)}`);
  return found;
}

function submitButton(): HTMLButtonElement {
  return buttonIn(document.body, 'Submit');
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('GapReviewDialog', () => {
  it('lists every proposed suggestion with its text, quote, kind and time range', async () => {
    const { noteId, gaps } = await seed();
    await render(props({ noteId }));

    expect(document.body.textContent).toContain('Review suggestions');
    expect(rows()).toHaveLength(3);
    const first = rowFor(gaps[0].id);
    expect(first.textContent).toContain('The treaty was signed in 1919.');
    expect(first.textContent).toContain('signed in 1919');
    expect(first.textContent).toContain('Name or date');
    expect(first.textContent).toContain('— Lecture 4, 1:05–1:12');
    // No quote timing: the page window, as offsets from the recording's start.
    expect(rowFor(gaps[1].id).textContent).toContain('— Lecture 4, 0:10–0:20');
  });

  it('leaves out suggestions that are no longer proposed', async () => {
    const { noteId, gaps } = await seed();
    await updateGap(gaps[2].id, { status: 'rejected' });
    await render(props({ noteId }));

    expect(rows()).toHaveLength(2);
  });

  it('Accept and Reject are toggles', async () => {
    const { noteId, gaps } = await seed();
    await render(props({ noteId }));
    const row = rowFor(gaps[0].id);

    await click(buttonIn(row, 'Accept'));
    expect(buttonIn(row, 'Accept').getAttribute('aria-pressed')).toBe('true');
    expect(buttonIn(row, 'Reject').getAttribute('aria-pressed')).toBe('false');

    await click(buttonIn(row, 'Accept'));
    expect(buttonIn(row, 'Accept').getAttribute('aria-pressed')).toBe('false');

    await click(buttonIn(row, 'Accept'));
    await click(buttonIn(row, 'Reject'));
    expect(buttonIn(row, 'Accept').getAttribute('aria-pressed')).toBe('false');
    expect(buttonIn(row, 'Reject').getAttribute('aria-pressed')).toBe('true');
  });

  it('writes nothing before Submit', async () => {
    const { noteId, gaps } = await seed();
    await render(props({ noteId }));

    await click(buttonIn(rowFor(gaps[0].id), 'Accept'));

    expect((await getGap(gaps[0].id))?.status).toBe('proposed');
  });

  it('keeps choices across close and reopen', async () => {
    const { noteId, gaps } = await seed();
    const p = props({ noteId });
    await render(p);
    await click(buttonIn(rowFor(gaps[1].id), 'Reject'));

    await render({ ...p, open: false });
    expect(rows()).toHaveLength(0);
    await render({ ...p, open: true });

    expect(buttonIn(rowFor(gaps[1].id), 'Reject').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a choice made elsewhere in the draft', async () => {
    const { noteId, gaps } = await seed();
    setDraftChoice(noteId, gaps[2], 'accepted');
    await render(props({ noteId }));

    expect(buttonIn(rowFor(gaps[2].id), 'Accept').getAttribute('aria-pressed')).toBe('true');
  });

  it('Submit writes the choices, appends a typed page, clears the draft and closes', async () => {
    const { noteId, gaps } = await seed();
    const p = props({ noteId });
    await render(p);
    await click(buttonIn(rowFor(gaps[0].id), 'Accept'));
    await click(buttonIn(rowFor(gaps[1].id), 'Reject'));

    await click(submitButton());

    expect(p.onSubmitted).toHaveBeenCalledTimes(1);
    expect(p.onOpenChange).toHaveBeenCalledWith(false);
    expect((await getGap(gaps[0].id))?.status).toBe('accepted');
    expect((await getGap(gaps[1].id))?.status).toBe('rejected');
    expect((await getGap(gaps[2].id))?.status).toBe('proposed');
    const typed = (await listPages(noteId)).filter((page) => page.source === 'typed');
    expect(typed).toHaveLength(1);
    expect(typed[0].transcript?.markdown).toContain('The treaty was signed in 1919.');
    expect(getDraft(noteId).size).toBe(0);
  });

  it('disables Submit while the note is live and says why', async () => {
    const { noteId } = await seed();
    await render(props({ noteId, noteIsLive: true }));

    expect(submitButton().disabled).toBe(true);
    expect(document.body.textContent).toContain('The page will be added once this note ends.');
  });

  it('disables Submit while a gap run is in flight', async () => {
    const { noteId } = await seed();
    await render(props({ noteId, running: true }));

    expect(submitButton().disabled).toBe(true);
    expect(document.body.textContent).not.toContain('The page will be added once this note ends.');
  });

  it('a double-click on Submit creates exactly one page', async () => {
    const { noteId, gaps } = await seed();
    await render(props({ noteId }));
    await click(buttonIn(rowFor(gaps[0].id), 'Accept'));
    const submit = submitButton();

    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    const typed = (await listPages(noteId)).filter((page) => page.source === 'typed');
    expect(typed).toHaveLength(1);
  });

  it('on a failed Submit, shows the error, stays open and keeps the draft', async () => {
    const { noteId, gaps } = await seed();
    const p = props({ noteId });
    await render(p);
    await click(buttonIn(rowFor(gaps[0].id), 'Accept'));
    vi.mocked(updateGap).mockRejectedValueOnce(new Error('disk full'));

    await click(submitButton());

    expect(document.body.textContent).toContain('disk full');
    expect(p.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(p.onSubmitted).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(3);
    expect(getDraft(noteId).get(gaps[0].id)).toBe('accepted');
    expect(submitButton().disabled).toBe(false);
  });
});
