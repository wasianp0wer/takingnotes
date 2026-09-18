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

  it('anchors silently on the first successful poll when the baseline read failed', async () => {
    // This replaces a test that asserted the opposite ("expect(onPageTurn)
    // .toHaveBeenCalled(); // recovered"), encoding the defect as intent.
    // A failed baseline leaves `known` at its initial 0, which is
    // indistinguishable from an empty pad; treating the first real reading as
    // a rise from 0 fabricates a page turn the user never made. Under D9
    // nothing re-downloads from ROM, so that split is unrepairable - a
    // fabricated boundary is as damaging as a missed one. The contract is
    // "start() does not fire a turn", and a failed baseline must not convert
    // the next poll into one.
    let count = 5;
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
    expect(onError).toHaveBeenCalled(); // the baseline read really did fail

    // Link comes back. The pad already held 5 pages the whole time - no turn
    // happened, so none may be reported.
    fail = false;
    await tick(60);
    expect(onPageTurn).not.toHaveBeenCalled();
    expect(det.pageCount).toBe(5); // but the baseline is now anchored at 5

    // Polling is still alive, and a genuine rise from the recovered baseline
    // is still reported - with the right `previous`, not 0.
    count = 6;
    await tick(60);
    det.stop();

    expect(onPageTurn).toHaveBeenCalledTimes(1);
    expect(onPageTurn).toHaveBeenCalledWith(6, 5);
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

  it('discards a stale poll that resolves after stop() then start() (Facet A)', async () => {
    const onPageTurn = vi.fn();
    let resolveStale: (count: number) => void = () => {};
    let callCount = 0;
    const getStoredPageCount = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        // The very first real call is the one we strand across the restart.
        return new Promise<number>((resolve) => { resolveStale = resolve; });
      }
      return Promise.resolve(1);
    });

    const det = createPageTurnDetector(
      { getStoredPageCount, onPageTurn },
      { pollIntervalMs: 10_000 },
    );

    await det.start(0); // explicit baseline: doesn't consume a call
    det.hint(); // enters the single-flight slot and hangs (call #1)
    await tick(5);
    det.stop();
    await det.start(0); // new session, same explicit baseline

    // Release the stranded call now that a new session is active. A jump
    // to 99 would certainly fire onPageTurn if it were allowed to apply.
    resolveStale(99);
    await tick(5);
    det.stop();

    expect(onPageTurn).not.toHaveBeenCalled();
    expect(det.pageCount).toBe(0);
  });

  it('does not let a restart baseline read overlap a stale in-flight poll (Facet B)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseStale: () => void = () => {};
    let callCount = 0;
    const getStoredPageCount = vi.fn(() => {
      callCount++;
      const thisCall = callCount;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<number>((resolve) => {
        if (thisCall === 1) {
          releaseStale = () => { inFlight--; resolve(1); };
        } else {
          inFlight--;
          resolve(2);
        }
      });
    });

    const det = createPageTurnDetector(
      { getStoredPageCount, onPageTurn: () => {} },
      { pollIntervalMs: 10_000 },
    );

    await det.start(0); // explicit baseline: doesn't consume a call
    det.hint(); // call #1, stays in flight until releaseStale()
    await tick(5);
    det.stop();

    const restart = det.start(); // no initialCount: attempts its own baseline read
    await tick(5); // give the baseline read a chance to fire if unguarded

    expect(maxInFlight).toBeLessThanOrEqual(1); // never two calls in flight together
    expect(callCount).toBe(1); // the restart's read must not have fired at all

    releaseStale();
    await restart;
    det.stop();
  });
});
