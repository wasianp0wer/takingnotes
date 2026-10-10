import { createStrokeSegmenter, DEFAULT_MAX_GAP_MS } from '@/capture/segmenter';
import type { CaptureEngine, CaptureState, NewPageReason } from '@/capture/types';
import type { DeviceController } from '@/device/controller';
import { createEmitter } from '@/device/emitter';
import { createNote, getNote, listNotes, updateNote } from '@/storage/notes';
import {
  createPage,
  finalizePage,
  isPageFinalized,
  listPages,
  pageEndedAt,
  setPageStrokes,
} from '@/storage/pages';
import { createSession, getSession, listSessions, updateSession } from '@/storage/sessions';
import type { PageStroke, SessionStatus } from '@/storage/types';
import type { HuionPenPoint } from '@/utils/huionBLE';
import {
  HUION_DEFAULT_PAGE_HEIGHT_A5,
  HUION_DEFAULT_PAGE_WIDTH_A5,
} from '@/utils/huionProtocol';

export interface CaptureEngineDeps {
  controller: DeviceController;
  now?: () => number;
  flushIntervalMs?: number;
  maxGapMs?: number;
}

/**
 * What the live engine actually publishes. `CaptureState` (foundations-owned,
 * `src/capture/types.ts`) has no field for "a manually started session is open"
 * or for when it began, and P3 does not own that file, so the engine adds one
 * optional field to the same object (spec P3-A1). It is *absent* - not null -
 * while idle and for bare notes, so nothing that reads `CaptureState` changes
 * shape.
 */
export interface LiveCaptureState extends CaptureState {
  /** Present only while a session started by `startSession()` is open. */
  sessionStartedAt?: number;
}

/**
 * When the open manual session began, or null when none is. The reader exists
 * so `SessionControls` can ask a plain `CaptureState` (what the context hands
 * it) without a cast.
 */
export function sessionStartedAtOf(state: CaptureState): number | null {
  const at = (state as LiveCaptureState).sessionStartedAt;
  return typeof at === 'number' ? at : null;
}

export interface LiveCaptureEngine extends CaptureEngine {
  getState(): LiveCaptureState;
  /**
   * Attaches to the pen stream, starts the flush timer and runs startup
   * recovery. Idempotent; resolves when recovery has finished. Called
   * implicitly by every public method except getState/dispose.
   */
  start(): Promise<void>;
  /** Persists the active buffer now; resolves once every queued write has landed. */
  flush(): Promise<void>;
}

export const DEFAULT_FLUSH_INTERVAL_MS = 1000;

const idleState: CaptureState = {
  activeSessionId: null,
  activeNoteId: null,
  activePageId: null,
  pageIndex: -1,
};

/**
 * The in-memory tail of one page: the strokes the segmenter has closed but the
 * database may not have yet. `pageId` is null until the page record exists -
 * the window between the first pen point and the end of the auto-started
 * `startNote()`, during which writing still has to be kept.
 *
 * Every queued operation captures the *object*, not the id, so an op that runs
 * after the page record finally exists still finds it (see `newPage`, where
 * two concurrent turns each hold their own buffer).
 */
interface Buffer {
  pageId: string | null;
  strokes: PageStroke[];
  /** True when `strokes` holds something the database does not. */
  dirty: boolean;
}

function freshBuffer(): Buffer {
  return { pageId: null, strokes: [], dirty: false };
}

/**
 * A snapshot of the stroke in progress. The segmenter keeps appending to its
 * open stroke, so both persistence and live rendering need a copy - handing out
 * the live object would let the points array grow underneath an in-flight
 * `setPageStrokes` (or underneath a React render).
 */
function copyStroke(stroke: PageStroke): PageStroke {
  return { ...stroke, points: [...stroke.points] };
}

