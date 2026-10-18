import { describe, expect, it } from 'vitest';
import { chunksToSegments, languageForModel } from '@/audio/whisperProtocol';

describe('chunksToSegments', () => {
  it('converts seconds to ms offsets and trims text', () => {
    expect(chunksToSegments([
      { timestamp: [0, 8.004], text: ' And so my fellow Americans' },
      { timestamp: [8.004, 11.5], text: ' ask not. ' },
    ], 12_000)).toEqual([
      { startMs: 0, endMs: 8004, text: 'And so my fellow Americans' },
      { startMs: 8004, endMs: 11_500, text: 'ask not.' },
    ]);
  });
  it('fills a missing end from the next start, then from the duration', () => {
    expect(chunksToSegments([
      { timestamp: [0, null], text: 'a' },
      { timestamp: [2, null], text: 'b' },
    ], 3_250)).toEqual([
      { startMs: 0, endMs: 2_000, text: 'a' },
      { startMs: 2_000, endMs: 3_250, text: 'b' },
    ]);
  });
  it('drops empty chunks, sorts by start and never ends before it starts', () => {
    expect(chunksToSegments([
      { timestamp: [5, 4], text: 'late' },
      { timestamp: [1, 2], text: '   ' },
      { timestamp: [0, 1], text: 'first' },
    ], 10_000)).toEqual([
      { startMs: 0, endMs: 1_000, text: 'first' },
      { startMs: 5_000, endMs: 5_000, text: 'late' },
    ]);
  });
});

describe('languageForModel', () => {
  it('is English for .en models and unknown otherwise', () => {
    expect(languageForModel('Xenova/whisper-base.en')).toBe('en');
    expect(languageForModel('onnx-community/whisper-base')).toBeNull();
  });
});


describe('chunksToSegments offsetting', () => {
  it('offsets segment times by the window start', () => {
    const segments = chunksToSegments([{ timestamp: [1, 2], text: 'hi' }], 30_000, 600_000);

    expect(segments[0]).toEqual({ startMs: 601_000, endMs: 602_000, text: 'hi' });
  });

  it('offsets a chunk whose end is filled from the window duration', () => {
    // A final chunk with no end falls back to `durationMs` - which is the
    // *window's* duration, so it needs the offset too or the last segment of
    // every window after the first lands back near the start of the recording.
    const segments = chunksToSegments([{ timestamp: [1, null], text: 'tail' }], 30_000, 600_000);

    expect(segments[0]).toEqual({ startMs: 601_000, endMs: 630_000, text: 'tail' });
  });

  it('defaults to no offset', () => {
    const segments = chunksToSegments([{ timestamp: [1, 2], text: 'hi' }], 30_000);

    expect(segments[0].startMs).toBe(1000);
  });
});
