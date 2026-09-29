import type { CaptureEngine } from '@/capture/types';
import { createEmitter } from '@/device/emitter';
import { getNote, listNotes } from '@/storage/notes';
import {
  getPage,
  isPageFinalized,
  listPages,
  setPageRender,
  setPageTranscript,
} from '@/storage/pages';
import type { PageStroke, TranscriptRecord, TranscriptStatus } from '@/storage/types';
import { getPromptFor } from '@/transcription/prompts';
import type { PageDims, RenderedPage } from '@/transcription/rasterize';
import type { PageTranscriber } from '@/transcription/types';

/** The settings one job needs, read fresh per job so a change applies at once. */
export interface TranscriptionSettingsSnapshot {
  baseUrl: string;
  model: string;
  renderLongEdge: number;
}

export interface TranscriptionQueueDeps {
  engine: Pick<CaptureEngine, 'subscribePageFinalized'>;
  getSettings(): Promise<TranscriptionSettingsSnapshot>;
  createTranscriber(baseUrl: string): PageTranscriber;
  render(
    strokes: readonly PageStroke[],
    dims: PageDims,
    longEdge: number,
  ): Promise<RenderedPage>;
  now?: () => number;
}

export interface TranscriptionQueue {
  /** Subscribes to finalized pages, then resumes whatever storage left unfinished. Idempotent. */
  start(): Promise<void>;
  /** Resolves once the page is marked `pending` (so a reload resumes it). Dedupes. */
  enqueue(pageId: string): Promise<void>;
  /** Re-runs a page whatever its current status - the manual path for failed and legacy pages. */
  retry(pageId: string): Promise<void>;
  /** Fires with a page id after every transcript status change. */
  subscribe(fn: (pageId: string) => void): () => void;
  /** Resolves when nothing is queued or running. */
  idle(): Promise<void>;
  /** Unsubscribes; the job in flight finishes, no new ones start. */
  stop(): void;
}

/**
 * The serial, resumable page transcription queue (spec §3).
 *
 * Every status change is written to storage before it is announced, so the
 * queue's state after a reload is whatever storage says: `start()` re-enqueues
 * `pending`/`running` pages, which is the only reason a job may run twice and
 * the reason it never silently disappears. Jobs run one at a time because a
 * vision model on a laptop is the bottleneck - two concurrent 180 s requests
 * would make both slower and neither finish sooner.
 */
