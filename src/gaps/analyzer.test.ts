import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGapAnalyzer, noteHasRecording } from '@/gaps/analyzer';
import { chunkSpeech } from '@/gaps/chunk';
import {
  createFakeTextGenerator,
  type FakeGeneratorCall,
  type FakeTextGenerator,
} from '@/gaps/fakeTextGenerator';
import { getGapPrompt } from '@/gaps/prompts';
import { createGaps, listGapsByPage } from '@/storage/gaps';
import { createNote } from '@/storage/notes';
import { createPage, getPage, setPageTranscript } from '@/storage/pages';
import { createRecording, setRecordingTranscript } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import type {
  GapAnalysisStatus,
  PageStroke,
  TranscriptSegment,
  TranscriptStatus,
} from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

const MODEL = 'gemma4:12b';
const NOW = 7_000_000;
const NOTES = 'What the student wrote.';
const SPEECH = 'The treaty was signed in 1919.';

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
 * One note with one session, one recording whose transcript holds `segments`,
 * and one finalized page written 10s..20s after the recording started.
 */
async function seed(
  options: {
    segments?: TranscriptSegment[];
    markdown?: string;
    pageStatus?: TranscriptStatus;
    audioStatus?: TranscriptStatus;
    strokes?: PageStroke[];
    withRecording?: boolean;
  } = {},
) {
  const startedAt = 1_000_000;
  const session = await createSession({ title: 'Session' });
  const note = await createNote({
    title: 'Note',
    deviceId: 'dev',
    deviceType: 'huion',
    deviceName: 'X10',
    pageBaseline: 0,
    sessionId: session.id,
  });
  const page = await createPage({
    noteId: note.id,
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: options.strokes ?? [stroke(startedAt + 10_000, startedAt + 20_000)],
    finalizedAt: startedAt + 25_000,
  });
  await setPageTranscript(page.id, {
    markdown: options.markdown ?? NOTES,
    model: MODEL,
    promptVersion: 'gemma-v1',
    status: options.pageStatus ?? 'done',
    error: null,
    updatedAt: 0,
  });
  let recordingId: string | null = null;
  if (options.withRecording !== false) {
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
      segments: options.segments ?? [{ startMs: 5_000, endMs: 26_000, text: SPEECH }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: options.audioStatus ?? 'done',
      error: null,
      updatedAt: 0,
    });
  }
  return { sessionId: session.id, noteId: note.id, pageId: page.id, recordingId, startedAt };
}

/**
 * A note with one recording and one page per entry: a markdown string makes an
 * eligible page, `null` a blank (unwritten) one.
 */
async function seedNote(markdowns: Array<string | null>) {
  const startedAt = 1_000_000;
  const session = await createSession({ title: 'Session' });
  const note = await createNote({
    title: 'Note',
    deviceId: 'dev',
    pageBaseline: 0,
    sessionId: session.id,
  });
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
  await setRecordingTranscript(recording.id, {
    text: 'speech',
    segments: [{ startMs: 5_000, endMs: 26_000, text: SPEECH }],
    model: 'Xenova/whisper-base.en',
    language: 'en',
    status: 'done',
    error: null,
    updatedAt: 0,
  });

  const pageIds: string[] = [];
  for (const [index, markdown] of markdowns.entries()) {
    const page = await createPage({
      noteId: note.id,
      pageIndex: index,
      devicePageNum: index + 1,
      source: 'live',
      strokes: markdown === null ? [] : [stroke(startedAt + 10_000, startedAt + 20_000)],
      finalizedAt: startedAt + 25_000,
    });
    if (markdown !== null) {
      await setPageTranscript(page.id, {
        markdown,
        model: MODEL,
        promptVersion: 'gemma-v1',
        status: 'done',
        error: null,
        updatedAt: 0,
      });
    }
    pageIds.push(page.id);
  }
  return { noteId: note.id, recordingId: recording.id, pageIds, startedAt };
}

const ONE_POINT = JSON.stringify([
  { text: SPEECH, kind: 'name-or-date', sourceQuote: 'signed in 1919' },
]);

