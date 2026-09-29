import type { CaptureEngine, CaptureState, NewPageReason } from '@/capture/types';
import type { DeviceController } from '@/device/controller';
import { createEmitter } from '@/device/emitter';
import { newId } from '@/storage/id';
import type { PageStroke } from '@/storage/types';

export interface CaptureEngineDeps {
  controller: DeviceController;
}

const idleState: CaptureState = {
  activeSessionId: null,
  activeNoteId: null,
  activePageId: null,
  pageIndex: -1,
};

const NO_STROKES: readonly PageStroke[] = [];

/**
 * Phase 0 placeholder. It satisfies `CaptureEngine` and tracks which session,
 * note and page are active, so the shell and the page-turn wiring can be built
 * and tested against the real contract - but it persists nothing and never
 * touches the pen stream. F1 replaces this implementation behind the same
 * signature (it may add optional deps).
 *
 * The ids it hands out are real uuids that match no stored record, so nothing
 * downstream can quietly succeed at reading one and mistake this for the real
 * engine.
 */
export function createCaptureEngine(deps: CaptureEngineDeps): CaptureEngine {
  // Referenced but unused: the controller is what F1 subscribes to for pen
  // points. Keeping it in the signature now means the wiring in main.tsx and
  // every test fixture is already correct when the real engine lands.
  void deps.controller;

  const stateEmitter = createEmitter<CaptureState>();
  const inkEmitter = createEmitter<void>();
  const pageFinalizedEmitter = createEmitter<string>();

  let state: CaptureState = { ...idleState };
  let disposed = false;

  // Replaces the whole object rather than mutating it: `useSyncExternalStore`
  // needs a new reference per change and a stable one in between.
  function setState(next: CaptureState) {
    state = next;
    if (!disposed) stateEmitter.emit(state);
  }

  /** Announces the active page as finalized, as persisting it really would. */
  function finalizeActivePage() {
    const pageId = state.activePageId;
    if (pageId === null) return;
    if (!disposed) pageFinalizedEmitter.emit(pageId);
  }

  return {
    getState() {
      return state;
    },
    subscribe(fn) {
      return stateEmitter.subscribe(fn);
    },

    async startNote() {
      // Ends whatever was active first, so two notes are never open at once -
      // the ordering the real engine has to keep too.
      finalizeActivePage();
      const noteId = newId();
      setState({
        activeSessionId: newId(),
        activeNoteId: noteId,
        activePageId: newId(),
        pageIndex: 0,
      });
      return noteId;
    },

    async endNote() {
      if (state.activeNoteId === null) return;
      finalizeActivePage();
      setState({ ...idleState });
    },

    async newPage(reason: NewPageReason) {
      // The reason only matters to the real engine (a device turn also moves the
      // device page number onto the new page); the placeholder treats both alike.
      void reason;
      // A7: a page turn with no active note is ignored; the next pen input
      // starts a note.
      if (state.activeNoteId === null) return null;
      finalizeActivePage();
      const pageId = newId();
      setState({ ...state, activePageId: pageId, pageIndex: state.pageIndex + 1 });
      return pageId;
    },

    getLiveStrokes() {
      return NO_STROKES;
    },
    subscribeInk(fn) {
      return inkEmitter.subscribe(fn);
    },
    subscribePageFinalized(fn) {
      return pageFinalizedEmitter.subscribe(fn);
    },

    dispose() {
      disposed = true;
    },
  };
}
