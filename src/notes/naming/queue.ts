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
  engine: Pick<CaptureEngine, 'subscribePageFinalized' | 'subscribeNoteEnded'>;
  /**
   * `idle` is Fix 2's gate (fix round 2, Important 2): naming's `drain` waits
   * on it before starting each job, so page transcription - the vision model
   * call the owner is actively waiting on - never shares the one local
   * model slot with a naming call. See `drain`'s own comment for why this
   * cannot deadlock or starve naming forever.
   */
  transcriptionQueue: Pick<TranscriptionQueue, 'subscribe' | 'idle'>;
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
 * transcribing" test. Keyed on `transcript.status`, not on nullness (fix
 * round 1, Critical): `transcription/queue.ts`'s `markPending` writes a
 * non-null `pending` transcript record before the model has even run, and
 * the `running` write happens before it finishes either - both would read
 * as "finished" under a bare `transcript !== null` check, which is exactly
 * what let a note get named from whatever pages happened to be `done`
 * while its last page was still queued. Only `done` and `failed` are
 * terminal; `failed` is caught by the caller's separate K19 check. A
 * `typed` page with `transcript === null` is finished regardless - K33's
 * "blank typed page" is a deliberate terminal state, not a page waiting on
 * a transcription queue that will never pick it up.
 */
function pageFinishedTranscribing(page: PageRecord): boolean {
  if (page.source === 'typed') return true;
  const status = page.transcript?.status;
  return status === 'done' || status === 'failed';
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
  let unsubNoteEnded: (() => void) | null = null;
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

  /**
   * Fix 2 (Important): both this queue and the transcription queue issue
   * at most one local Ollama call at a time *within* themselves, but with
   * no shared token between them two concurrent 180 s calls became the
   * normal case - worst on this branch's first launch, where naming's own
   * startup scan enqueues the owner's whole back catalogue right as
   * transcription resumes whatever page backlog survived a reload. Gating
   * on the transcription queue's own `idle()` (it already exposes this)
   * keeps page transcription - what the owner is actively watching -
   * ahead of naming, which only ever fills the gaps.
   *
   * Cannot deadlock: `idle()` only resolves from the transcription queue's
   * own internal `running`/`queued` bookkeeping, which nothing in this
   * function ever blocks or holds a lock on - this loop takes no lock
   * transcription could be waiting on, and the transcription queue's drain
   * loop runs entirely independently of this one; there is no cycle for
   * either side to wait on.
   *
   * Cannot stall naming forever: `idle()` resolves the moment transcription
   * has nothing left queued or running - including "it never started
   * anything at all" - so there is no reachable state where transcription
   * holds this gate shut while genuinely idle. `stopped` is re-checked
   * after the await too, so `stop()` called while this is waiting still
   * breaks the loop instead of running one more job.
   */
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && queued.length > 0) {
        await deps.transcriptionQueue.idle();
        if (stopped) break;
        // The queue may have been emptied (or `stop()`ped) while the above
        // was pending - re-read rather than assume it's still non-empty.
        if (queued.length === 0) break;

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

  /**
   * The third trigger (fix round 2, Important 1): `closeNote` emits this
   * directly with the note id, so there is no page to look up first - unlike
   * `handlePageEvent`, which has to go by way of a page to find its note.
   * Handles the one reachable shape the other two triggers miss entirely: a
   * note that ends on a typed active page, for which the engine deliberately
   * never emits `pageFinalized` (see `finalizeTypedPage`'s comment in
   * `src/capture/engine.ts`).
   */
  async function handleNoteEndedEvent(noteId: string): Promise<void> {
    await maybeEnqueue(noteId);
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
      // Third trigger (fix round 2, Important 1): "the note ended" as its
      // own honest signal, rather than inferred from a page event that a
      // typed-page ending never produces.
      unsubNoteEnded = deps.engine.subscribeNoteEnded(handleNoteEndedEvent);

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
      unsubNoteEnded?.();
      unsubNoteEnded = null;
      settleIdle();
    },
  };
}