/** The analyzer under test, with a fixed clock so `gapAnalysis.at` is assertable. */
function analyzerFor(
  generator: FakeTextGenerator,
  overrides: {
    leadMs?: number;
    trailMs?: number;
    directCharBudget?: number;
    chunkChars?: number;
    chunkOverlap?: number;
  } = {},
) {
  return createGapAnalyzer({ generator, model: MODEL, now: () => NOW, ...overrides });
}

/** The last call the fake saw, or a readable failure when it saw none. */
function lastCall(generator: FakeTextGenerator): FakeGeneratorCall {
  const call = generator.calls[generator.calls.length - 1];
  if (!call) throw new Error('the generator was never called');
  return call;
}

async function gapAnalysisOf(pageId: string) {
  return (await getPage(pageId))?.gapAnalysis;
}

/** Distinct words, at least `minChars` of them, so no chunk can repeat another. */
function distinctWords(minChars: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < minChars; i += 1) {
    const word = `word${i}`;
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(' ');
}

describe('createGapAnalyzer', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('writes one suggestion per point from a single direct comparison', async () => {
    const { pageId, noteId, recordingId, startedAt } = await seed();
    const generator = createFakeTextGenerator([ONE_POINT]);

    const created = await analyzerFor(generator).analyzePage(pageId);

    expect(generator.calls).toHaveLength(1);
    expect(lastCall(generator).json).toBe(true);
    expect(lastCall(generator).prompt).toContain(NOTES);
    expect(lastCall(generator).prompt).toContain(SPEECH);
    expect(lastCall(generator).model).toBe(MODEL);
    // The system prompt carries the whole "JSON only, substance only" ruleset, so
    // a call that dropped it would ask the model for something else entirely.
    expect(lastCall(generator).system).toBe(getGapPrompt('compare', MODEL).system);

    expect(created).toHaveLength(1);
    const records = await listGapsByPage(pageId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      noteId,
      pageId,
      recordingId,
      status: 'proposed',
      fromMs: startedAt + 10_000 - 60_000,
      toMs: startedAt + 25_000 + 30_000,
      text: SPEECH,
      kind: 'name-or-date',
      sourceQuote: 'signed in 1919',
      model: MODEL,
      promptVersion: 'gap-compare-gemma-v1',
      summarized: false,
    });
  });

  it('records running while the model call is in flight, then done', async () => {
    const { pageId } = await seed();
    const generator = createFakeTextGenerator([ONE_POINT]);
    let inFlight: GapAnalysisStatus | undefined;
    generator.onGenerate = async () => {
      inFlight = (await gapAnalysisOf(pageId))?.status;
    };

    await analyzerFor(generator).analyzePage(pageId);

    expect(inFlight).toBe('running');
    expect(await gapAnalysisOf(pageId)).toEqual({
      status: 'done',
      error: null,
      summarized: false,
      model: MODEL,
      promptVersion: 'gap-compare-gemma-v1',
      at: NOW,
    });
  });

  it('summarizes each chunk and compares the bullets when the speech is over the budget', async () => {
    const speech = distinctWords(8_000);
    const { pageId } = await seed({
      segments: [{ startMs: 5_000, endMs: 26_000, text: speech }],
    });
    const chunks = chunkSpeech(speech, { budget: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    const bullets = chunks.map((_, index) => `- bullet ${index}`);
    const generator = createFakeTextGenerator([...bullets, ONE_POINT]);

    await analyzerFor(generator, {
      directCharBudget: 200,
      chunkChars: 100,
      chunkOverlap: 20,
    }).analyzePage(pageId);

    expect(generator.calls).toHaveLength(chunks.length + 1);
    expect(generator.calls.slice(0, chunks.length).every((call) => !call.json)).toBe(true);
    expect(generator.calls[0].system).toBe(getGapPrompt('summarize', MODEL).system);
    expect(lastCall(generator).json).toBe(true);
    expect(lastCall(generator).system).toBe(getGapPrompt('compare', MODEL).system);
    expect(lastCall(generator).prompt).toContain('- bullet 0');
    expect(lastCall(generator).prompt).not.toContain(speech);

    const records = await listGapsByPage(pageId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      summarized: true,
      promptVersion: 'gap-summarize-gemma-v1+gap-compare-gemma-v1',
    });
    expect(await gapAnalysisOf(pageId)).toMatchObject({
      status: 'done',
      summarized: true,
      promptVersion: 'gap-summarize-gemma-v1+gap-compare-gemma-v1',
    });
  });

  it('skips a chunk that summarizes to nothing and still completes the run', async () => {
    const speech = distinctWords(250);
    const { pageId } = await seed({
      segments: [{ startMs: 5_000, endMs: 26_000, text: speech }],
    });
    const chunks = chunkSpeech(speech, { budget: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // The empty summary sits in the middle on purpose. At either end, joining it
    // in instead of skipping it would only add a newline that `buildCompare`
    // trims off again, and no assertion could tell the two apart.
    const summaries = chunks.map((_, index) => (index === 1 ? '' : `- bullet ${index}`));
    const generator = createFakeTextGenerator([...summaries, ONE_POINT]);

    await analyzerFor(generator, {
      directCharBudget: 200,
      chunkChars: 100,
      chunkOverlap: 20,
    }).analyzePage(pageId);

    expect(generator.calls).toHaveLength(chunks.length + 1);
    // The bullets either side of the skipped chunk are consecutive: no blank line
    // where its empty summary would have been.
    const comparePrompt = lastCall(generator).prompt;
    expect(comparePrompt).toContain('- bullet 0\n- bullet 2');
    expect(comparePrompt).not.toMatch(/- bullet 0\n\s*\n/);
    expect(await listGapsByPage(pageId)).toHaveLength(1);
    expect(await gapAnalysisOf(pageId)).toMatchObject({ status: 'done', error: null });
  });

  it('compares the raw speech when every chunk summarizes to nothing', async () => {
    const speech = distinctWords(250);
    const { pageId } = await seed({
      segments: [{ startMs: 5_000, endMs: 26_000, text: speech }],
    });
    const chunks = chunkSpeech(speech, { budget: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const generator = createFakeTextGenerator([...chunks.map(() => ''), ONE_POINT]);

    await analyzerFor(generator, {
      directCharBudget: 200,
      chunkChars: 100,
      chunkOverlap: 20,
    }).analyzePage(pageId);

    // A summarizer that produced nothing must not be read as a lecture that said
    // nothing: the raw speech is compared instead, still flagged as the lossy path.
    expect(generator.calls).toHaveLength(chunks.length + 1);
    expect(lastCall(generator).prompt).toContain(speech);
    const records = await listGapsByPage(pageId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      summarized: true,
      promptVersion: 'gap-summarize-gemma-v1+gap-compare-gemma-v1',
    });
    expect(await gapAnalysisOf(pageId)).toMatchObject({
      status: 'done',
      error: null,
      summarized: true,
      promptVersion: 'gap-summarize-gemma-v1+gap-compare-gemma-v1',
    });
  });

  it('drops the bad rows of a response and still reports done', async () => {
    const { pageId } = await seed();
    const generator = createFakeTextGenerator([
      JSON.stringify([
        { text: 'First missing point.', kind: 'claim', sourceQuote: 'first' },
        null,
        'x',
        { text: 'Second missing point.', kind: 'definition', sourceQuote: 'second' },
        {},
      ]),
    ]);

    await analyzerFor(generator).analyzePage(pageId);

    // Sorted: one batch shares a `createdAt`, so `listGapsByPage` breaks the tie
    // on the random id rather than on the order the model gave.
    const records = await listGapsByPage(pageId);
    expect(records.map((record) => record.text).sort()).toEqual([
      'First missing point.',
      'Second missing point.',
    ]);
    expect(await gapAnalysisOf(pageId)).toMatchObject({ status: 'done', error: null });
  });

  it('replaces only the proposed suggestions on a re-run', async () => {
    const { pageId, noteId, recordingId } = await seed();
    const existing = await createGaps(
      (
        [
          ['Kept by the student.', 'accepted'],
          ['Turned down.', 'rejected'],
          ['Stale proposal one.', 'proposed'],
          ['Stale proposal two.', 'proposed'],
        ] as const
      ).map(([text, status]) => ({
        noteId,
        pageId,
        recordingId: recordingId ?? '',
        fromMs: 0,
        toMs: 1,
        text,
        kind: 'claim' as const,
        sourceQuote: 'quote',
        status,
        model: MODEL,
        promptVersion: 'gap-compare-gemma-v1',
      })),
    );
    const generator = createFakeTextGenerator([ONE_POINT]);

    await analyzerFor(generator).analyzePage(pageId);

    const records = await listGapsByPage(pageId);
    const byId = new Map(records.map((record) => [record.id, record]));
    expect(byId.get(existing[0].id)?.status).toBe('accepted');
    expect(byId.get(existing[1].id)?.status).toBe('rejected');
    expect(byId.has(existing[2].id)).toBe(false);
    expect(byId.has(existing[3].id)).toBe(false);
    const proposed = records.filter((record) => record.status === 'proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0].text).toBe(SPEECH);
  });

  it('does not resurface a point the student already rejected', async () => {
    const { pageId, noteId, recordingId } = await seed();
    await createGaps([
      {
        noteId,
        pageId,
        recordingId: recordingId ?? '',
        fromMs: 0,
        toMs: 1,
        text: 'the treaty was signed in 1919',
        kind: 'name-or-date',
        sourceQuote: 'quote',
        status: 'rejected',
        model: MODEL,
        promptVersion: 'gap-compare-gemma-v1',
      },
    ]);
    const generator = createFakeTextGenerator([ONE_POINT]);

    const created = await analyzerFor(generator).analyzePage(pageId);

    expect(created).toEqual([]);
    const records = await listGapsByPage(pageId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('rejected');
    expect(await gapAnalysisOf(pageId)).toMatchObject({ status: 'done', error: null });
  });

  it('still runs on an empty page transcript, telling the model the notes are empty', async () => {
    const { pageId } = await seed({ markdown: '' });
    const generator = createFakeTextGenerator([ONE_POINT]);

    await analyzerFor(generator).analyzePage(pageId);

    expect(generator.calls).toHaveLength(1);
    expect(lastCall(generator).prompt).toContain('nothing');
    expect(await listGapsByPage(pageId)).toHaveLength(1);
  });

  it('skips a page with no strokes without recording an analysis', async () => {
    const { pageId } = await seed({ strokes: [] });
    const generator = createFakeTextGenerator([ONE_POINT]);

    expect(await analyzerFor(generator).analyzePage(pageId)).toEqual([]);

    expect(generator.calls).toEqual([]);
    expect(await listGapsByPage(pageId)).toEqual([]);
    expect(await gapAnalysisOf(pageId)).toBeUndefined();
  });

  it('skips a note with no linked recording without recording an analysis', async () => {
    const { pageId } = await seed({ withRecording: false });
    const generator = createFakeTextGenerator([ONE_POINT]);

    expect(await analyzerFor(generator).analyzePage(pageId)).toEqual([]);

    expect(generator.calls).toEqual([]);
    expect(await listGapsByPage(pageId)).toEqual([]);
    expect(await gapAnalysisOf(pageId)).toBeUndefined();
  });

  it('skips until both the page and the recording transcripts are done', async () => {
    const pending = await seed({ pageStatus: 'pending' });
    const generator = createFakeTextGenerator([ONE_POINT]);
    const analyzer = analyzerFor(generator);

    expect(await analyzer.analyzePage(pending.pageId)).toEqual([]);
    expect(await gapAnalysisOf(pending.pageId)).toBeUndefined();

    const failedAudio = await seed({ audioStatus: 'failed' });
    expect(await analyzer.analyzePage(failedAudio.pageId)).toEqual([]);
    expect(await gapAnalysisOf(failedAudio.pageId)).toBeUndefined();

    expect(generator.calls).toEqual([]);
  });

  it('keeps the proposals and records done when the window holds no speech', async () => {
    // A run that compared *nothing* must not destroy what a run that compared
    // something found: an empty window means a wrongly linked recording, a
    // disagreeing device clock or a legacy import, not "your notes are complete".
    const { pageId, noteId, recordingId } = await seed({
      segments: [{ startMs: 500_000, endMs: 520_000, text: SPEECH }],
    });
    await createGaps(
      ['Kept one.', 'Kept two.'].map((text) => ({
        noteId,
        pageId,
        recordingId: recordingId ?? '',
        fromMs: 0,
        toMs: 1,
        text,
        kind: 'claim' as const,
        sourceQuote: 'quote',
        model: MODEL,
        promptVersion: 'gap-compare-gemma-v1',
      })),
    );
    const generator = createFakeTextGenerator([ONE_POINT]);

    expect(await analyzerFor(generator).analyzePage(pageId)).toEqual([]);

    expect(generator.calls).toEqual([]);
    expect((await listGapsByPage(pageId)).map((g) => g.text).sort()).toEqual([
      'Kept one.',
      'Kept two.',
    ]);
    expect(await gapAnalysisOf(pageId)).toMatchObject({
      status: 'done',
      error: null,
      summarized: false,
    });
  });

  it('records failed with the error, keeps the old suggestions and rethrows', async () => {
    const { pageId, noteId, recordingId } = await seed();
    const existing = await createGaps([
      {
        noteId,
        pageId,
        recordingId: recordingId ?? '',
        fromMs: 0,
        toMs: 1,
        text: 'Survives the failure.',
        kind: 'claim',
        sourceQuote: 'quote',
        model: MODEL,
        promptVersion: 'gap-compare-gemma-v1',
      },
    ]);
    const generator = createFakeTextGenerator([ONE_POINT]);
    generator.failWith = new Error('Ollama 500: boom');

    await expect(analyzerFor(generator).analyzePage(pageId)).rejects.toThrow('boom');

    const records = await listGapsByPage(pageId);
    expect(records.map((record) => record.id)).toEqual([existing[0].id]);
    expect(await gapAnalysisOf(pageId)).toMatchObject({
      status: 'failed',
      error: 'Ollama 500: boom',
    });
  });

  it('aborts before any model call when the signal is already aborted', async () => {
    const { pageId } = await seed();
    const generator = createFakeTextGenerator([ONE_POINT]);

    await expect(
      analyzerFor(generator).analyzePage(pageId, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();

    expect(generator.calls).toEqual([]);
    expect(await listGapsByPage(pageId)).toEqual([]);
    const meta = await gapAnalysisOf(pageId);
    expect(meta?.status).toBe('failed');
    expect(meta?.error).toMatch(/abort/i);
  });

  it('picks the recording with the greatest overlap with the page window (K45)', async () => {
    // The page's window (computed by `seed`) is
    // [startedAt-50_000, startedAt+55_000]. `earlier` starts well before it
    // and ends well after - it contains the whole window (overlap 105_000ms)
    // - while the seeded recording only overlaps the window's second half
    // (overlap 55_000ms). The old "earliest recording" rule and the new
    // "greatest overlap" rule happen to agree here, which is exactly why a
    // second case below is needed to tell them apart.
    const { pageId, sessionId, noteId, recordingId, startedAt } = await seed();
    const earlier = await createRecording(
      {
        sessionId,
        noteId,
        title: 'Earlier',
        startedAt: startedAt - 100_000,
        endedAt: startedAt + 500_000,
        durationMs: 600_000,
      },
      audio(),
    );
    await setRecordingTranscript(earlier.id, {
      text: 'speech',
      segments: [{ startMs: 60_000, endMs: 120_000, text: SPEECH }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    const generator = createFakeTextGenerator([ONE_POINT]);

    await analyzerFor(generator).analyzePage(pageId);

    const records = await listGapsByPage(pageId);
    expect(records).toHaveLength(1);
    expect(records[0].recordingId).toBe(earlier.id);
    expect(records[0].recordingId).not.toBe(recordingId);
  });

  it('picks the later-started recording when it overlaps the page window more (K45)', async () => {
    // Page window: [startedAt-50_000, startedAt+55_000] (from `seed`'s fixed
    // stroke/finalizedAt setup). `early` starts well before the window but
    // ends only 5_000ms into it; `late` starts after `early` - and after the
    // window's own start - but runs long enough to cover 45_000ms of it. The
    // old "earliest recording" rule would pick `early`; K45 must pick `late`.
    const { pageId, sessionId, noteId, startedAt } = await seed({ withRecording: false });
    const early = await createRecording(
      {
        sessionId,
        noteId,
        title: 'Starts earliest, barely overlaps',
        startedAt: startedAt - 200_000,
        endedAt: startedAt - 45_000,
        durationMs: 155_000,
      },
      audio(),
    );
    await setRecordingTranscript(early.id, {
      text: 'speech',
      segments: [{ startMs: 0, endMs: 1_000, text: SPEECH }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    const late = await createRecording(
      {
        sessionId,
        noteId,
        title: 'Starts later, overlaps most of the window',
        startedAt: startedAt + 10_000,
        endedAt: startedAt + 200_000,
        durationMs: 190_000,
      },
      audio(),
    );
    await setRecordingTranscript(late.id, {
      text: 'speech',
      segments: [{ startMs: 0, endMs: 1_000, text: SPEECH }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    const generator = createFakeTextGenerator([ONE_POINT]);

    await analyzerFor(generator).analyzePage(pageId);

    const records = await listGapsByPage(pageId);
    expect(records).toHaveLength(1);
    // early overlaps 5_000ms of the window; late overlaps 45_000ms.
    expect(records[0].recordingId).toBe(late.id);
  });

  it("skips a page whose window overlaps none of the note's recordings", async () => {
    // A recording linked to the note (K12: via session) but nowhere near the
    // page's window in time - a wrongly-linked recording, or a page written
    // long before or after it.
    const { pageId, sessionId, noteId } = await seed({ withRecording: false });
    const far = await createRecording(
      {
        sessionId,
        noteId,
        title: 'Far away',
        startedAt: 500_000_000,
        endedAt: 500_600_000,
        durationMs: 600_000,
      },
      audio(),
    );
    await setRecordingTranscript(far.id, {
      text: 'speech',
      segments: [{ startMs: 0, endMs: 1_000, text: SPEECH }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    const generator = createFakeTextGenerator([ONE_POINT]);

    expect(await analyzerFor(generator).analyzePage(pageId)).toEqual([]);
    expect(generator.calls).toEqual([]);
    expect(await listGapsByPage(pageId)).toEqual([]);
    expect(await gapAnalysisOf(pageId)).toBeUndefined();
  });

  it('ignores an unfinished recording even when its time span would overlap (K45, architecture.md §8.2)', async () => {
    const { pageId, sessionId, noteId } = await seed({ withRecording: false });
    // Still recording: endedAt is null, so `listFinishedRecordings()` must
    // exclude it even though its startedAt/now overlaps the page's window.
    await createRecording(
      {
        sessionId,
        noteId,
        title: 'Still recording',
        startedAt: 1_000_000,
        endedAt: null,
        durationMs: 0,
      },
      audio(),
    );
    const generator = createFakeTextGenerator([ONE_POINT]);

    expect(await analyzerFor(generator).analyzePage(pageId)).toEqual([]);
    expect(generator.calls).toEqual([]);
    expect(await gapAnalysisOf(pageId)).toBeUndefined();
  });

  it("noteHasRecording is false for a note whose only recording is still unfinished", async () => {
    // This is the half of the architecture.md §8.2 bug `recordingForPage`'s
    // own defensive `endedAt === null` guard does not reach: that guard
    // stops a candidate being *selected*, but `noteHasRecording` (what
    // `GapPanel`'s "Find gaps in note" gates on) must independently not
    // count an in-progress recording as "the note has one" - it calls
    // `candidateRecordings` directly, with no such guard of its own, so this
    // is the one place a regression to `listRecordings()` would actually be
    // invisible to every other test here.
    const { sessionId, noteId } = await seed({ withRecording: false });
    await createRecording(
      { sessionId, noteId, title: 'Still recording', startedAt: 1_000_000, endedAt: null, durationMs: 0 },
      audio(),
    );

    expect(await noteHasRecording(noteId)).toBe(false);
  });

  it('finds a recording linked only through the note session', async () => {
    const { pageId, sessionId, startedAt } = await seed({ withRecording: false });
    const recording = await createRecording(
      {
        sessionId,
        noteId: null,
        title: 'Session recording',
        startedAt,
        endedAt: startedAt + 600_000,
        durationMs: 600_000,
      },
      audio(),
    );
    await setRecordingTranscript(recording.id, {
      text: 'speech',
      segments: [{ startMs: 5_000, endMs: 26_000, text: SPEECH }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    const generator = createFakeTextGenerator([ONE_POINT]);

    await analyzerFor(generator).analyzePage(pageId);

    const records = await listGapsByPage(pageId);
    expect(records).toHaveLength(1);
    expect(records[0].recordingId).toBe(recording.id);
  });

  it("analyzeNote compares each page against the recording that overlaps it, not one shared for the whole note (K45, K12)", async () => {
    const startedAt = 1_000_000;
    const session = await createSession({ title: 'Multi-sitting' });
    const note = await createNote({
      title: 'Multi-sitting',
      deviceId: 'dev',
      pageBaseline: 0,
      sessionId: session.id,
    });

    const pageA = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: 1,
      source: 'live',
      strokes: [stroke(startedAt + 10_000, startedAt + 20_000)],
      finalizedAt: startedAt + 25_000,
    });
    await setPageTranscript(pageA.id, {
      markdown: 'Page A notes.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });

    const pageB = await createPage({
      noteId: note.id,
      pageIndex: 1,
      devicePageNum: 2,
      source: 'live',
      strokes: [stroke(startedAt + 700_000, startedAt + 710_000)],
      finalizedAt: startedAt + 715_000,
    });
    await setPageTranscript(pageB.id, {
      markdown: 'Page B notes.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 0,
    });

    // Recording 1 only overlaps page A's window; recording 2 (a later
    // sitting, K12) only overlaps page B's.
    const recording1 = await createRecording(
      { sessionId: session.id, noteId: note.id, title: 'Sitting 1', startedAt, endedAt: startedAt + 600_000, durationMs: 600_000 },
      audio(),
    );
    await setRecordingTranscript(recording1.id, {
      text: 'speech a',
      segments: [{ startMs: 10_000, endMs: 20_000, text: 'Speech A' }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 0,
    });
    const recording2 = await createRecording(
      {
        sessionId: session.id,
        noteId: note.id,
        title: 'Sitting 2',
        startedAt: startedAt + 620_000,
        endedAt: startedAt + 1_200_000,
        durationMs: 580_000,
      },
      audio(),
    );
    await setRecordingTranscript(recording2.id, {
      text: 'speech b',
      segments: [{ startMs: 80_000, endMs: 90_000, text: 'Speech B' }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 0,
    });

    const generator = createFakeTextGenerator([ONE_POINT, ONE_POINT]);

    await analyzerFor(generator).analyzeNote(note.id);

    const gapsA = await listGapsByPage(pageA.id);
    const gapsB = await listGapsByPage(pageB.id);
    expect(gapsA).toHaveLength(1);
    expect(gapsB).toHaveLength(1);
    expect(gapsA[0].recordingId).toBe(recording1.id);
    expect(gapsB[0].recordingId).toBe(recording2.id);
  });

  it('analyzeNote marks the pages pending, then analyzes them in page order, one at a time', async () => {
    const markdowns = ['Page one notes.', 'Page two notes.', 'Page three notes.'];
    const { noteId, pageIds } = await seedNote(markdowns);
    const generator = createFakeTextGenerator([ONE_POINT]);

    const order: number[] = [];
    const pendingSeen: Array<Array<GapAnalysisStatus | undefined>> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    generator.onGenerate = async (call) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(markdowns.findIndex((markdown) => call.prompt.includes(markdown)));
      pendingSeen.push(
        await Promise.all(pageIds.map(async (id) => (await gapAnalysisOf(id))?.status)),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
    };

    await analyzerFor(generator).analyzeNote(noteId);

    expect(order).toEqual([0, 1, 2]);
    expect(maxInFlight).toBe(1);
    expect(pendingSeen[0]).toEqual(['running', 'pending', 'pending']);
    for (const id of pageIds) {
      expect(await gapAnalysisOf(id)).toMatchObject({ status: 'done', error: null });
    }
  });

  it('analyzeNote skips an ineligible page without a model call', async () => {
    const { noteId, pageIds } = await seedNote(['Page one notes.', null]);
    const generator = createFakeTextGenerator([ONE_POINT]);

    await analyzerFor(generator).analyzeNote(noteId);

    expect(generator.calls).toHaveLength(1);
    expect(await gapAnalysisOf(pageIds[0])).toMatchObject({ status: 'done' });
    expect(await gapAnalysisOf(pageIds[1])).toBeUndefined();
    expect(await listGapsByPage(pageIds[1])).toEqual([]);
  });

  it('analyzeNote clears the pending mark of a page that turns out ineligible', async () => {
    const markdowns = ['Page one notes.', 'Page two notes.'];
    const { noteId, pageIds } = await seedNote(markdowns);
    const generator = createFakeTextGenerator([ONE_POINT]);

    // While page one is being compared, page two's handwriting transcript is
    // re-run, so by the time its turn comes it is no longer eligible.
    let markBefore: GapAnalysisStatus | undefined;
    generator.onGenerate = async (call) => {
      if (!call.prompt.includes(markdowns[0])) return;
      markBefore = (await gapAnalysisOf(pageIds[1]))?.status;
      await setPageTranscript(pageIds[1], {
        markdown: markdowns[1],
        model: MODEL,
        promptVersion: 'gemma-v1',
        status: 'running',
        error: null,
        updatedAt: 0,
      });
    };

    await analyzerFor(generator).analyzeNote(noteId);

    expect(markBefore).toBe('pending');
    expect(generator.calls).toHaveLength(1);
    expect(await gapAnalysisOf(pageIds[0])).toMatchObject({ status: 'done', error: null });
    // Skipped, so it carries no analysis at all - not a `pending` the panel would
    // show as "Waiting to analyze…" for ever (P1-A1).
    expect(await gapAnalysisOf(pageIds[1])).toBeNull();
  });

  it('analyzeNote continues past a page that fails', async () => {
    const markdowns = ['Page one notes.', 'Page two notes.'];
    const { noteId, pageIds } = await seedNote(markdowns);
    const generator = createFakeTextGenerator([ONE_POINT]);
    generator.onGenerate = (call) => {
      if (call.prompt.includes(markdowns[0])) throw new Error('model exploded');
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(analyzerFor(generator).analyzeNote(noteId)).resolves.toBeUndefined();

    expect(await gapAnalysisOf(pageIds[0])).toMatchObject({
      status: 'failed',
      error: 'model exploded',
    });
    expect(await gapAnalysisOf(pageIds[1])).toMatchObject({ status: 'done', error: null });
    expect(await listGapsByPage(pageIds[1])).toHaveLength(1);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('analyzeNote on a note with no pages resolves quietly', async () => {
    const { noteId } = await seedNote([]);
    const generator = createFakeTextGenerator([ONE_POINT]);

    await expect(analyzerFor(generator).analyzeNote(noteId)).resolves.toBeUndefined();

    expect(generator.calls).toEqual([]);
  });
});
