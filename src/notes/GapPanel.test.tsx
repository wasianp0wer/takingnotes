import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GapAnalyzer } from '@/gaps/analyzer';
import { describeGapSkip } from '@/gaps/eligibility';
import { speechWindowForPage } from '@/gaps/window';
import { resetGapRuns } from '@/gaps/gapRuns';
import { getDraft, resetAllDrafts, setDraftChoice } from '@/gaps/reviewDraft';
import { GapPanel } from '@/notes/GapPanel';
import { createGap, deleteGapsByPage, type CreateGapInput } from '@/storage/gaps';
import { createNote } from '@/storage/notes';
import { createPage, getPage, setPageGapAnalysis, setPageTranscript } from '@/storage/pages';
import { createRecording, setRecordingTranscript } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import type {
  GapAnalysisMeta,
  GapAnalysisStatus,
  GapSuggestionRecord,
  PageStroke,
  TranscriptSegment,
  TranscriptStatus,
} from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  resetAllDrafts();
  resetGapRuns();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // A spy (e.g. on `console.error`) left mocked by a test that failed before
  // its own teardown line ran must not bleed into the rest of the file.
  vi.restoreAllMocks();
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
    /** The recording's transcript segments; the default overlaps the page's window. */
    segments?: TranscriptSegment[];
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
      segments: opts.segments ?? [
        { startMs: 5_000, endMs: 26_000, text: 'The treaty was signed in 1919.' },
      ],
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

async function render(props: {
  noteId: string;
  pageId: string;
  analyzer?: GapAnalyzer;
  noteIsLive?: boolean;
}): Promise<void> {
  act(() => {
    root.render(<GapPanel {...props} />);
  });
  await settle();
}

function gapAnalysisMeta(
  status: GapAnalysisStatus,
  overrides: Partial<GapAnalysisMeta> = {},
): GapAnalysisMeta {
  return {
    status,
    at: 0,
    model: 'gemma4:12b',
    promptVersion: 'gap-compare-gemma-v1',
    error: null,
    summarized: false,
    ...overrides,
  };
}

/** A stub `GapAnalyzer` whose calls are `vi.fn`s the caller can override. */
function createStubAnalyzer(overrides: Partial<GapAnalyzer> = {}): GapAnalyzer & {
  analyzePage: ReturnType<typeof vi.fn>;
  analyzeNote: ReturnType<typeof vi.fn>;
} {
  return {
    analyzePage: vi.fn(overrides.analyzePage ?? (async () => [] as GapSuggestionRecord[])),
    analyzeNote: vi.fn(overrides.analyzeNote ?? (async () => {})),
  };
}

/**
 * An analyzer whose `analyzeNote` call hangs until `resolve` or `reject` is
 * called by hand.
 */
