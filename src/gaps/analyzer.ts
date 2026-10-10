import { chunkSpeech } from '@/gaps/chunk';
import {
  GAP_CHUNK_CHARS,
  GAP_CHUNK_OVERLAP,
  GAP_DIRECT_CHAR_BUDGET,
  GAP_LEAD_MS,
  GAP_TRAIL_MS,
} from '@/gaps/constants';
import { gapEligibility } from '@/gaps/eligibility';
import { gapPromptVersion, getGapPrompt } from '@/gaps/prompts';
import { dropReviewed, validateGapPoints, type GapPoint } from '@/gaps/validate';
import { segmentsInWindow, speechTextOf, speechWindowForPage } from '@/gaps/window';
import type { TextGenerator } from '@/llm/ollamaText';
import { createGaps, deleteGapsByPage, listGapsByPage } from '@/storage/gaps';
import { getNote } from '@/storage/notes';
import { getPage, listPages, setPageGapAnalysis } from '@/storage/pages';
import { listFinishedRecordings, listRecordingsBySession } from '@/storage/recordings';
import type {
  GapAnalysisMeta,
  GapAnalysisStatus,
  GapSuggestionRecord,
  PageRecord,
  RecordingRecord,
} from '@/storage/types';

export interface GapAnalyzerDeps {
  generator: TextGenerator;
  /** The Ollama model every call in this run uses; also stamped on each suggestion. */
  model: string;
  leadMs?: number;
  trailMs?: number;
  directCharBudget?: number;
  chunkChars?: number;
  chunkOverlap?: number;
  /** Injected for tests. */
  now?: () => number;
}

