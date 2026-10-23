import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isGapRunActive, resetGapRuns, runGapAnalysis, subscribeGapRuns } from '@/gaps/gapRuns';

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
});
