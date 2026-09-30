import { createStrokeSegmenter, DEFAULT_MAX_GAP_MS } from '@/capture/segmenter';
import type { CaptureEngine, CaptureState, NewPageReason } from '@/capture/types';
import type { DeviceController } from '@/device/controller';
import { createEmitter } from '@/device/emitter';
import { createNote, listNotes, updateNote } from '@/storage/notes';
import {
  createPage,
  finalizePage,
  isPageFinalized,
  listPages,
  setPageStrokes,
} from '@/storage/pages';
import { createSession, listSessions, updateSession } from '@/storage/sessions';
import type { PageStroke } from '@/storage/types';
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

export interface LiveCaptureEngine extends CaptureEngine {
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

  const stateEmitter = createEmitter<CaptureState>();
  const inkEmitter = createEmitter<void>();
  const pageFinalizedEmitter = createEmitter<string>();

  let state: CaptureState = { ...idleState };
  let disposed = false;

  /**
   * Whether a note is open, decided synchronously. `startNote` is async, so a
   * `newPage` or `endNote` arriving while the records are still being created
   * would otherwise see no active note and drop the turn; this flag flips
   * before any await, so those calls queue behind the creation instead.
   */
  let noteOpen = false;
  /**
   * Bumped by every `startNote` call. A failed creation rolls `noteOpen` back
   * only while it is still the newest opener: without this, a `startNote` that
   * fails *after* a second one has queued behind it would clear the flag the
   * second one set, and the next pen-down would auto-start a third note on top
   * of the one that succeeded.
   */
  let openerSeq = 0;

  let buffer: Buffer = freshBuffer();
  /** Cache behind `getLiveStrokes`, invalidated whenever the ink changes. */
  let liveStrokes: readonly PageStroke[] | null = null;

  let started: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let unsubscribePen: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Replaces the whole object rather than mutating it: `useSyncExternalStore`
  // needs a new reference per change and a stable one in between.
  function setState(next: CaptureState) {
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
            for (const stroke of page.strokes) {
              if (stroke.endedAt !== undefined && stroke.endedAt > endedAt) endedAt = stroke.endedAt;
            }
            if (page.capturedAt > endedAt) endedAt = page.capturedAt;
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

  function startNote(opts: { title?: string } = {}): Promise<string> {
    void start();
    if (noteOpen) void closeNote();
    noteOpen = true;
    const opener = ++openerSeq;
    const b = buffer;

    return enqueue(async () => {
      try {
        const startedAt = now();
        const title = opts.title ?? `Note ${new Date(startedAt).toLocaleString()}`;
        const device = controller.getState();

        const session = await createSession({ title, startedAt });
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
        setState({
          activeSessionId: session.id,
          activeNoteId: note.id,
          activePageId: page.id,
          pageIndex: 0,
        });
        // Anything written since that snapshot (the stroke in progress, or a
        // stroke that closed mid-creation).
        void flushBuffer(b);
        return note.id;
      } catch (error) {
        // No note is open after all, so the next pen point tries again rather
        // than accumulating into a buffer that will never have a page - unless a
        // later `startNote` has already claimed the flag, whose own op has not
        // run yet (or has already succeeded).
        if (openerSeq === opener) noteOpen = false;
        throw error;
      }
    });
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
      // add a page to.
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
    newPage,

    endNote() {
      void start();
      if (!noteOpen) return Promise.resolve();
      return closeNote();
    },

    // Phase 2's session flow belongs to P3 (docs/architecture.md §6.7). What is
    // here is the thin delegation the interface needs to compile, and it is
    // already correct for Phase 1's shape - `startNote` creates exactly one
    // session per note and `endNote` ends it - so the tree stays green and
    // behaviour does not change until P3 implements the real thing.
    async startSession(opts = {}) {
      const noteId = await startNote(opts);
      const sessionId = state.activeSessionId;
      if (sessionId === null) {
        // Unreachable while `startNote` creates the session it opens the note
        // in; asserted rather than fudged so a future divergence is loud.
        throw new Error('Session started without a session id');
      }
      return { sessionId, noteId };
    },

    endSession() {
      void start();
      if (!noteOpen) return Promise.resolve();
      return closeNote();
    },

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
