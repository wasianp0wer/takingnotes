import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureNamingQueue, resetNamingQueueForTests } from '@/notes/naming/startNaming';
import { resetDatabase } from '@/test/resetDb';
import type { TranscriptionQueue } from '@/transcription/queue';

function fakeEngine() {
  return {
    subscribePageFinalized: vi.fn(() => () => {}),
    subscribeNoteEnded: vi.fn(() => () => {}),
  };
}

function fakeTranscriptionQueue(): Pick<TranscriptionQueue, 'subscribe' | 'idle'> {
  // Always idle: these tests exercise `ensureNamingQueue`'s own wiring, not
  // Fix 2's gate (covered in `queue.test.ts`).
  return { subscribe: vi.fn(() => () => {}), idle: vi.fn(() => Promise.resolve()) };
}

describe('ensureNamingQueue', () => {
  afterEach(() => {
    resetNamingQueueForTests();
  });

  it('builds and starts the queue on the first call', async () => {
    await resetDatabase();
    const engine = fakeEngine();
    const queue = ensureNamingQueue(engine, fakeTranscriptionQueue());

    expect(queue).toBeDefined();
    // start() subscribes to both triggers - proof it was actually started,
    // not just constructed.
    await queue.idle();
    expect(engine.subscribePageFinalized).toHaveBeenCalled();
  });

  it('returns the same instance across calls, reusing the first call\'s dependencies', () => {
    const engine = fakeEngine();
    const first = ensureNamingQueue(engine, fakeTranscriptionQueue());
    const second = ensureNamingQueue(fakeEngine(), fakeTranscriptionQueue());

    expect(second).toBe(first);
  });

  it('resetNamingQueueForTests lets a fresh instance be built', () => {
    const first = ensureNamingQueue(fakeEngine(), fakeTranscriptionQueue());
    resetNamingQueueForTests();
    const second = ensureNamingQueue(fakeEngine(), fakeTranscriptionQueue());

    expect(second).not.toBe(first);
  });
});
