import type { SearchCorpus, SearchNote } from '@/search/corpus';
import { getBandPrompt, getScreenPrompt, type ScreenCandidate } from '@/search/prompts';
import { validateBandResult, validateScreenIndices, type SmartSearchBand } from '@/search/validate';
import type { TextGenerator } from '@/llm/ollamaText';

/** Stage 1 only needs enough text to judge topic, not the whole lecture. */
export const SCREEN_TEXT_MAX = 1000;
/** K46's fallback is tighter still - a gist, not the detail stage 2 reads in full. */
export const SCREEN_FALLBACK_TEXT_MAX = 800;
/** Stage 2 reads a candidate's full page text, capped against an unusually long note. */
export const DETAIL_TEXT_MAX_CHARS = 12_000;

export interface SmartSearchHit {
  noteId: string;
  noteTitle: string;
  band: SmartSearchBand;
  reason: string;
}

export interface SmartSearchResult {
  strong: SmartSearchHit[];
  moderate: SmartSearchHit[];
  weak: SmartSearchHit[];
  /** Notes with `summary === null`, screened by title + page text instead (K44/K46). */
  unsummarizedCount: number;
  /**
   * Candidates the screen stage chose whose band call then failed (S6-A4)
   * - a note smart search could not check, not one it checked and found no
   * match in. Fix round 1, Finding 2: dropping a failed candidate so it
   * cannot cost the rest of an already-screened run was the right call;
   * reporting it as indistinguishable from "no match" was not - "no
   * matches" and "I could not check nine of your notes" are different
   * answers, and a confidently empty result would send the owner away
   * believing the lecture does not exist.
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

/** One candidate per note: its summary, or (K46) its title + page text when it has none. */
function buildCandidates(notes: SearchNote[]): ScreenCandidate[] {
  return notes.map((n, i) => {
    const summary = n.note.summary;
    const text =
      summary !== null
        ? cap(summary, SCREEN_TEXT_MAX)
        : cap(joinedPageText(n), SCREEN_FALLBACK_TEXT_MAX);
    return { index: i + 1, title: n.note.title, text };
  });
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
  const empty: SmartSearchResult = { strong: [], moderate: [], weak: [], unsummarizedCount, uncheckedCount: 0 };

  // No Ollama call at all for an empty corpus or a blank query (S6-A5): the
  // view renders the plain "nothing to search yet" message itself.
  if (corpus.notes.length === 0 || trimmedQuery === '') return empty;

  throwIfAborted(opts.signal);

  const candidates = buildCandidates(corpus.notes);
  const screenSpec = getScreenPrompt();
  // Not caught here: an unreachable host must surface through this
  // rejection (K44) - the first Ollama call this function makes.
  const chosenIndices = await deps.generator.generateJson(
    screenSpec.build({ query: trimmedQuery, candidates }),
    {
      model: deps.model,
      system: screenSpec.system,
      signal: opts.signal,
      validate: (value) => validateScreenIndices(value, candidates.length),
    },
  );

  const chosenSet = new Set(chosenIndices);
  const chosen = candidates.filter((c) => chosenSet.has(c.index));
  const bandSpec = getBandPrompt();
  const result: SmartSearchResult = { ...empty, strong: [], moderate: [], weak: [] };

  // Serially, not in parallel: Ollama serves one model at a time (the same
  // reasoning gaps/analyzer.ts's summarizeChunks already states).
  for (const candidate of chosen) {
    throwIfAborted(opts.signal);
    const note = corpus.notes[candidate.index - 1];
    const text = cap(joinedPageText(note), DETAIL_TEXT_MAX_CHARS);
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
      result[banded.band].push({
        noteId: note.note.id,
        noteTitle: candidate.title,
        band: banded.band,
        reason: banded.reason,
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
