import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  gapRunProgress,
  isGapRunActive,
  resetGapRuns,
  runGapAnalysis,
  subscribeGapRuns,
} from '@/gaps/gapRuns';

beforeEach(resetGapRuns);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('gapRuns', () => {
  it('marks a note running for the length of its run and notifies subscribers', async () => {
    const listener = vi.fn();
    const off = subscribeGapRuns(listener);
    const task = deferred();

    const done = runGapAnalysis('n1', () => task.promise);
    expect(isGapRunActive('n1')).toBe(true);
    expect(isGapRunActive('n2')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    task.resolve();
    await expect(done).resolves.toBe(true);
    expect(isGapRunActive('n1')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it('refuses a second run for the same note while one is in flight', async () => {
    const task = deferred();
    const first = runGapAnalysis('n1', () => task.promise);
    const second = vi.fn(async () => {});

    await expect(runGapAnalysis('n1', second)).resolves.toBe(false);
    expect(second).not.toHaveBeenCalled();

    task.resolve();
    await first;
  });

  it('clears the mark when the run throws, and rethrows', async () => {
    await expect(
      runGapAnalysis('n1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(isGapRunActive('n1')).toBe(false);
  });

  it('hands the run a progress report that advances the note and notifies subscribers', async () => {
    const listener = vi.fn();
    const off = subscribeGapRuns(listener);
    const task = deferred();
    let report!: () => void;

    const done = runGapAnalysis('n1', (progress) => {
      report = progress;
      return task.promise;
    });
    const before = gapRunProgress('n1');
    listener.mockClear();

    report();
    expect(gapRunProgress('n1')).toBe(before + 1);
    expect(gapRunProgress('n2')).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);

    task.resolve();
    await done;
    off();
  });
});
