import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGapAnalyzer } from '@/gaps/analyzer';
import { chunkSpeech } from '@/gaps/chunk';
import {
  createFakeTextGenerator,
  type FakeGeneratorCall,
  type FakeTextGenerator,
} from '@/gaps/fakeTextGenerator';
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
    expect(lastCall(generator).json).toBe(true);
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
    // The first chunk summarizes to nothing; the rest to one bullet each.
    const summaries = chunks.map((_, index) => (index === 0 ? '' : `- bullet ${index}`));
    const generator = createFakeTextGenerator([...summaries, ONE_POINT]);

    await analyzerFor(generator, {
      directCharBudget: 200,
      chunkChars: 100,
      chunkOverlap: 20,
    }).analyzePage(pageId);

    expect(generator.calls).toHaveLength(chunks.length + 1);
    // The empty summary is left out of the comparison rather than joined in as a
    // blank line, so the surviving bullets are consecutive.
    expect(lastCall(generator).prompt).toContain(summaries.slice(1).join('\n'));
    expect(await listGapsByPage(pageId)).toHaveLength(1);
    expect(await gapAnalysisOf(pageId)).toMatchObject({ status: 'done', error: null });
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

  it('clears the proposals and records done when the window holds no speech', async () => {
    const { pageId, noteId, recordingId } = await seed({
      segments: [{ startMs: 500_000, endMs: 520_000, text: SPEECH }],
    });
    await createGaps(
      ['Stale one.', 'Stale two.'].map((text) => ({
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
    expect(await listGapsByPage(pageId)).toEqual([]);
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

  it('uses the earliest recording linked to the note', async () => {
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
