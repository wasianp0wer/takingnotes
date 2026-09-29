import type { CaptureEngine, CaptureState, NewPageReason } from '@/capture/types';
import { createEmitter } from '@/device/emitter';
import type { PageStroke } from '@/storage/types';

/**
 * A `CaptureEngine` for F4's tests. It implements only the interface, so the
 * tests keep meaning the same thing after F1 replaces the placeholder engine.
 */
export interface StubCaptureEngine extends CaptureEngine {
  /** Every `newPage` reason, in call order (recorded before `newPageImpl` runs). */
  readonly newPageCalls: NewPageReason[];
  /** Merges a patch into the state and notifies subscribers, as any engine change would. */
  setState(patch: Partial<CaptureState>): void;
  /** What `newPage` does. Reassign to make it reject, throw, or hang. */
  newPageImpl: (reason: NewPageReason) => Promise<string | null>;
}

const IDLE: CaptureState = {
  activeSessionId: null,
  activeNoteId: null,
  activePageId: null,
  pageIndex: -1,
};

const NO_STROKES: readonly PageStroke[] = [];

export function createStubCaptureEngine(initial: Partial<CaptureState> = {}): StubCaptureEngine {
  const stateEmitter = createEmitter<CaptureState>();
  const inkEmitter = createEmitter<void>();
  const finalizedEmitter = createEmitter<string>();
  const newPageCalls: NewPageReason[] = [];
  let state: CaptureState = { ...IDLE, ...initial };
  let counter = 0;
  const nextId = (kind: string) => `${kind}-${++counter}`;

  // A new object per change: useSyncExternalStore needs a new reference per
  // change and the same one in between.
  function setState(patch: Partial<CaptureState>) {
    state = { ...state, ...patch };
    stateEmitter.emit(state);
  }

  const engine: StubCaptureEngine = {
    newPageCalls,
    setState,
    async newPageImpl() {
      if (state.activeNoteId === null) return null;
      const pageId = nextId('page');
      setState({ activePageId: pageId, pageIndex: state.pageIndex + 1 });
      return pageId;
    },
    getState: () => state,
    subscribe: (fn) => stateEmitter.subscribe(fn),
    async startNote() {
      const noteId = nextId('note');
      setState({
        activeSessionId: nextId('session'),
        activeNoteId: noteId,
        activePageId: nextId('page'),
        pageIndex: 0,
      });
      return noteId;
    },
    async endNote() {
      setState({ ...IDLE });
    },
    newPage(reason) {
      newPageCalls.push(reason);
      // Called synchronously, so an impl that throws throws out of newPage.
      return engine.newPageImpl(reason);
    },
    getLiveStrokes: () => NO_STROKES,
    subscribeInk: (fn) => inkEmitter.subscribe(fn),
    subscribePageFinalized: (fn) => finalizedEmitter.subscribe(fn),
    dispose() {},
  };
  return engine;
}