/**
 * The live capture engine: it turns the controller's pen stream into Session,
 * Note and Page records (docs/features/f1-spec.md §2.2).
 *
 * Two structures carry the whole design:
 *
 * - **The buffer.** Pen points go to a stroke segmenter, whose closed strokes
 *   land in the current `Buffer`. A flush writes `[...buffer.strokes, open?]`
 *   with `setPageStrokes`, which replaces rather than appends - so re-flushing
 *   is idempotent and a crash costs at most the last `flushIntervalMs` of the
 *   stroke in progress. A page turn swaps in a fresh buffer synchronously, so
 *   the next pen point already belongs to the next page even though that page
 *   record does not exist yet.
 * - **The op chain.** Every database write runs on one serial promise chain, so
 *   concurrent `newPage`/`endNote` calls queue instead of interleaving (two
 *   turns arriving in the same tick must not both read `pageIndex` and produce
 *   two page 1s). `state` is only ever published from inside an op, which is
 *   what lets an op read the active note/session ids off it.
 *
 * Construction has no side effects. `main.tsx` builds the engine in a
 * `useState` initializer, which React StrictMode invokes twice in development
 * and discards one result of; an engine that subscribed to the pen in its
 * constructor would leave that discarded twin auto-starting duplicate notes.
 * `start()` does the attaching - it is idempotent, and every public method
 * except `getState`/`dispose` calls it first, so the engine the app keeps is
 * attached by the `subscribe` that `useSyncExternalStore` performs on it.
 */
