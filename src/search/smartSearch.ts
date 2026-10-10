import type { SearchCorpus, SearchNote } from '@/search/corpus';
import { getBandPrompt, getScreenPrompt, type ScreenCandidate, type SmartSearchBand } from '@/search/prompts';
import { batchScreenCandidates } from '@/search/screenBatch';
import { validateBandResult, validateScreenIndices } from '@/search/validate';
import type { TextGenerator } from '@/llm/ollamaText';

/** Stage 1 only needs enough text to judge topic, not the whole lecture. */
export const SCREEN_TEXT_MAX = 1000;
/** K46's fallback is tighter still - a gist, not the detail stage 2 reads in full. */
export const SCREEN_FALLBACK_TEXT_MAX = 800;
/** Fix round 3, C1: audio text is a gist for screening too, same tier as the fallback. */
export const SCREEN_AUDIO_TEXT_MAX = 800;
/** Stage 2 reads a candidate's full page text and recording transcript, capped against an unusually long note. */
export const DETAIL_TEXT_MAX_CHARS = 12_000;

export interface SmartSearchHit {
  noteId: string;
  noteTitle: string;
  band: SmartSearchBand;
  reason: string;
  /**
   * Fix round 3, C1: the recording the hit should open instead of a page,
   * set only when the note has no page text to point at (the ruling for
   * smart search's band granularity: a hit stays note-granular, but a note
   * found only through its recording should offer that recording as the
   * target, not a page it was never pointing at). `undefined` whenever the
   * note has page text - then the hit opens the note itself, as before.
   */
  recordingId?: string;
}

export interface SmartSearchResult {
  strong: SmartSearchHit[];
  moderate: SmartSearchHit[];
  weak: SmartSearchHit[];
  /** Notes with `summary === null`, screened by title + page text/recording instead (K44/K46). */
  unsummarizedCount: number;
  /**
   * Fix round 3, I1: the subset of `unsummarizedCount` with *no* page text
   * and *no* recording text either - screened on a bare title, not "title
   * and page text" as K46's fallback message could otherwise overclaim.
   * Always `<= unsummarizedCount`.
   */
  titleOnlyCount: number;
  /**
   * Candidates whose screening or banding then failed (S6-A4) - a note
   * smart search could not check, not one it checked and found no match
   * in. Fix round 1, Finding 2: dropping a failed candidate so it cannot
   * cost the rest of an already-screened run was the right call; reporting
   * it as indistinguishable from "no match" was not. Fix round 3, I2: a
   * failed *screen* batch now also counts here (every candidate in that
   * batch), not only a failed band call - batching means "the screen
   * stage" is no longer one atomic call whose single failure can be
   * cleanly surfaced as *the* error, so a screen-batch failure degrades
   * the same way a band failure already did.
   */
  uncheckedCount: number;
}

export interface SmartSearchDeps {
  generator: TextGenerator;
  model: string;
}

const cap = (text: string, max: number): string => text.trim().slice(0, max);

