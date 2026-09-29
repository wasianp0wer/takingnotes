import { describe, expect, it, vi } from 'vitest';

import { createCaptureEngine } from '@/capture/engine';
import type { CaptureState } from '@/capture/types';
import { createFakeDeviceController } from '@/test/fakeDeviceController';

const IDLE: CaptureState = {
  activeSessionId: null,
  activeNoteId: null,
  activePageId: null,
  pageIndex: -1,
};

function engine() {
  return createCaptureEngine({ controller: createFakeDeviceController() });
}

describe('capture engine (Phase 0 placeholder)', () => {
  it('starts idle', () => {
    expect(engine().getState()).toEqual(IDLE);
  });

  it('makes a session, note and first page active on startNote', async () => {
    const capture = engine();
    const noteId = await capture.startNote();

    const state = capture.getState();
    expect(state.activeNoteId).toBe(noteId);
    expect(state.activeSessionId).toBeTruthy();
    expect(state.activePageId).toBeTruthy();
    expect(state.pageIndex).toBe(0);
  });

  it('starts a fresh note over an active one', async () => {
    const capture = engine();
    const first = await capture.startNote();
    await capture.newPage('manual');
    const second = await capture.startNote();

    expect(second).not.toBe(first);
    expect(capture.getState().activeNoteId).toBe(second);
    // Back to the first page of the new note, not carried over from the old one.
    expect(capture.getState().pageIndex).toBe(0);
  });

  it('advances the page index and the active page on newPage', async () => {
    const capture = engine();
    await capture.startNote();
    const firstPage = capture.getState().activePageId;

    const secondPage = await capture.newPage('device-turn');

    expect(secondPage).toBeTruthy();
    expect(secondPage).not.toBe(firstPage);
    expect(capture.getState()).toMatchObject({ activePageId: secondPage, pageIndex: 1 });
  });

  it('ignores a page turn with no active note (A7)', async () => {
    const capture = engine();
    expect(await capture.newPage('device-turn')).toBeNull();
    expect(capture.getState()).toEqual(IDLE);
  });

  it('returns to idle on endNote and is a no-op when already idle', async () => {
    const capture = engine();
    await capture.startNote();
    await capture.endNote();
    expect(capture.getState()).toEqual(IDLE);

    await expect(capture.endNote()).resolves.toBeUndefined();
    expect(capture.getState()).toEqual(IDLE);
  });

  it('notifies state subscribers with a fresh object and stops on unsubscribe', async () => {
    const capture = engine();
    const seen = vi.fn();
    const unsubscribe = capture.subscribe(seen);

    await capture.startNote();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toBe(capture.getState());

    unsubscribe();
    await capture.newPage('manual');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('reports the finalized page id when a page is closed', async () => {
    const capture = engine();
    const finalized: string[] = [];
    capture.subscribePageFinalized((pageId) => finalized.push(pageId));

    await capture.startNote();
    const firstPage = capture.getState().activePageId!;
    await capture.newPage('manual');
    const secondPage = capture.getState().activePageId!;
    await capture.endNote();

    expect(finalized).toEqual([firstPage, secondPage]);
  });

  it('has no live strokes yet - the placeholder does not handle the pen', () => {
    const capture = engine();
    expect(capture.getLiveStrokes()).toEqual([]);
    expect(capture.subscribeInk(vi.fn())).toBeTypeOf('function');
  });

  it('stops notifying after dispose', async () => {
    const capture = engine();
    const seen = vi.fn();
    capture.subscribe(seen);

    capture.dispose();
    await capture.startNote();

    expect(seen).not.toHaveBeenCalled();
  });
});