export function createCaptureEngine(deps: CaptureEngineDeps): LiveCaptureEngine {
  const controller = deps.controller;
  const now = deps.now ?? Date.now;
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const segmenter = createStrokeSegmenter({ maxGapMs: deps.maxGapMs ?? DEFAULT_MAX_GAP_MS });

  const stateEmitter = createEmitter<LiveCaptureState>();
  const inkEmitter = createEmitter<void>();
  const pageFinalizedEmitter = createEmitter<string>();

  let state: LiveCaptureState = { ...idleState };
  let disposed = false;

  /**
   * Whether a note is open, decided synchronously. `startNote` is async, so a
   * `newPage` or `endNote` arriving while the records are still being created
   * would otherwise see no active note and drop the turn; this flag flips
   * before any await, so those calls queue behind the creation instead.
   */
  let noteOpen = false;
  /**
   * Bumped by every `openNote` call. A failed creation rolls `noteOpen` back
   * only while it is still the newest opener: without this, an opener that
   * fails *after* a second one has queued behind it would clear the flag the
   * second one set, and the next pen-down would auto-start a third note on top
   * of the one that succeeded.
   */
  let openerSeq = 0;
  /**
   * The resume whose op has been enqueued but has not published state yet, if
   * any. `state` is only published from inside an op, so the no-op guard in
   * `resumeNote` cannot see an in-flight resume - and without this, a second
   * click arriving in the same tick would fall through to `closeNote()` and
   * finalize the page the first one just opened for writing.
   */
  let pendingResume: { noteId: string; result: Promise<{ sessionId: string; noteId: string }> } | null =
    null;

  let buffer: Buffer = freshBuffer();
  /** Cache behind `getLiveStrokes`, invalidated whenever the ink changes. */
  let liveStrokes: readonly PageStroke[] | null = null;

  let started: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let unsubscribePen: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Replaces the whole object rather than mutating it: `useSyncExternalStore`
  // needs a new reference per change and a stable one in between.
  function setState(next: LiveCaptureState) {
    state = next;
    if (!disposed) stateEmitter.emit(state);
  }

  function emitInk() {
    liveStrokes = null;
    if (!disposed) inkEmitter.emit();
  }

  function emitPageFinalized(pageId: string) {
    if (!disposed) pageFinalizedEmitter.emit(pageId);
  }

  /**
   * Appends `op` to the serial chain and hands the caller the op's own promise.
   * The stored tail swallows rejections (after logging them) so one failed write
   * neither kills the chain nor surfaces as an unhandled rejection - and because
   * that `catch` handles `result` itself, a fire-and-forget caller (the pen
   * handler's auto-start) cannot produce one either. The caller's copy still
   * rejects, so an awaited `startNote()` reports a real failure.
   */
  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = chain.then(op, op);
    chain = result.catch((error: unknown) => {
      console.error('[capture] operation failed', error);
    });
    return result;
  }

  function devicePageNum(): number | null {
    const device = controller.getState();
    return device.isConnected ? device.storedPageCount + 1 : null;
  }

  /**
   * Writes the buffer's strokes plus a snapshot of the stroke in progress.
   * Cheap to call redundantly: it returns early when there is nothing new, and
   * `setPageStrokes` replaces the whole array, so a repeat write is a no-op.
   */
  function flushBuffer(b: Buffer): Promise<void> {
    if (b.pageId === null) return Promise.resolve();
    // The open stroke belongs to whichever buffer is current; an older buffer's
    // own last stroke was force-closed into it by `closeBuffer`.
    if (!b.dirty && !(b === buffer && segmenter.current())) return Promise.resolve();

    return enqueue(async () => {
      const pageId = b.pageId;
      if (pageId === null) return;
      const open = b === buffer ? segmenter.current() : null;
      const closedCount = b.strokes.length;
      const snapshot = open ? [...b.strokes, copyStroke(open)] : [...b.strokes];
      try {
        await setPageStrokes(pageId, snapshot);
        // A stroke that closed while the write was in flight is not on disk
        // yet, so the buffer stays dirty for the next flush.
        if (b.strokes.length === closedCount) b.dirty = false;
      } catch (error) {
        // Left dirty deliberately: the next flush retries it.
        console.error('[capture] flush failed', error);
      }
    });
  }

  /**
   * Ends the stroke in progress onto the current buffer and swaps in a fresh
   * one. Synchronous, so pen points arriving after a page turn already belong
   * to the next page. Returns the buffer that was just closed.
   */
  function closeBuffer(): Buffer {
    const old = buffer;
    const open = segmenter.end();
    if (open) {
      old.strokes.push(open);
      old.dirty = true;
    }
    buffer = freshBuffer();
    emitInk();
    return old;
  }

  /**
   * Persists a closed buffer and marks its page finalized. Returns the page id
   * when both landed - `pageFinalized` must not fire for a page whose strokes
   * are not on disk, nor for a buffer that never got a page record at all.
   */
  async function closeOldPage(old: Buffer): Promise<string | null> {
    const pageId = old.pageId;
    if (pageId === null) return null;
    try {
      await setPageStrokes(pageId, [...old.strokes]);
      await finalizePage(pageId, now());
      old.dirty = false;
      return pageId;
    } catch (error) {
      // A page turn must still open the next page: dropping it would send the
      // rest of the note's writing onto a page that is already closed.
      console.error('[capture] closing a page failed', error);
      return null;
    }
  }

  /** The closing half of `endNote`, with the "is a note open" check already done. */
  function closeNote(): Promise<void> {
    const old = closeBuffer();
    noteOpen = false;

    return enqueue(async () => {
      const finalizedId = await closeOldPage(old);
      // Read from `state` inside the op: only ops publish it, so here it still
      // describes the note this call is closing.
      const noteId = state.activeNoteId;
      const sessionId = state.activeSessionId;
      const endedAt = now();
      try {
        if (noteId !== null) await updateNote(noteId, { status: 'complete', endedAt });
        if (sessionId !== null) await updateSession(sessionId, { status: 'ended', endedAt });
      } catch (error) {
        console.error('[capture] ending the note failed', error);
      }
      setState({ ...idleState });
      if (finalizedId !== null) emitPageFinalized(finalizedId);
    });
  }

  /** `endNote`/`endSession`: the close path, or nothing when idle. */
  function endOpenNote(): Promise<void> {
    void start();
    if (!noteOpen) return Promise.resolve();
    return closeNote();
  }

  /**
   * Startup recovery: a note left `active` means the app died mid-session.
   * Runs as the first op on the chain, so every later write sees a clean store.
   */
  async function recover(): Promise<void> {
    const finalized: string[] = [];
    try {
      for (const note of await listNotes()) {
        if (note.legacy || note.status !== 'active') continue;
        try {
          const pages = await listPages(note.id);
          let endedAt = 0;
          for (const page of pages) {
            const at = pageEndedAt(page);
            if (at > endedAt) endedAt = at;
          }
          for (const page of pages) {
            if (isPageFinalized(page)) continue;
            await finalizePage(page.id, now());
            finalized.push(page.id);
          }
          const at = endedAt > 0 ? endedAt : now();
          await updateNote(note.id, { status: 'interrupted', endedAt: at });
          if (note.sessionId) await updateSession(note.sessionId, { status: 'ended', endedAt: at });
        } catch (error) {
          // One unrecoverable note must not leave the others active.
          console.error('[capture] recovering a note failed', error);
        }
      }

      // Sessions with no active note of their own (Phase 2 can outlive one).
      for (const session of await listSessions()) {
        if (session.status !== 'active') continue;
        await updateSession(session.id, { status: 'ended', endedAt: now() });
      }
    } catch (error) {
      console.error('[capture] recovery failed', error);
    }

    // After the writes: a listener queues these pages for transcription.
    for (const pageId of finalized) emitPageFinalized(pageId);
  }

  function handlePen(point: HuionPenPoint) {
    if (disposed) return;
    const result = segmenter.push(point, now());

    if (result.closed) {
      buffer.strokes.push(result.closed);
      buffer.dirty = true;
      void flushBuffer(buffer);
    }

    // An open stroke after the push means a down point just arrived. Asking the
    // segmenter rather than re-deciding what "down" means keeps one definition
    // of it (segmenter.ts), so the two can never drift apart.
    //
    // Writing is never dropped: the points already sit in `buffer`, and the note
    // this starts adopts that same buffer as its page 0.
    if (segmenter.current() !== null && !noteOpen) void startNote();

    if (result.changed) emitInk();
  }

  function start(): Promise<void> {
    if (started) return started;
    if (disposed) return Promise.resolve();

    unsubscribePen = controller.subscribePen(handlePen);
    timer = setInterval(() => {
      if (buffer.dirty || segmenter.current()) void flushBuffer(buffer);
    }, flushIntervalMs);

    // First on the chain, so nothing else can write before recovery has run.
    started = enqueue(recover);
    return started;
  }

  /**
   * Opens Session + Note + page 0 and makes them active, ending any open note
   * first. Both entry points funnel through here: `startNote` for bare notes and
   * pen-input auto-start, `startSession` for a manual session (P3).
   *
   * `map` runs inside the op, so a caller gets the ids of the records *this*
   * call created. Reading them off published state after the await would hand
   * two concurrent callers the same, newer session. It also keeps the returned
   * promise the one `enqueue` already attached a handler to, so the pen
   * handler's fire-and-forget `void startNote()` cannot produce an unhandled
   * rejection.
   */
  function openNote<T>(
    opts: { title?: string; manual: boolean },
    map: (ids: { sessionId: string; noteId: string }) => T,
  ): Promise<T> {
    void start();
    if (noteOpen) void closeNote();
    noteOpen = true;
    const opener = ++openerSeq;
    const b = buffer;

    return enqueue(async () => {
      let ids: { sessionId: string; noteId: string };
      // Declared out here so the rollback below can end a session whose note or
      // page write never landed.
      let createdSessionId: string | null = null;
      try {
        const startedAt = now();
        const stamp = new Date(startedAt).toLocaleString();
        const title = opts.title ?? `${opts.manual ? 'Session' : 'Note'} ${stamp}`;
        const device = controller.getState();

        const session = await createSession({ title, startedAt });
        createdSessionId = session.id;
        const note = await createNote({
          title,
          deviceId: device.deviceName || 'huion',
          deviceType: 'huion',
          deviceName: device.deviceName || null,
          pageBaseline: device.isConnected ? device.storedPageCount : 0,
          pageWidth: HUION_DEFAULT_PAGE_WIDTH_A5,
          pageHeight: HUION_DEFAULT_PAGE_HEIGHT_A5,
          sessionId: session.id,
          startedAt,
        });
        // Whatever arrived during the auto-start window is written with the
        // page itself, so nothing needs a second round trip.
        const buffered = [...b.strokes];
        const page = await createPage({
          noteId: note.id,
          pageIndex: 0,
          devicePageNum: devicePageNum(),
          source: 'live',
          strokes: buffered,
          capturedAt: startedAt,
        });

        b.pageId = page.id;
        if (b.strokes.length === buffered.length) b.dirty = false;
        const next: LiveCaptureState = {
          activeSessionId: session.id,
          activeNoteId: note.id,
          activePageId: page.id,
          pageIndex: 0,
        };
        // Only a manual session is a session as far as the header is concerned.
        if (opts.manual) next.sessionStartedAt = startedAt;
        setState(next);
        // Anything written since that snapshot (the stroke in progress, or a
        // stroke that closed mid-creation).
        void flushBuffer(b);
        ids = { sessionId: session.id, noteId: note.id };
      } catch (error) {
        // No note is open after all, so the next pen point tries again rather
        // than accumulating into a buffer that will never have a page - unless a
        // later opener has already claimed the flag, whose own op has not run
        // yet (or has already succeeded).
        if (openerSeq === opener) noteOpen = false;
        // The session write landed but the note or page did not: without this the
        // row would sit `active` with no note for the rest of the run, and only
        // the next startup recovery would end it. Sessions are user-visible in
        // Phase 2, and P1 reads them, so storage stays self-consistent now.
        // Deliberately after the flag rollback and reported rather than thrown:
        // the caller must see the original failure, not this cleanup's.
        if (createdSessionId !== null) {
          try {
            await updateSession(createdSessionId, { status: 'ended', endedAt: now() });
          } catch (cleanupError) {
            console.error('[capture] ending a half-created session failed', cleanupError);
          }
        }
        throw error;
      }
      // Outside the `try`: the records are written and the state published, so a
      // throwing `map` must not roll `noteOpen` back on a note that is open.
      return map(ids);
    });
  }

  function startNote(opts: { title?: string } = {}): Promise<string> {
    return openNote({ title: opts.title, manual: false }, (ids) => ids.noteId);
  }

  function startSession(
    opts: { title?: string } = {},
  ): Promise<{ sessionId: string; noteId: string }> {
    return openNote({ title: opts.title, manual: true }, (ids) => ids);
  }

  function newPage(reason: NewPageReason): Promise<string | null> {
    void start();
    // A7: a page turn with no note is ignored; the next pen point starts one.
    if (!noteOpen) return Promise.resolve(null);

    const old = closeBuffer();
    const next = buffer;

    return enqueue(async () => {
      const finalizedId = await closeOldPage(old);
      const noteId = state.activeNoteId;
      // Only reachable if the note's own creation failed; there is nothing to
      // add a page to. `old`'s strokes are dropped with it, deliberately: this
      // turn queued behind a creation that never produced a note, so there is no
      // page anywhere to attach them to. Needs a storage write failure and a page
      // turn in the same window.
      if (noteId === null) return null;

      const pageIndex = state.pageIndex + 1;
      // A turn mid-stroke: the rest of that stroke was already buffered against
      // the new page, so the page is created holding it.
      const buffered = [...next.strokes];
      const page = await createPage({
        noteId,
        pageIndex,
        // A device turn has already advanced the stored count, so it names the
        // page being turned to. A manual page has no device page at all.
        devicePageNum: reason === 'device-turn' ? devicePageNum() : null,
        source: 'live',
        strokes: buffered,
        // Same clock as the strokes, so recovery can date a page from it.
        capturedAt: now(),
      });

      next.pageId = page.id;
      if (next.strokes.length === buffered.length) next.dirty = false;
      setState({ ...state, activePageId: page.id, pageIndex });
      if (finalizedId !== null) emitPageFinalized(finalizedId);
      // Anything written since that snapshot: the stroke in progress on the new
      // page, or one that closed while the page was being created.
      void flushBuffer(next);
      return page.id;
    });
  }

  /**
   * Reopens an existing note (K10, K11). Appending only: the note's existing
   * pages are never rewritten, and the note keeps its original `startedAt` -
   * only `status`/`endedAt` move.
   *
   * It is deliberately not a call into `openNote`: that function's whole job is
   * creating a Session, Note and page 0, and the two share only the flag
   * discipline around `noteOpen`/`openerSeq`, which is reproduced here for the
   * same reason - a `newPage` or `endNote` arriving while these async reads run
   * must queue behind them rather than see no active note and drop the turn.
   */
  function resumeNote(noteId: string): Promise<{ sessionId: string; noteId: string }> {
    void start();

    // Already the open note. Falling through would close and reopen it,
    // finalizing the live page and discarding the stroke in progress - a
    // double-click on Resume must not cost the sentence being written.
    if (noteOpen && state.activeNoteId === noteId && state.activeSessionId !== null) {
      return Promise.resolve({ sessionId: state.activeSessionId, noteId });
    }

    // Already being resumed, by a call whose op has not run yet: hand back the
    // same promise rather than starting a second resume of the same note.
    // `state` is only published from inside an op, so the guard above cannot
    // see this case - without it, this second call would fall through to
    // `closeNote()` and finalize the page the first call's op is about to open.
    if (pendingResume !== null && pendingResume.noteId === noteId) return pendingResume.result;

    if (noteOpen) void closeNote();
    noteOpen = true;
    const opener = ++openerSeq;
    const b = buffer;

    const result = enqueue(async () => {
      let createdSessionId: string | null = null;
      // The session row's own previous state, captured before it is flipped
      // active for this resume - restored on failure so a reused session is
      // never left dangling `active` with a note that never actually reopened.
      let restoreSession: { id: string; status: SessionStatus; endedAt: number | null } | null = null;
      const finalized: string[] = [];
      try {
        const at = now();
        const note = await getNote(noteId);
        if (!note) throw new Error(`Note not found: ${noteId}`);

        // A legacy or imported note has no session, and a note can name a
        // session row that has since been deleted. Either way every note is
        // resumable (K14), so a missing session is created rather than fatal.
        let sessionId = note.sessionId ?? null;
        if (sessionId !== null) {
          const existingSession = await getSession(sessionId);
          if (!existingSession) {
            sessionId = null;
          } else {
            restoreSession = {
              id: existingSession.id,
              status: existingSession.status,
              endedAt: existingSession.endedAt,
            };
          }
        }
        if (sessionId === null) {
          const session = await createSession({
            title: note.title,
            startedAt: note.startedAt,
          });
          createdSessionId = session.id;
          sessionId = session.id;
        } else {
          await updateSession(sessionId, { status: 'active', endedAt: null });
        }

        const pages = await listPages(noteId);
        // A page left open by an interruption is closed before appending, so
        // the note never holds two unfinalized pages. Finalized at the time the
        // writing stopped, not now: see `pageEndedAt`.
        for (const page of pages) {
          if (isPageFinalized(page)) continue;
          await finalizePage(page.id, pageEndedAt(page));
          finalized.push(page.id);
        }

        // `pages` is `pageIndex`-sorted by `listPages`, but max-of-last is read
        // from the sort rather than assumed: an empty note starts at 0.
        const pageIndex = pages.length > 0 ? pages[pages.length - 1].pageIndex + 1 : 0;

        await updateNote(noteId, {
          status: 'active',
          endedAt: null,
          ...(note.sessionId === sessionId ? {} : { sessionId }),
        });

        // Whatever the pen wrote during these reads belongs to the new page.
        const buffered = [...b.strokes];
        const page = await createPage({
          noteId,
          pageIndex,
          devicePageNum: devicePageNum(),
          source: 'live',
          strokes: buffered,
          capturedAt: at,
        });

        b.pageId = page.id;
        if (b.strokes.length === buffered.length) b.dirty = false;
        setState({
          activeSessionId: sessionId,
          activeNoteId: noteId,
          activePageId: page.id,
          pageIndex,
          // K13: the header clock measures this sitting. A note resumed three
          // days later must not show a 72-hour timer.
          sessionStartedAt: at,
        });
        void flushBuffer(b);
        for (const pageId of finalized) emitPageFinalized(pageId);
        return { sessionId, noteId };
      } catch (error) {
        if (openerSeq === opener) noteOpen = false;
        if (createdSessionId !== null) {
          try {
            await updateSession(createdSessionId, { status: 'ended', endedAt: now() });
          } catch (cleanupError) {
            console.error('[capture] ending a half-created session failed', cleanupError);
          }
        }
        if (restoreSession !== null) {
          try {
            await updateSession(restoreSession.id, {
              status: restoreSession.status,
              endedAt: restoreSession.endedAt,
            });
          } catch (cleanupError) {
            console.error('[capture] restoring a reused session failed', cleanupError);
          }
        }
        // Whatever pages the finalize loop got to already landed in storage
        // before this failed, so their transcription trigger is still owed -
        // the note's status never changed, so startup recovery will not
        // revisit them either.
        for (const pageId of finalized) emitPageFinalized(pageId);
        throw error;
      }
    });
    const mine = { noteId, result };
    pendingResume = mine;
    // Cleared only while still the newest pending resume, so a later resume's
    // own marker is not wiped by an earlier one settling after it.
    void result.catch(() => undefined).finally(() => {
      if (pendingResume === mine) pendingResume = null;
    });
    return result;
  }

  return {
    getState() {
      return state;
    },
    subscribe(fn) {
      void start();
      return stateEmitter.subscribe(fn);
    },

    start,
    startNote,
    startSession,
    resumeNote,
    newPage,

    endNote: endOpenNote,
    // One session is one note, started and ended together (spec J4), so ending
    // the session is the same close path: finalize the page, complete the note,
    // end the session.
    endSession: endOpenNote,

    async flush() {
      void start();
      await flushBuffer(buffer);
      // Everything already queued - a pen-up flush, an in-flight startNote -
      // may still be in the air, and an op can enqueue another (a page creation
      // schedules a flush of its own). Drain to a fixed point, so `flush()` is a
      // real "it is all on disk" moment. The tail never rejects (see `enqueue`).
      let tail: Promise<unknown>;
      do {
        tail = chain;
        await tail;
      } while (tail !== chain);
    },

    getLiveStrokes() {
      void start();
      if (!liveStrokes) {
        const open = segmenter.current();
        liveStrokes = open ? [...buffer.strokes, copyStroke(open)] : [...buffer.strokes];
      }
      return liveStrokes;
    },
    subscribeInk(fn) {
      void start();
      return inkEmitter.subscribe(fn);
    },
    subscribePageFinalized(fn) {
      void start();
      return pageFinalizedEmitter.subscribe(fn);
    },

    dispose() {
      disposed = true;
      unsubscribePen?.();
      unsubscribePen = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
