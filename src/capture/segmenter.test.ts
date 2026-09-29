import { describe, expect, it } from 'vitest';
import { createStrokeSegmenter, DEFAULT_MAX_GAP_MS } from '@/capture/segmenter';
import type { HuionPenPoint } from '@/utils/huionBLE';

const down = (x: number, y: number, pressure = 0.5): HuionPenPoint =>
  ({ x, y, pressure, status: 1, timestamp: 0 });
const up = (): HuionPenPoint => ({ x: 0, y: 0, pressure: 0, status: 0, timestamp: 0 });

describe('createStrokeSegmenter', () => {
  it('exposes the default max gap constant', () => {
    expect(DEFAULT_MAX_GAP_MS).toBe(500);
  });

  it('builds one stroke from down points closed by pen-up', () => {
    const seg = createStrokeSegmenter();
    seg.push(down(0.1, 0.1), 1000);
    seg.push(down(0.2, 0.2), 1010);
    seg.push(down(0.3, 0.3), 1020);
    const r = seg.push(up(), 1030);
    expect(r.changed).toBe(true);
    expect(r.closed).toEqual({
      points: [
        { x: 0.1, y: 0.1, pressure: 0.5, t: 1000 },
        { x: 0.2, y: 0.2, pressure: 0.5, t: 1010 },
        { x: 0.3, y: 0.3, pressure: 0.5, t: 1020 },
      ],
      startedAt: 1000,
      endedAt: 1020,
    });
    expect(seg.current()).toBeNull();
  });

  it('ignores hover points: never changed, current stays null', () => {
    const seg = createStrokeSegmenter();
    const r1 = seg.push(up(), 1000);
    expect(r1).toEqual({ closed: null, changed: false });
    const r2 = seg.push(up(), 1010);
    expect(r2).toEqual({ closed: null, changed: false });
    expect(seg.current()).toBeNull();
  });

  it('treats status 1 with pressure 0 as up', () => {
    const seg = createStrokeSegmenter();
    seg.push(down(0.1, 0.1), 1000);
    expect(seg.current()).not.toBeNull();
    const r = seg.push({ x: 0.1, y: 0.1, pressure: 0, status: 1, timestamp: 0 }, 1010);
    expect(r.changed).toBe(true);
    expect(r.closed).not.toBeNull();
    expect(seg.current()).toBeNull();
  });

  it('splits a stroke on a gap longer than maxGapMs, keeping the new point open', () => {
    const seg = createStrokeSegmenter();
    seg.push(down(0.1, 0.1), 0);
    seg.push(down(0.2, 0.2), 10);
    const r = seg.push(down(0.3, 0.3), 700);
    expect(r.changed).toBe(true);
    expect(r.closed).toEqual({
      points: [
        { x: 0.1, y: 0.1, pressure: 0.5, t: 0 },
        { x: 0.2, y: 0.2, pressure: 0.5, t: 10 },
      ],
      startedAt: 0,
      endedAt: 10,
    });
    expect(seg.current()).toEqual({
      points: [{ x: 0.3, y: 0.3, pressure: 0.5, t: 700 }],
      startedAt: 700,
      endedAt: 700,
    });
  });

  it('respects a custom maxGapMs', () => {
    const seg = createStrokeSegmenter({ maxGapMs: 50 });
    seg.push(down(0.1, 0.1), 0);
    const r = seg.push(down(0.2, 0.2), 60);
    expect(r.closed).toEqual({
      points: [{ x: 0.1, y: 0.1, pressure: 0.5, t: 0 }],
      startedAt: 0,
      endedAt: 0,
    });
    expect(seg.current()).toEqual({
      points: [{ x: 0.2, y: 0.2, pressure: 0.5, t: 60 }],
      startedAt: 60,
      endedAt: 60,
    });
  });

  it('force-closes the open stroke with end(), and is idempotent when idle', () => {
    const seg = createStrokeSegmenter();
    seg.push(down(0.1, 0.1), 1000);
    seg.push(down(0.2, 0.2), 1010);
    const closed = seg.end();
    expect(closed).toEqual({
      points: [
        { x: 0.1, y: 0.1, pressure: 0.5, t: 1000 },
        { x: 0.2, y: 0.2, pressure: 0.5, t: 1010 },
      ],
      startedAt: 1000,
      endedAt: 1010,
    });
    expect(seg.current()).toBeNull();
    expect(seg.end()).toBeNull();
  });

  it('ignores an up point that arrives after end()', () => {
    const seg = createStrokeSegmenter();
    seg.push(down(0.1, 0.1), 1000);
    seg.end();
    const r = seg.push(up(), 1010);
    expect(r).toEqual({ closed: null, changed: false });
    expect(seg.current()).toBeNull();
  });
});