export function createTranscriptionQueue(deps: TranscriptionQueueDeps): TranscriptionQueue {
  const now = deps.now ?? Date.now;
  const changes = createEmitter<string>();

  const queued: string[] = [];
  let running: string | null = null;
  let draining = false;
  let started = false;
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let idleWaiters: Array<() => void> = [];

  /**
   * Resolves `idle()` waiters when there is nothing left to do. After `stop()`
   * the ids still queued will never run, so they no longer hold `idle()` open -
   * a caller waiting on a stopped queue would otherwise wait forever.
   */
  function settleIdle(): void {
    if (running !== null) return;
    if (!stopped && queued.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  function writeTranscript(
    pageId: string,
    status: TranscriptStatus,
    fields: { model: string; promptVersion: string; markdown?: string; error?: string | null },
  ): Promise<unknown> {
    const record: TranscriptRecord = {
      // Only a `done` transcript carries text. A page going back to
      // pending/running (a retry) must not keep showing the stale markdown of
      // the run it is replacing.
      markdown: status === 'done' ? (fields.markdown ?? '') : '',
      model: fields.model,
      promptVersion: fields.promptVersion,
      status,
      error: fields.error ?? null,
      updatedAt: now(),
    };
    return setPageTranscript(pageId, record);
  }

  function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
  }

  async function runJob(pageId: string): Promise<void> {
    // The page is read here rather than at enqueue time: strokes may have been
    // flushed since, and the page may have been deleted.
    let model = '';
    let promptVersion = '';
    try {
      const page = await getPage(pageId);
      if (!page) return;
      model = page.transcript?.model ?? '';
      promptVersion = page.transcript?.promptVersion ?? '';

      const settings = await deps.getSettings();
      model = settings.model;
      promptVersion = getPromptFor(settings.model).promptVersion;

      if (page.pointCount === 0 || page.strokes.length === 0) {
        await writeTranscript(pageId, 'done', { model, promptVersion, markdown: '' });
        changes.emit(pageId);
        return;
      }

      const note = await getNote(page.noteId);
      const rendered = await deps.render(
        page.strokes,
        { pageWidth: note?.pageWidth ?? null, pageHeight: note?.pageHeight ?? null },
        settings.renderLongEdge,
      );
      await setPageRender(pageId, rendered.blob, rendered.width, rendered.height);
      await writeTranscript(pageId, 'running', { model, promptVersion });
      changes.emit(pageId);

      const result = await deps
        .createTranscriber(settings.baseUrl)
        .transcribePage(rendered.blob, { model: settings.model });
      await writeTranscript(pageId, 'done', {
        model: result.model,
        promptVersion: result.promptVersion,
        markdown: result.markdown,
      });
      changes.emit(pageId);
    } catch (error) {
      await markFailed(pageId, errorMessage(error), model, promptVersion);
    }
  }

  async function markFailed(
    pageId: string,
    message: string,
    model: string,
    promptVersion: string,
  ): Promise<void> {
    try {
      await writeTranscript(pageId, 'failed', { model, promptVersion, error: message });
    } catch (error) {
      // The page may have been deleted between the failure and this write.
      // Either way the worker keeps going: one bad page never stops the queue.
      console.error('[transcription] could not mark page failed', pageId, error);
    }
    changes.emit(pageId);
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && queued.length > 0) {
        const pageId = queued.shift() as string;
        running = pageId;
        try {
          await runJob(pageId);
        } finally {
          running = null;
        }
      }
    } finally {
      draining = false;
      settleIdle();
    }
  }

  async function enqueue(pageId: string): Promise<void> {
    if (stopped) return;
    if (running === pageId || queued.includes(pageId)) return;
    // Queued before the first await, so a second enqueue of the same page
    // (the engine's event racing the startup scan) is deduped rather than run
    // twice.
    queued.push(pageId);

    try {
      const settings = await deps.getSettings();
      await writeTranscript(pageId, 'pending', {
        model: settings.model,
        promptVersion: getPromptFor(settings.model).promptVersion,
      });
      changes.emit(pageId);
    } catch (error) {
      // The pending mark is what makes a queued page survive a reload; losing
      // it is worth a log, but the job still runs and will record its own
      // failure if the cause persists.
      console.error('[transcription] could not mark page pending', pageId, error);
    }

    void drain();
  }

  async function start(): Promise<void> {
    if (started || stopped) return;
    started = true;
    // Subscribe first: the capture engine's startup recovery may announce a
    // finalized page before or after this scan, and a page announced during
    // the scan must not fall between the two.
    unsubscribe = deps.engine.subscribePageFinalized((pageId) => {
      void enqueue(pageId);
    });

    for (const note of await listNotes()) {
      for (const page of await listPages(note.id)) {
        const status = page.transcript?.status;
        if (status === 'pending' || status === 'running') {
          await enqueue(page.id);
          continue;
        }
        // A crash between finalize and enqueue leaves a finished live page with
        // no transcript at all. Legacy/ROM pages are left to `retry` (F1-A5).
        if (!page.transcript && page.source === 'live' && isPageFinalized(page)) {
          await enqueue(page.id);
        }
      }
    }
  }

  return {
    start,
    enqueue,
    retry: (pageId) => enqueue(pageId),
    subscribe: (fn) => changes.subscribe(fn),
    idle() {
      if (running === null && (stopped || queued.length === 0)) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      settleIdle();
    },
  };
}
