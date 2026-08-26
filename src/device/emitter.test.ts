import { describe, expect, it, vi } from 'vitest';

import { createEmitter } from '@/device/emitter';

describe('createEmitter', () => {
  it('delivers to every subscriber', () => {
    const emitter = createEmitter<number>();
    const first = vi.fn();
    const second = vi.fn();
    emitter.subscribe(first);
    emitter.subscribe(second);

    emitter.emit(42);

    expect(first).toHaveBeenCalledWith(42);
    expect(second).toHaveBeenCalledWith(42);
  });

  it('stops delivering after unsubscribe', () => {
    const emitter = createEmitter<number>();
    const listener = vi.fn();
    const unsubscribe = emitter.subscribe(listener);

    unsubscribe();
    emitter.emit(1);

    expect(listener).not.toHaveBeenCalled();
  });

  it('is safe to unsubscribe twice', () => {
    const emitter = createEmitter<number>();
    const unsubscribe = emitter.subscribe(vi.fn());
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('keeps delivering to others when one subscriber throws', () => {
    const emitter = createEmitter<number>();
    const healthy = vi.fn();
    emitter.subscribe(() => { throw new Error('boom'); });
    emitter.subscribe(healthy);

    expect(() => emitter.emit(1)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(1);
  });

  it('skips a subscriber removed mid-emit but still delivers to the rest', () => {
    // A Phase 2 session ending unsubscribes the recorder from inside a pen
    // batch; the point still in flight must not reach the torn-down consumer,
    // while every other subscriber carries on receiving it.
    const emitter = createEmitter<number>();
    const removed = vi.fn();
    const survivor = vi.fn();
    let unsubscribeRemoved: (() => void) | null = null;

    emitter.subscribe(() => unsubscribeRemoved?.());
    unsubscribeRemoved = emitter.subscribe(removed);
    emitter.subscribe(survivor);

    emitter.emit(7);

    expect(removed).not.toHaveBeenCalled();
    expect(survivor).toHaveBeenCalledWith(7);
  });

  it('is unaffected by a subscriber added during emit', () => {
    const emitter = createEmitter<number>();
    const late = vi.fn();
    emitter.subscribe(() => emitter.subscribe(late));

    emitter.emit(1);

    expect(late).not.toHaveBeenCalled();
  });
});
