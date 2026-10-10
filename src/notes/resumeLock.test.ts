import { describe, expect, it, vi } from 'vitest';

import { createResumeLock, getResumeLock, resetResumeLockForTests } from '@/notes/resumeLock';

describe('createResumeLock', () => {
  it('starts idle', () => {
    expect(createResumeLock().getState()).toEqual({ pending: false });
  });

  it('is pending for the duration of run()', async () => {
    const lock = createResumeLock();
    let release: (() => void) | null = null;
    const held = lock.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    expect(lock.getState()).toEqual({ pending: true });
    // Cast: TS's control-flow analysis narrows `release` to `never` here - it
    // does not track the async reassignment inside the executor above, run
    // via a closure it never sees called from this scope (same quirk as
    // `SessionControls.test.tsx`).
    (release as (() => void) | null)?.();
    await held;
    expect(lock.getState()).toEqual({ pending: false });
  });

  it('notifies subscribers on both the rising and falling edge', async () => {
    const lock = createResumeLock();
    const seen: boolean[] = [];
    lock.subscribe((s) => seen.push(s.pending));

    await lock.run(async () => {});

    expect(seen).toEqual([true, false]);
  });

  it('keeps pending true while a second overlapping call is still running', async () => {
    // There is one flag, not a counter: the lock only needs to know whether
    // *any* call is in flight, not how many. Product usage disables the
    // buttons that would cause an overlap, but the lock itself must not lie
    // about the first call settling while a second one is still going.
    const lock = createResumeLock();
    let releaseFirst: (() => void) | null = null;
    let releaseSecond: (() => void) | null = null;
    const first = lock.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = lock.run(
      () =>
        new Promise<void>((resolve) => {
          releaseSecond = resolve;
        }),
    );

    (releaseFirst as (() => void) | null)?.();
    await first;
    expect(lock.getState()).toEqual({ pending: true });

    (releaseSecond as (() => void) | null)?.();
    await second;
    expect(lock.getState()).toEqual({ pending: false });
  });

  it('clears pending and rethrows when fn throws', async () => {
    const lock = createResumeLock();
    const error = new Error('resumeNote failed');

    await expect(
      lock.run(() => Promise.reject(error)),
    ).rejects.toThrow('resumeNote failed');

    expect(lock.getState()).toEqual({ pending: false });
  });

  it('unsubscribe stops further notifications', async () => {
    const lock = createResumeLock();
    const fn = vi.fn();
    const unsubscribe = lock.subscribe(fn);
    unsubscribe();

    await lock.run(async () => {});

    expect(fn).not.toHaveBeenCalled();
  });
});

describe('getResumeLock', () => {
  it('returns the same instance across calls, reset by resetResumeLockForTests', () => {
    const first = getResumeLock();
    expect(getResumeLock()).toBe(first);

    resetResumeLockForTests();

    expect(getResumeLock()).not.toBe(first);
  });
});
