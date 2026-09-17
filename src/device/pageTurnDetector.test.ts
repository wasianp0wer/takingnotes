import { describe, expect, it, vi } from 'vitest';
import { createPageTurnDetector } from '@/device/pageTurnDetector';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createPageTurnDetector', () => {
  it('emits a page turn when the stored count rises, with no notification at all', async () => {
    let count = 3;
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      { getStoredPageCount: async () => count, onPageTurn },
      { pollIntervalMs: 10 },
    );

    await det.start();
    expect(onPageTurn).not.toHaveBeenCalled(); // baseline, not a turn
    count = 4;
    await tick(60);
    det.stop();

    expect(onPageTurn).toHaveBeenCalledWith(4, 3);
    expect(det.pageCount).toBe(4);
  });

  it('emits once per turn even when hint and poll both observe it', async () => {
    let count = 1;
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      { getStoredPageCount: async () => count, onPageTurn },
      { pollIntervalMs: 10 },
    );

    await det.start();
    count = 2;
    det.hint();
    await tick(80);
    det.stop();

    expect(onPageTurn).toHaveBeenCalledTimes(1);
  });

  it('reports a multi-page jump as one event carrying both counts', async () => {
    let count = 0;
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      { getStoredPageCount: async () => count, onPageTurn },
      { pollIntervalMs: 10 },
    );

    await det.start();
    count = 3; // e.g. three turns while disconnected
    await tick(60);
    det.stop();

    expect(onPageTurn).toHaveBeenCalledWith(3, 0);
  });

  it('hint() polls sooner than the interval would', async () => {
    const count = 1;
    const getStoredPageCount = vi.fn(async () => count);
    const det = createPageTurnDetector(
      { getStoredPageCount, onPageTurn: () => {} },
      { pollIntervalMs: 10_000 },
    );

    await det.start();
    const afterStart = getStoredPageCount.mock.calls.length;
    det.hint();
    await tick(30);
    det.stop();

    expect(getStoredPageCount.mock.calls.length).toBeGreaterThan(afterStart);
  });

  it('never overlaps polls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const det = createPageTurnDetector(
      {
        getStoredPageCount: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick(40);
          inFlight--;
          return 1;
        },
        onPageTurn: () => {},
      },
      { pollIntervalMs: 5 },
    );

    await det.start();
    det.hint(); det.hint(); det.hint();
    await tick(200);
    det.stop();

    expect(maxInFlight).toBe(1);
  });

  it('survives a failing poll and keeps going', async () => {
    let count = 1;
    let fail = true;
    const onError = vi.fn();
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      {
        getStoredPageCount: async () => {
          if (fail) throw new Error('link down');
          return count;
        },
        onPageTurn,
        onError,
      },
      { pollIntervalMs: 10 },
    );

    await det.start().catch(() => {});
    await tick(40);
    fail = false;
    count = 5;
    await tick(60);
    det.stop();

    expect(onError).toHaveBeenCalled();
    expect(onPageTurn).toHaveBeenCalled(); // recovered
  });

  it('ignores a count that goes down (device cleared) without firing a turn', async () => {
    let count = 5;
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      { getStoredPageCount: async () => count, onPageTurn },
      { pollIntervalMs: 10 },
    );

    await det.start();
    count = 0;
    await tick(60);
    det.stop();

    expect(onPageTurn).not.toHaveBeenCalled();
    expect(det.pageCount).toBe(0); // baseline re-anchored
  });
});