function joinedPageText(note: SearchNote): string {
  return note.pages
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/**
 * Fix round 3, C1: K41 lists audio transcripts as one of the five sources
 * both search modes cover; this is what makes smart search's screen stage
 * actually read them, not just the corpus that carries them. `base` is the
 * summary, or (K46) the page-text fallback; `note.audioText` (the note's
 * owned, done-transcribed recordings' text - see corpus.ts) is appended
 * regardless of which base applies, since a lecture can be thoroughly
 * spoken and barely written down either way.
 */
function screenTextFor(note: SearchNote): string {
  const summary = note.note.summary;
  const base =
    summary !== null
      ? cap(summary, SCREEN_TEXT_MAX)
      : cap(joinedPageText(note), SCREEN_FALLBACK_TEXT_MAX);
  const audio = cap(note.audioText, SCREEN_AUDIO_TEXT_MAX);
  return [base, audio].filter((t) => t.length > 0).join('\n\n');
}

/** Fix round 3, C1: stage 2 reads a candidate's full page text *and* its recording transcript, not page text alone. */
function detailTextFor(note: SearchNote): string {
  const combined = [joinedPageText(note), note.audioText].filter((t) => t.length > 0).join('\n\n');
  return cap(combined, DETAIL_TEXT_MAX_CHARS);
}

/** One candidate per note: its summary (or K46's fallback) plus its recording text, if any (C1). */
function buildCandidates(notes: SearchNote[]): ScreenCandidate[] {
  return notes.map((n, i) => ({ index: i + 1, title: n.note.title, text: screenTextFor(n) }));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error('Smart search aborted');
  error.name = 'AbortError';
  throw error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * K42: two-stage, summary-first smart search. See docs/features/s6-spec.md
 * "Design" for the full reasoning behind the steps below.
 */
export async function runSmartSearch(
  query: string,
  corpus: SearchCorpus,
  deps: SmartSearchDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<SmartSearchResult> {
  const trimmedQuery = query.trim();
  // K44's reporting, extended by K46 to cover the fallback path too - this
  // is computed from the whole corpus, not narrowed by what follows.
  const unsummarizedCount = corpus.notes.filter((n) => n.note.summary === null).length;
  // Fix round 3, I1: the honest subset of the above that has nothing at
  // all besides a title - no page text, no recording text either.
  const titleOnlyCount = corpus.notes.filter(
    (n) => n.note.summary === null && joinedPageText(n) === '' && n.audioText.trim() === '',
  ).length;
  const empty: SmartSearchResult = {
    strong: [],
    moderate: [],
    weak: [],
    unsummarizedCount,
    titleOnlyCount,
    uncheckedCount: 0,
  };

  // No Ollama call at all for an empty corpus or a blank query (S6-A5): the
  // view renders the plain "nothing to search yet" message itself.
  if (corpus.notes.length === 0 || trimmedQuery === '') return empty;

  throwIfAborted(opts.signal);

  const candidates = buildCandidates(corpus.notes);
  const screenSpec = getScreenPrompt();
  const result: SmartSearchResult = { ...empty, strong: [], moderate: [], weak: [] };

  // Fix round 3, I2: batched against the project's own un-chunked-prompt
  // ceiling (see screenBatch.ts) rather than one call over the whole
  // library - past that ceiling Ollama truncates the *front* of the
  // prompt, silently losing whichever notes were screened off the front.
  // Chosen indices are unioned across batches; a failed batch's own
  // candidates count toward uncheckedCount rather than aborting the run -
  // the same per-unit resilience the band stage below already has.
  const chosenSet = new Set<number>();
  for (const batch of batchScreenCandidates(candidates)) {
    throwIfAborted(opts.signal);
    const validIndices = new Set(batch.map((c) => c.index));
    try {
      const indices = await deps.generator.generateJson(
        screenSpec.build({ query: trimmedQuery, candidates: batch }),
        {
          model: deps.model,
          system: screenSpec.system,
          signal: opts.signal,
          validate: (value) => validateScreenIndices(value, validIndices),
        },
      );
      for (const index of indices) chosenSet.add(index);
    } catch (error) {
      if (isAbort(error)) throw error;
      result.uncheckedCount += batch.length;
      console.error('[search] a screen batch failed', errorMessage(error));
    }
  }

  const chosen = candidates.filter((c) => chosenSet.has(c.index));
  const bandSpec = getBandPrompt();

  // Serially, not in parallel: Ollama serves one model at a time (the same
  // reasoning gaps/analyzer.ts's summarizeChunks already states).
  for (const candidate of chosen) {
    throwIfAborted(opts.signal);
    const note = corpus.notes[candidate.index - 1];
    const text = detailTextFor(note);
    try {
      const banded = await deps.generator.generateJson(
        bandSpec.build({ query: trimmedQuery, noteTitle: candidate.title, text }),
        {
          model: deps.model,
          system: bandSpec.system,
          signal: opts.signal,
          validate: validateBandResult,
        },
      );
      if (banded.band === 'none') continue;
      // Fix round 3, C1: a hit for a note with no page text to point at
      // offers its recording instead - the honest target, since the
      // recording's transcript is the only record this hit could have
      // come from. A note with any page text keeps pointing at the note.
      const hasPageText = joinedPageText(note).length > 0;
      const recordingId =
        !hasPageText && note.primaryRecordingId !== null ? note.primaryRecordingId : undefined;
      result[banded.band].push({
        noteId: note.note.id,
        noteTitle: candidate.title,
        band: banded.band,
        reason: banded.reason,
        recordingId,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      // S6-A4: one candidate's bad answer must not cost the rest of an
      // already-screened run. Fix round 1, Finding 2: it must also not be
      // reported as though it were checked and found irrelevant - counted
      // here, surfaced by the view distinctly from "no matches".
      result.uncheckedCount += 1;
      console.error('[search] band scoring failed for a candidate', note.note.id, errorMessage(error));
    }
  }

  return result;
}
