import { describe, expect, it } from 'vitest';

import { describeGapSkip, gapEligibility, type GapSkipReason } from '@/gaps/eligibility';
import type {
  AudioTranscriptRecord,
  PageRecord,
  RecordingRecord,
  TranscriptRecord,
  TranscriptStatus,
} from '@/storage/types';

const pageTranscript = (status: TranscriptStatus): TranscriptRecord => ({
  markdown: 'notes',
  model: 'gemma4:12b',
  promptVersion: 'gemma-v1',
  status,
  error: null,
  updatedAt: 0,
});

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id: 'page-1',
    noteId: 'note-1',
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: [{ points: [{ x: 0, y: 0, pressure: 1, t: 10 }], startedAt: 10, endedAt: 10 }],
    pointCount: 1,
    capturedAt: 0,
    render: null,
    transcript: pageTranscript('done'),
    finalizedAt: 100,
    ...overrides,
  };
}

const audio = (status: TranscriptStatus): AudioTranscriptRecord => ({
  text: 'speech',
  segments: [{ startMs: 0, endMs: 10, text: 'speech' }],
  model: 'Xenova/whisper-base.en',
  language: 'en',
  status,
  error: null,
  updatedAt: 0,
});

function recording(transcript: AudioTranscriptRecord | null): RecordingRecord {
  return {
    id: 'rec-1',
    sessionId: 'session-1',
    noteId: 'note-1',
    title: 'Recording',
    startedAt: 0,
    endedAt: 1000,
    durationMs: 1000,
    mimeType: 'audio/webm',
    byteLength: 1,
    transcript,
  };
}

const window = { fromMs: 0, toMs: 1000 };

describe('gapEligibility', () => {
  it('is ok with strokes, a window and both transcripts done', () => {
    expect(gapEligibility(page(), recording(audio('done')), window)).toEqual({ ok: true });
  });

  it('skips a page with no strokes', () => {
    expect(gapEligibility(page({ strokes: [], pointCount: 0 }), recording(audio('done')), null)).toEqual({
      ok: false,
      reason: 'no-strokes',
    });
  });

  it('skips a page whose strokes carry no usable timestamps', () => {
    expect(gapEligibility(page(), recording(audio('done')), null)).toEqual({
      ok: false,
      reason: 'no-timestamps',
    });
  });

  it('skips a note with no linked recording', () => {
    expect(gapEligibility(page(), null, window)).toEqual({ ok: false, reason: 'no-recording' });
  });

  it('skips until the recording transcript is done', () => {
    for (const status of ['pending', 'running', 'failed'] as TranscriptStatus[]) {
      expect(gapEligibility(page(), recording(audio(status)), window)).toEqual({
        ok: false,
        reason: 'recording-transcript',
      });
    }
    expect(gapEligibility(page(), recording(null), window)).toEqual({
      ok: false,
      reason: 'recording-transcript',
    });
  });

  it('skips until the page transcript is done', () => {
    for (const status of ['pending', 'running', 'failed'] as TranscriptStatus[]) {
      expect(
        gapEligibility(page({ transcript: pageTranscript(status) }), recording(audio('done')), window),
      ).toEqual({ ok: false, reason: 'page-transcript' });
    }
    expect(gapEligibility(page({ transcript: null }), recording(audio('done')), window)).toEqual({
      ok: false,
      reason: 'page-transcript',
    });
  });
});

describe('describeGapSkip', () => {
  it('gives a distinct sentence for every reason', () => {
    const reasons: GapSkipReason[] = [
      'no-strokes',
      'no-timestamps',
      'no-recording',
      'recording-transcript',
      'page-transcript',
    ];
    const sentences = reasons.map(describeGapSkip);
    for (const s of sentences) expect(s.length).toBeGreaterThan(10);
    expect(new Set(sentences).size).toBe(reasons.length);
  });
});
