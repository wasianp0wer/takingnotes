import type { PageStroke } from '@/storage/types';

export interface CaptureState {
  activeSessionId: string | null;
  activeNoteId: string | null;
  activePageId: string | null;
  /** Zero-based index of the active page within the active note; -1 when none. */
  pageIndex: number;
}

export type NewPageReason = 'device-turn' | 'manual';

/**
 * The single owner of "what is being written right now". Everything above it
 * (the shell, the notes view, the recorder) reads this rather than reaching
 * into storage, and everything below it (the device controller) feeds it.
 *
 * Behavioral rules every implementation must keep (docs/architecture.md §3.1):
 * pen input with no active note starts one, so writing is never dropped;
 * strokes persist incrementally (pen-up plus a flush at most 2 s apart), so a
 * crash loses at most the stroke in progress; points carry `t` and strokes
 * carry `startedAt`/`endedAt`; `newPage` and `endNote` are serialized; and on
 * startup, notes left `active` become `interrupted`, their sessions `ended`, and
 * their unfinalized pages finalized.
 *
 * Phase 2 (docs/architecture.md §6.5) adds `startSession`/`endSession`. A
 * session's audio is started by the UI, not the engine: the engine must not
 * depend on the recorder, so `SessionControls` calls `startSession()` and then
 * the recorder, and reports an audio failure without unwinding the session.
 * `startNote()` keeps working for bare notes and for pen-input auto-start.
 */
export interface CaptureEngine {
  getState(): CaptureState;
  subscribe(fn: (s: CaptureState) => void): () => void;

  /** Creates Session + Note + first Page and makes them active. Ends any active note first. */
  startNote(opts?: { title?: string }): Promise<string>;
  /** Finalizes the active page, marks the note complete and the session ended. No-op when idle. */
  endNote(): Promise<void>;
  /** Creates a Session, opens a Note in it, and reports the ids. Ends any active note first. */
  startSession(opts?: { title?: string }): Promise<{ sessionId: string; noteId: string }>;
  /** Finalizes the page, completes the note, ends the session. No-op when idle. */
  endSession(): Promise<void>;
  /**
   * Reopens an existing note and appends a new page after its last one (K10,
   * K11). One mechanism serves both restarting an interrupted session and
   * returning to a finished note. Ends any other open note first. Appending
   * only: no existing page is modified and none is re-finalized.
   */
  resumeNote(noteId: string): Promise<{ sessionId: string; noteId: string }>;
  /**
   * Finalizes the active page and makes a new one the active page.
   * No active note → no-op, resolves null. A *blank* active typed page is
   * instead switched to a live page in place (same id and index) - see
   * `isBlankPage` in src/storage/pages.ts.
   */
  newPage(reason: NewPageReason): Promise<string | null>;
  /**
   * Finalizes the active page and makes a new *typed* page the active page
   * (K32, K35). No active note -> no-op, resolves null, mirroring `newPage`'s
   * own A7 rule: starting a note at all (pen input, or "New note") is a
   * precondition. Pen input while the active page is typed opens a new
   * *live* page instead of writing ink into it (K34) - that is this
   * interface's implementation's business (`src/capture/engine.ts`), not
   * this method's; this method only ever produces a typed page.
   *
   * Switching type on a page that holds nothing yet replaces it rather than
   * adding a page: a blank live page becomes the typed page and a blank typed
   * page is kept, both under the same id and index. Pen input on a blank
   * typed page likewise turns it into the live page.
   */
  newTypedPage(): Promise<string | null>;

  /** Strokes of the active page, including the stroke in progress. For live ink rendering. */
  getLiveStrokes(): readonly PageStroke[];
  /** Fires whenever live strokes change. Consumers throttle (e.g. requestAnimationFrame). */
  subscribeInk(fn: () => void): () => void;
  /** Fires once per page after it is finalized and persisted. F1's transcription queue listens here. */
  subscribePageFinalized(fn: (pageId: string) => void): () => void;
  /**
   * Fires once per note, after `closeNote` has marked it `complete` (and its
   * session `ended`), with the note's id. This is "the note ended" as its
   * own honest signal - fix round 2, Important 1 - rather than something
   * inferred from page events: `closeNote` on a note whose active page is
   * typed finalizes that page without ever emitting `pageFinalized` (typed
   * pages intentionally never do, see `finalizeTypedPage`), which otherwise
   * left auto-naming with nothing to subscribe to for a note that ends on a
   * typed page. A subscriber that reads the note here sees its final state.
   */
  subscribeNoteEnded(fn: (noteId: string) => void): () => void;

  dispose(): void;
}
