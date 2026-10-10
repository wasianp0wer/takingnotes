import type { CaptureEngine } from '@/capture/types';
import { createEmitter } from '@/device/emitter';
import type { TextGenerator } from '@/llm/ollamaText';
import { getNamingPrompt } from '@/notes/naming/prompts';
import { validateNamingResult } from '@/notes/naming/validate';
import { getNote, listNotes, setNoteSummary } from '@/storage/notes';
import { getPage, listPages } from '@/storage/pages';
import type { NoteRecord, PageRecord } from '@/storage/types';
import type { TranscriptionQueue } from '@/transcription/queue';

export interface NamingQueueDeps {
  engine: Pick<CaptureEngine, 'subscribePageFinalized'>;
  transcriptionQueue: Pick<TranscriptionQueue, 'subscribe'>;
  getSettings(): Promise<{ baseUrl: string; model: string }>;
  createGenerator(baseUrl: string): TextGenerator;
}

export interface NamingQueue {
  /** Subscribes to both trigger events, then re-scans whatever storage left unfinished. Idempotent. */
  start(): Promise<void>;
  /** Fires with a note id after every naming attempt (success or failure). */
  subscribe(fn: (noteId: string) => void): () => void;
  /** Resolves when nothing is queued or running. */
  idle(): Promise<void>;
  /** Unsubscribes; the job in flight finishes, no new ones start. */
  stop(): void;
}

/**
 * Whether a page has finished transcribing, for K17's "pages have finished
 * transcribing" test. A `transcript !== null` page is done one way or
 * another (done or failed - see the caller's separate failed-page check);
 * a `typed` page with `transcript === null` is also finished - K33's "blank
 * typed page" is a deliberate terminal state, not a page still waiting on a
 * transcription queue that will never pick it up.
 */
function pageFinishedTranscribing(page: PageRecord): boolean {
  return page.transcript !== null || page.source === 'typed';
}

/**
 * K17-K19: whether a note is ready for the naming job. `legacy` notes and
 * notes still `active` are never eligible; every page must be finished
 * transcribing; and S1-A1 extends K19's "never named" to the whole job, not
 * just the title - a note with any `failed` page transcript is never
 * enqueued at all, so no summary is generated from partial content either.
 */
export function noteReadyForNaming(note: NoteRecord, pages: PageRecord[]): boolean {
  if (note.legacy) return false;
  if (note.status === 'active') return false;
  if (pages.length === 0) return false;
  for (const page of pages) {
    if (!pageFinishedTranscribing(page)) return false;
    if (page.transcript?.status === 'failed') return false;
  }
  return true;
}

/** Each page's markdown (ink/ROM) or text (typed), joined in `pageIndex` order, skipping blank pages. */
function buildNoteText(pages: PageRecord[]): string {
  return [...pages]
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((page) => (page.source === 'typed' ? page.text ?? '' : page.transcript?.markdown ?? ''))
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * The serial, resumable auto-naming queue (K17), modelled on
 * `src/transcription/queue.ts`. One necessary difference from that queue:
 * `NoteRecord` has no spare field to persist an in-progress marker on (the
 * schema is frozen and `src/storage/*` is off limits for this unit - S1-A2),
 * so "resumable" here means re-deriving eligibility from `note.summary ===
 * null` on startup, rather than resuming a persisted `pending` row. A note
 * that already has a summary is not reconsidered by the startup scan, but
 * still is by every later live event - which is what makes K20's "summary
 * keeps updating" true for a note that ends a second time after a resume.
 */
export function createNamingQueue(deps: NamingQueueDeps): NamingQueue {
  const changes = createEmitter<string>();

  const queued: string[] = [];
  let running: string | null = null;
  let draining = false;
  let started = false;
  let stopped = false;
  let unsubPageFinalized: (() => void) | null = null;
  let unsubTranscriptChange: (() => void) | null = null;
  let idleWaiters: Array<() => void> = [];

  function settleIdle(): void {
    if (running !== null) return;
    if (!stopped && queued.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async function runJob(noteId: string): Promise<void> {
    try {
      const note = await getNote(noteId);
      if (!note) return;
      const pages = await listPages(noteId);
      // Re-checked here, not just at enqueue time: a page's transcript may
      // have been retried (now failed, or now running) in the time this
      // note sat in the queue behind another job.
      if (!noteReadyForNaming(note, pages)) return;

      const text = buildNoteText(pages);
      if (text.trim() === '') return;

      const settings = await deps.getSettings();
      const spec = getNamingPrompt();
      const result = await deps
        .createGenerator(settings.baseUrl)
        .generateJson(spec.build({ text }), {
          model: settings.model,
          system: spec.system,
          validate: validateNamingResult,
        });

      await setNoteSummary(noteId, {
        summary: result.summary,
        model: settings.model,
        promptVersion: spec.promptVersion,
        title: result.title,
      });
    } catch (error) {
      // Logged and swallowed, like the transcription queue's own markFailed:
      // one note's naming failure must not stop the queue, and - since
      // there is nowhere to persist "this failed" (S1-A2) - the note simply
      // keeps its existing title/summary until a later event tries again.
      console.error('[naming] note naming failed', noteId, errorMessage(error));
    } finally {
      changes.emit(noteId);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && queued.length > 0) {
        const noteId = queued.shift();
        if (noteId === undefined) break;
        running = noteId;
        try {
          await runJob(noteId);
        } finally {
          running = null;
        }
      }
    } finally {
      draining = false;
      settleIdle();
    }
  }

  function enqueue(noteId: string): void {
    if (stopped) return;
    if (running === noteId || queued.includes(noteId)) return;
    queued.push(noteId);
    void drain();
  }

  /** Checks eligibility before queuing, so an ineligible event never occupies a queue slot at all. */
  async function maybeEnqueue(noteId: string): Promise<void> {
    try {
      const note = await getNote(noteId);
      if (!note) return;
      const pages = await listPages(noteId);
      if (!noteReadyForNaming(note, pages)) return;
      enqueue(noteId);
    } catch (error) {
      console.error('[naming] could not evaluate a note for naming', noteId, errorMessage(error));
    }
  }

  async function handlePageEvent(pageId: string): Promise<void> {
    try {
      const page = await getPage(pageId);
      if (!page) return;
      await maybeEnqueue(page.noteId);
    } catch (error) {
      console.error('[naming] could not evaluate a page event', pageId, errorMessage(error));
    }
  }

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      // Subscribed first, same reasoning as the transcription queue: a note
      // that becomes eligible during the startup scan below must not fall
      // between the scan and the subscription.
      // Passed directly rather than wrapped in `(pageId) => void
      // handlePageEvent(pageId)`: both subscription callback types are
      // declared `=> void`, but at runtime the returned promise still
      // reaches a caller that chooses to read it - which is exactly what
      // lets tests await a fired event's own handling instead of racing it.
      unsubPageFinalized = deps.engine.subscribePageFinalized(handlePageEvent);
      unsubTranscriptChange = deps.transcriptionQueue.subscribe(handlePageEvent);

      for (const note of await listNotes()) {
        if (note.summary !== null) continue;
        await maybeEnqueue(note.id);
      }
    },
    subscribe: (fn) => changes.subscribe(fn),
    idle() {
      if (running === null && (stopped || queued.length === 0)) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    stop() {
      stopped = true;
      unsubPageFinalized?.();
      unsubPageFinalized = null;
      unsubTranscriptChange?.();
      unsubTranscriptChange = null;
      settleIdle();
    },
  };
}