function createManualAnalyzer() {
  let release: (() => void) | null = null;
  let fail: ((error: unknown) => void) | null = null;
  const analyzePage = vi.fn(async () => [] as GapSuggestionRecord[]);
  const analyzeNote = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      }),
  );
  return {
    analyzePage,
    analyzeNote,
    resolve() {
      release?.();
      release = null;
      fail = null;
    },
    reject(error: unknown) {
      fail?.(error);
      release = null;
      fail = null;
    },
  };
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

  it('a second press while a run is in flight does not start a second run', async () => {
    // Both clicks are dispatched inside one `act()`, before React commits the
    // first one's state update - a same-batch double press. `running` (the
    // rendered state) would read `false` for both handlers in that window, so
    // this only proves the guard if the guard itself does not depend on a
    // commit having happened yet (see `runGapAnalysis` in `gapRuns.ts`).
    const { noteId, pageId } = await seedPage();
    const manual = createManualAnalyzer();

    await render({ noteId, pageId, analyzer: manual });
    const findGapsButton = buttonByText('Find gaps');

    await act(async () => {
      findGapsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      findGapsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      manual.resolve();
    });
    await settle();

    expect(manual.analyzeNote).toHaveBeenCalledTimes(1);
  });

  it('unmounting mid-run is quiet', async () => {
    const { noteId, pageId } = await seedPage();
    const manual = createManualAnalyzer();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A rejection is what would exercise the `catch` - and its guarded
    // `console.error` - so a successful resolve after unmount would prove
    // nothing here.
    let unhandled = false;
    const onUnhandledRejection = () => {
      unhandled = true;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    const localContainer = document.createElement('div');
    document.body.appendChild(localContainer);
    const localRoot = createRoot(localContainer);
    act(() => {
      localRoot.render(<GapPanel noteId={noteId} pageId={pageId} analyzer={manual} />);
    });
    await settle();

    const findGapsButton = Array.from(localContainer.querySelectorAll('button')).find(
      (b) => b.textContent === 'Find gaps',
    );
    if (!findGapsButton) throw new Error('no Find gaps button rendered');
    await act(async () => {
      findGapsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(() => {
      act(() => localRoot.unmount());
    }).not.toThrow();
    localContainer.remove();

    await act(async () => {
      manual.reject(new Error('boom'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // A little extra room: an unhandled rejection is reported asynchronously
    // relative to the reject call, not in the same microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off('unhandledRejection', onUnhandledRejection);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(unhandled).toBe(false);
  });

  it('shows the running and pending status lines', async () => {
    const running = await seedPage();
    await setPageGapAnalysis(running.pageId, gapAnalysisMeta('running'));
    await render({ noteId: running.noteId, pageId: running.pageId });
    expect(container.textContent).toContain('Looking for gaps…');

    act(() => root.unmount());
    root = createRoot(container);

    const pending = await seedPage();
    await setPageGapAnalysis(pending.pageId, gapAnalysisMeta('pending'));
    await render({ noteId: pending.noteId, pageId: pending.pageId });
    expect(container.textContent).toContain('Waiting to analyze…');
  });

  it('shows a failed analysis with its error and still offers Find gaps', async () => {
    const { noteId, pageId } = await seedPage();
    await setPageGapAnalysis(pageId, gapAnalysisMeta('failed', { error: 'Ollama 500: boom' }));

    await render({ noteId, pageId });

    expect(container.textContent).toContain('Ollama 500: boom');
    expect(buttonByText('Find gaps').disabled).toBe(false);
  });

  it('shows an error when the analyzer rejects and stays usable', async () => {
    const { noteId, pageId } = await seedPage();
    // This run genuinely fails while mounted, so the panel's own (guarded)
    // `console.error` legitimately fires - spied here so the run's handled
    // error does not spill a stack trace into the test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const analyzer = createStubAnalyzer({
      analyzeNote: async () => {
        throw new Error('no model');
      },
    });

    await render({ noteId, pageId, analyzer });
    await click(buttonByText('Find gaps'));

    expect(container.textContent).toContain('no model');
    expect(buttonByText('Find gaps').disabled).toBe(false);
  });

  it('says so when an analysis found nothing', async () => {
    const { noteId, pageId } = await seedPage();
    await setPageGapAnalysis(pageId, gapAnalysisMeta('done'));

    await render({ noteId, pageId });

    expect(container.textContent).toContain('No gaps found in the recording for this page.');
  });

  it('says an analysis found nothing even when a previously reviewed suggestion is on the page', async () => {
    // `done` with no *proposed* suggestions is what "found nothing" means -
    // an accepted or rejected leftover from an earlier run must not swallow
    // the line.
    const { noteId, pageId, recordingId } = await seedPage();
    await createGap(gapInput(pageId, noteId, recordingId!, { status: 'rejected' }));
    await setPageGapAnalysis(pageId, gapAnalysisMeta('done'));

    await render({ noteId, pageId });

    expect(container.textContent).toContain('No gaps found in the recording for this page.');
  });

  it('shows a fallback message when a failed analysis carries no error text', async () => {
    const { noteId, pageId } = await seedPage();
    await setPageGapAnalysis(pageId, gapAnalysisMeta('failed', { error: null }));

    await render({ noteId, pageId });

    expect(container.textContent).toContain('Gap analysis failed');
    expect(container.textContent).not.toContain('null');
  });

  it('does not claim the current analysis was summarized because an older suggestion was', async () => {
    // The status-line notice must come from `gapAnalysis.summarized` alone:
    // an older `accepted` suggestion carrying `summarized: true` must not
    // make a direct (`summarized: false`) analysis look lossy.
    const { noteId, pageId, recordingId } = await seedPage();
    await createGap(
      gapInput(pageId, noteId, recordingId!, { status: 'accepted', summarized: true }),
    );
    await setPageGapAnalysis(pageId, gapAnalysisMeta('done', { summarized: false }));

    await render({ noteId, pageId });

    expect(container.textContent).not.toContain('The speech was too long to compare directly');
  });

  it('shows a one-line source note naming the recording window', async () => {
    const { noteId, pageId } = await seedPage();

    await render({ noteId, pageId });

    const page = await getPage(pageId);
    const window = speechWindowForPage(page!);
    expect(window).not.toBeNull();
    expect(container.textContent).toContain(new Date(window!.fromMs).toLocaleTimeString());
    expect(container.textContent).toContain(new Date(window!.toMs).toLocaleTimeString());
  });

  it('shows the source window computed with the configured margins, not the defaults (fix round 1, Important 3)', async () => {
    const { setSettingValue } = await import('@/storage/settingKeys');
    await setSettingValue('gaps.leadMs', 150_000);
    await setSettingValue('gaps.trailMs', 90_000);
    const { noteId, pageId } = await seedPage();

    await render({ noteId, pageId });

    const page = await getPage(pageId);
    const configuredWindow = speechWindowForPage(page!, { leadMs: 150_000, trailMs: 90_000 });
    const defaultWindow = speechWindowForPage(page!);
    expect(configuredWindow).not.toEqual(defaultWindow);
    expect(container.textContent).toContain(new Date(configuredWindow!.fromMs).toLocaleTimeString());
    expect(container.textContent).toContain(new Date(configuredWindow!.toMs).toLocaleTimeString());
  });

  it('says when the speech was summarized', async () => {
    const summarized = await seedPage();
    await setPageGapAnalysis(summarized.pageId, gapAnalysisMeta('done', { summarized: true }));
    await render({ noteId: summarized.noteId, pageId: summarized.pageId });
    expect(container.textContent).toContain('summarized');

    act(() => root.unmount());
    root = createRoot(container);

    const notSummarized = await seedPage();
    await setPageGapAnalysis(
      notSummarized.pageId,
      gapAnalysisMeta('done', { summarized: false }),
    );
    await render({ noteId: notSummarized.noteId, pageId: notSummarized.pageId });
    expect(container.textContent).not.toContain('summarized');
  });

  it('explains an ineligible page but still offers Find gaps for the note', async () => {
    const { noteId, pageId } = await seedPage({ strokes: [] });

    await render({ noteId, pageId });

    expect(container.textContent).toContain(describeGapSkip('no-strokes'));
    expect(buttonByText('Find gaps').disabled).toBe(false);
  });

  it('says when the note has no recording and disables Find gaps', async () => {
    const { noteId, pageId } = await seedPage({ withRecording: false });

    await render({ noteId, pageId });

    expect(container.textContent).toContain(describeGapSkip('no-recording'));
    // The page still has timestamped strokes, so it still has a stroke window -
    // but there is no recording to compare it against, and a present-tense
    // "Comparing against the recording from … to …" beside "This note has no
    // linked recording." is a falsehood next to a contradiction.
    expect(container.textContent).not.toContain('Comparing against the recording');
    expect(buttonByText('Find gaps').disabled).toBe(true);
  });

  it("reads the configured gaps.leadMs/trailMs, so eligibility matches what the analyzer will actually use (fix round 1, Important 3)", async () => {
    // Before the fix, the panel always computed the page's window with the
    // default margins (speechWindowForPage's own fallback), while a real
    // analyzer run reads gaps.leadMs/gaps.trailMs
    // (createConfiguredGapAnalyzer). With a non-default lead configured, the
    // two could disagree on whether a page is eligible at all - P1-A4
    // forbids "Find gaps" looking available when the analyzer would skip.
    const startedAt = 1_000_000;
    // Written well after the recording ends (startedAt + 600_000): the
    // default 60_000ms lead does not reach back far enough to overlap it.
    const { noteId, pageId } = await seedPage({
      strokes: [stroke(startedAt + 700_000, startedAt + 710_000)],
      finalizedAt: startedAt + 715_000,
    });

    await render({ noteId, pageId });
    expect(container.textContent).not.toContain('Comparing against the recording');

    act(() => root.unmount());
    root = createRoot(container);

    // A configured lead wide enough to pull the window's start back into the
    // recording's span - the same setting a real analyzer run would read.
    const { setSettingValue } = await import('@/storage/settingKeys');
    await setSettingValue('gaps.leadMs', 150_000);

    await render({ noteId, pageId });
    expect(container.textContent).toContain('Comparing against the recording');
  });

  it('says the window matched no speech rather than that no gaps were found', async () => {
    // The page is comparable and the analysis ran, but every segment of the
    // recording falls outside the page's window: nothing was compared, which is
    // not the same as the notes being complete.
    const { noteId, pageId } = await seedPage({
      segments: [{ startMs: 500_000, endMs: 520_000, text: 'Much later in the lecture.' }],
    });
    await setPageGapAnalysis(pageId, gapAnalysisMeta('done'));

    await render({ noteId, pageId });

    expect(container.textContent).toContain(
      "The recording has no speech in this page's time window.",
    );
    expect(container.textContent).not.toContain('No gaps found');
  });

  it('says the window matched no speech even when earlier proposals survive', async () => {
    // The analyzer now keeps the page's proposals when the window matched no
    // speech, so this is the common shape of that run: the list is unchanged and
    // the only thing that explains why is this line.
    const { noteId, pageId, recordingId } = await seedPage({
      segments: [{ startMs: 500_000, endMs: 520_000, text: 'Much later in the lecture.' }],
    });
    await createGap(gapInput(pageId, noteId, recordingId!));
    await setPageGapAnalysis(pageId, gapAnalysisMeta('done'));

    await render({ noteId, pageId });

    expect(container.textContent).toContain(
      "The recording has no speech in this page's time window.",
    );
    expect(buttonByText('Review suggestions (1)').disabled).toBe(false);
  });

  it('has exactly one Find gaps button, which analyzes the whole note', async () => {
    const { noteId, pageId } = await seedPage();
    const analyzer = createStubAnalyzer();

    await render({ noteId, pageId, analyzer });

    expect(buttons().filter((b) => b.textContent === 'Find gaps')).toHaveLength(1);
    expect(buttons().find((b) => b.textContent === 'Find gaps in note')).toBeUndefined();

    await click(buttonByText('Find gaps'));

    expect(analyzer.analyzeNote).toHaveBeenCalledWith(noteId);
    expect(analyzer.analyzePage).not.toHaveBeenCalled();
  });

  it('enables Find gaps when the note has a recording even if this page has none', async () => {
    // Written long after the recording ends: this page has no recording of its
    // own, but the note does.
    const startedAt = 1_000_000;
    const { noteId, pageId } = await seedPage({
      strokes: [stroke(startedAt + 5_000_000, startedAt + 5_010_000)],
      finalizedAt: startedAt + 5_015_000,
    });

    await render({ noteId, pageId });

    expect(container.textContent).toContain(describeGapSkip('no-recording'));
    expect(buttonByText('Find gaps').disabled).toBe(false);
  });

  it('Find gaps is disabled while a run is in flight and enabled after', async () => {
    const { noteId, pageId } = await seedPage();
    const manual = createManualAnalyzer();

    await render({ noteId, pageId, analyzer: manual });
    await click(buttonByText('Find gaps'));

    expect(buttonByText('Find gaps').disabled).toBe(true);

    await act(async () => {
      manual.resolve();
    });
    await settle();

    expect(buttonByText('Find gaps').disabled).toBe(false);
  });

  it('Review suggestions is disabled when the note has no proposed suggestions', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    await createGap(gapInput(pageId, noteId, recordingId!, { status: 'rejected' }));

    await render({ noteId, pageId });

    expect(buttonByText('Review suggestions').disabled).toBe(true);
  });

  it('Review suggestions counts proposed suggestions on every page of the note', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    const other = await createPage({
      noteId,
      pageIndex: 1,
      devicePageNum: 2,
      source: 'live',
      strokes: [],
      finalizedAt: 2_000_000,
    });
    await createGap(gapInput(other.id, noteId, recordingId!));
    await createGap(gapInput(other.id, noteId, recordingId!, { text: 'Another point.' }));

    await render({ noteId, pageId });

    expect(buttonByText('Review suggestions (2)').disabled).toBe(false);
  });

  it('Review suggestions opens the review dialog', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    await createGap(gapInput(pageId, noteId, recordingId!));

    await render({ noteId, pageId });
    await click(buttonByText('Review suggestions (1)'));

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('The treaty was the Treaty of Versailles.');
    expect(buttonByText('Find gaps').disabled).toBe(true);
  });

  it('carries draft choices over to rows a run recreates', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    const original = await createGap(gapInput(pageId, noteId, recordingId!));
    setDraftChoice(noteId, original, 'accepted');
    let recreatedId = '';
    const analyzer = createStubAnalyzer({
      analyzeNote: async () => {
        await deleteGapsByPage(pageId, 'proposed');
        const recreated = await createGap(gapInput(pageId, noteId, recordingId!));
        recreatedId = recreated.id;
      },
    });

    await render({ noteId, pageId, analyzer });
    await click(buttonByText('Find gaps'));

    expect(recreatedId).not.toBe('');
    expect(getDraft(noteId).get(recreatedId)).toBe('accepted');
    expect(getDraft(noteId).has(original.id)).toBe(false);

    await click(buttonByText('Review suggestions (1)'));
    const row = document.body.querySelector(`[data-gap-row="${recreatedId}"]`);
    const accept = Array.from(row?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Accept',
    );
    expect(accept?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a run in flight survives a remount: Find gaps stays disabled and a second press does nothing', async () => {
    const { noteId, pageId } = await seedPage();
    const manual = createManualAnalyzer();

    await render({ noteId, pageId, analyzer: manual });
    await click(buttonByText('Find gaps'));

    // Navigating to another page remounts the panel (NotesHalf keys it by page).
    act(() => root.unmount());
    root = createRoot(container);
    await render({ noteId, pageId, analyzer: manual });

    const findGaps = buttonByText('Find gaps');
    expect(findGaps.disabled).toBe(true);
    await act(async () => {
      findGaps.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(manual.analyzeNote).toHaveBeenCalledTimes(1);

    await act(async () => {
      manual.resolve();
    });
    await settle();

    expect(buttonByText('Find gaps').disabled).toBe(false);
  });

  it('Review suggestions is disabled while a run is in flight', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    await createGap(gapInput(pageId, noteId, recordingId!));
    const manual = createManualAnalyzer();

    await render({ noteId, pageId, analyzer: manual });
    expect(buttonByText('Review suggestions (1)').disabled).toBe(false);
    await click(buttonByText('Find gaps'));

    expect(buttonByText('Review suggestions (1)').disabled).toBe(true);

    await act(async () => {
      manual.resolve();
    });
    await settle();

    expect(buttonByText('Review suggestions (1)').disabled).toBe(false);
  });

  it('carries draft choices over even when the run fails after recreating rows', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    const original = await createGap(gapInput(pageId, noteId, recordingId!));
    setDraftChoice(noteId, original, 'accepted');
    let recreatedId = '';
    const analyzer = createStubAnalyzer({
      analyzeNote: async () => {
        await deleteGapsByPage(pageId, 'proposed');
        recreatedId = (await createGap(gapInput(pageId, noteId, recordingId!))).id;
        throw new Error('second page failed');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await render({ noteId, pageId, analyzer });
    await click(buttonByText('Find gaps'));

    expect(container.textContent).toContain('second page failed');
    expect(recreatedId).not.toBe('');
    expect(getDraft(noteId).get(recreatedId)).toBe('accepted');
  });

  it('passes noteIsLive to the dialog', async () => {
    const { noteId, pageId, recordingId } = await seedPage();
    await createGap(gapInput(pageId, noteId, recordingId!));

    await render({ noteId, pageId, noteIsLive: true });
    await click(buttonByText('Review suggestions (1)'));

    expect(document.body.textContent).toContain(
      'You can submit once this note ends — your choices are kept until then.',
    );
  });
});