export interface GapAnalyzer {
  analyzePage(pageId: string, opts?: { signal?: AbortSignal }): Promise<GapSuggestionRecord[]>;
  analyzeNote(noteId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** An abort is the user stopping the run, not a page failing: it ends the loop. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Checked before the first model call rather than left to the generator, so an
 * already-aborted run never reaches Ollama at all. Named `AbortError` because
 * that is what `analyzeNote` and the panel recognise an abort by.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error('Gap analysis aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * The recording a note's speech comes from: the earliest one linked to it (A21),
 * whether linked directly (`recording.noteId`) or through the note's session.
 * `recordings` has no `by-note` index, so the direct link is found by filtering
 * the metadata listing - which is cheap, the audio bytes living in their own
 * store.
 *
 * Only *finished* recordings are candidates (⚑ Wave 1 review finding #2):
 * since K5 a `RecordingRecord` exists from the moment recording starts, with
 * `endedAt: null` and a zero-byte `recordingAudio` row, so gap analysis must
 * never be handed a recording that is still being written. `listRecordings()`
 * becomes `listFinishedRecordings()` for the direct link; `listRecordingsBySession`
 * has no "finished" variant in storage, so its result is filtered here
 * instead of inventing a new storage function for one predicate.
 */
export async function recordingForNote(noteId: string): Promise<RecordingRecord | null> {
  const note = await getNote(noteId);
  const linked = (await listFinishedRecordings()).filter((recording) => recording.noteId === noteId);
  const viaSessionAll =
    typeof note?.sessionId === 'string' ? await listRecordingsBySession(note.sessionId) : [];
  const viaSession = viaSessionAll.filter((recording) => recording.endedAt !== null);

  // De-duplicated by id: a recording linked both ways appears in both listings.
  const candidates = new Map<string, RecordingRecord>();
  for (const recording of [...linked, ...viaSession]) candidates.set(recording.id, recording);

  const ordered = [...candidates.values()].sort(
    (a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return ordered[0] ?? null;
}

export function createGapAnalyzer(deps: GapAnalyzerDeps): GapAnalyzer {
  const now = deps.now ?? Date.now;
  const leadMs = deps.leadMs ?? GAP_LEAD_MS;
  const trailMs = deps.trailMs ?? GAP_TRAIL_MS;
  const directCharBudget = deps.directCharBudget ?? GAP_DIRECT_CHAR_BUDGET;
  const chunkChars = deps.chunkChars ?? GAP_CHUNK_CHARS;
  const chunkOverlap = deps.chunkOverlap ?? GAP_CHUNK_OVERLAP;

  function meta(
    status: GapAnalysisStatus,
    promptVersion: string,
    summarized: boolean,
    error: string | null,
  ): GapAnalysisMeta {
    return { status, at: now(), model: deps.model, promptVersion, error, summarized };
  }

  /**
   * Records the analysis state, swallowing a storage failure with a log: this is
   * also how a failure is recorded, and failing to record a failure must not
   * replace the real error with a storage one.
   */
  async function writeMeta(
    pageId: string,
    status: GapAnalysisStatus,
    promptVersion: string,
    summarized: boolean,
    error: string | null,
  ): Promise<void> {
    try {
      await setPageGapAnalysis(pageId, meta(status, promptVersion, summarized, error));
    } catch (storageError) {
      console.error('[gaps] could not record analysis state', pageId, storageError);
    }
  }

  /** Puts a page back to never-analyzed, with the same guard as `writeMeta`. */
  async function clearMeta(pageId: string): Promise<void> {
    try {
      await setPageGapAnalysis(pageId, null);
    } catch (storageError) {
      console.error('[gaps] could not clear analysis state', pageId, storageError);
    }
  }

  /**
   * One summarize call per chunk, serially: Ollama serves one model at a time,
   * so a parallel fan-out would only queue, and it would turn one slow call into
   * a whole-page timeout. A chunk that summarizes to nothing is skipped rather
   * than failing the run.
   */
  async function summarizeChunks(chunks: string[], signal?: AbortSignal): Promise<string> {
    const spec = getGapPrompt('summarize', deps.model);
    const bullets: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const summary = await deps.generator.generate(
        spec.build({ chunk, index, total: chunks.length }),
        { model: deps.model, system: spec.system, signal },
      );
      const trimmed = summary.trim();
      if (trimmed.length > 0) bullets.push(trimmed);
    }
    return bullets.join('\n');
  }

  /** The one comparison call. `validateGapPoints` is its mandatory `validate` (§6.4). */
  async function compare(
    notes: string,
    speech: string,
    summarized: boolean,
    signal?: AbortSignal,
  ): Promise<GapPoint[]> {
    const spec = getGapPrompt('compare', deps.model);
    return deps.generator.generateJson<GapPoint[]>(spec.build({ notes, speech, summarized }), {
      model: deps.model,
      system: spec.system,
      signal,
      validate: validateGapPoints,
    });
  }

  /**
   * One page, reporting whether it was skipped as well as what it created -
   * `analyzeNote` needs to tell a skip from an analysis that found nothing, and
   * both return no records.
   *
   * `resolvedRecording` is the note's recording when the caller has already found
   * it; `undefined` means nobody has. `recordingForNote` scans every recording's
   * metadata, so a note-wide run passes its one answer down rather than repeating
   * the scan per page.
   */
  async function runPage(
    pageId: string,
    opts: { signal?: AbortSignal },
    resolvedRecording?: RecordingRecord | null,
  ): Promise<{ skipped: boolean; created: GapSuggestionRecord[] }> {
    const page = await getPage(pageId);
    // A missing page is a programming error, not a skip: the caller passed an id
    // that never existed or has been deleted under it.
    if (!page) throw new Error(`Page not found: ${pageId}`);

    const recording =
      resolvedRecording === undefined ? await recordingForNote(page.noteId) : resolvedRecording;
    const window = speechWindowForPage(page, { leadMs, trailMs });

    // Not eligible is a skip that writes **no** `gapAnalysis` at all (A22,
    // P1-A1): stamping `done` on a page that was never compared would tell the
    // panel it had been. The two null checks restate what `gapEligibility`
    // already guarantees, so TypeScript can see it below.
    const eligible = gapEligibility(page, recording, window);
    if (!eligible.ok || recording === null || window === null) {
      return { skipped: true, created: [] };
    }

    // Eligibility has established the page's transcript is `done`.
    const notes = page.transcript?.markdown ?? '';

    // The version a direct comparison would carry: what `running` is stamped
    // with, since nothing is known yet about which path the speech will take.
    // `summarized` is hoisted so the failure path records the version of the run
    // that actually failed.
    const promptVersionDirect = gapPromptVersion(deps.model, false);
    let summarized = false;
    await writeMeta(pageId, 'running', promptVersionDirect, false, null);

    try {
      throwIfAborted(opts.signal);

      const speech = speechTextOf(segmentsInWindow(recording, window.fromMs, window.toMs));
      if (speech.length === 0) {
        // The run happened and honestly found no overlap, so it is recorded
        // `done` - but it compared *nothing*, which is not the same as finding
        // nothing missing. An empty window means a wrongly linked recording, a
        // device clock that disagrees or a legacy import; deleting the page's
        // `proposed` suggestions here would destroy what an earlier run that
        // did compare speech found, with no way back. They stay, and the panel
        // says the window matched no speech rather than "no gaps found".
        await writeMeta(pageId, 'done', promptVersionDirect, false, null);
        return { skipped: false, created: [] };
      }

      summarized = speech.length > directCharBudget;
      let compared = speech;
      if (summarized) {
        const bullets = await summarizeChunks(
          chunkSpeech(speech, { budget: chunkChars, overlap: chunkOverlap }),
          opts.signal,
        );
        // Every chunk summarizing to nothing must not become "the lecture said
        // nothing": compare the raw speech instead, still flagged `summarized`,
        // which is the honest word for "the speech went through the lossy path".
        compared = bullets.length > 0 ? bullets : speech;
      }
      const promptVersion = gapPromptVersion(deps.model, summarized);

      const points = dropReviewed(
        await compare(notes, compared, summarized, opts.signal),
        await listGapsByPage(pageId),
      );

      // Delete only after the model has answered, so a failed run leaves the
      // previous suggestions in place (P1-A2).
      await deleteGapsByPage(pageId, 'proposed');
      const created = await createGaps(
        points.map((point) => ({
          noteId: page.noteId,
          pageId,
          recordingId: recording.id,
          fromMs: window.fromMs,
          toMs: window.toMs,
          text: point.text,
          kind: point.kind,
          sourceQuote: point.sourceQuote,
          model: deps.model,
          promptVersion,
          summarized,
        })),
      );

      await writeMeta(pageId, 'done', promptVersion, summarized, null);
      return { skipped: false, created };
    } catch (error) {
      await writeMeta(
        pageId,
        'failed',
        gapPromptVersion(deps.model, summarized),
        summarized,
        errorMessage(error),
      );
      throw error;
    }
  }

  async function analyzePage(
    pageId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GapSuggestionRecord[]> {
    return (await runPage(pageId, opts)).created;
  }

  /**
   * Every eligible page of a note, serially and in `pageIndex` order. The
   * eligible ones are marked `pending` up front - which is what `pending` means
   * here: waiting its turn in a note-wide run - so the panel can show the whole
   * run rather than one page at a time.
   *
   * A page that throws is logged and the run continues (P1-A10); its own
   * `failed` meta is already on disk. An abort ends the loop and rethrows.
   */
  async function analyzeNote(noteId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const pages: PageRecord[] = await listPages(noteId);
    if (pages.length === 0) return;

    // One recording lookup for the whole note: it reads every recording's
    // metadata, and the answer is the same for every page, so it is passed down
    // to each page rather than looked up again per page.
    const recording = await recordingForNote(noteId);
    const marked = new Set<string>();
    const promptVersion = gapPromptVersion(deps.model, false);
    for (const page of pages) {
      if (!gapEligibility(page, recording, speechWindowForPage(page, { leadMs, trailMs })).ok) {
        continue;
      }
      await writeMeta(page.id, 'pending', promptVersion, false, null);
      marked.add(page.id);
    }

    for (const page of pages) {
      try {
        const run = await runPage(page.id, opts, recording);
        // A page that was eligible during the scan but not by the time its turn
        // came - its transcript re-run, its strokes trimmed - must not keep the
        // `pending` mark: a skipped page carries no `gapAnalysis` (P1-A1), and a
        // stale `pending` would leave the panel saying "Waiting to analyze..."
        // for good. Only marks this run wrote are cleared, so a page that was
        // already ineligible keeps whatever an earlier run recorded.
        if (run.skipped && marked.has(page.id)) await clearMeta(page.id);
      } catch (error) {
        if (isAbort(error)) throw error;
        console.error('[gaps] page analysis failed', page.id, error);
      }
    }
  }

  return { analyzePage, analyzeNote };
}
