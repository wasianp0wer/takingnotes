/**
 * K42/K43: the smart-search prompt registry, versioned like
 * `src/transcription/prompts.ts` and `src/gaps/prompts.ts`. Not keyed by
 * model family - following `src/notes/naming/prompts.ts`'s reasoning (A36:
 * this reuses `ollama.model` as-is; a future revision that needs
 * per-family wording adds the parameter the way `transcription/prompts.ts`
 * does).
 */

export interface ScreenCandidate {
  index: number;
  title: string;
  text: string;
}

export interface ScreenPromptInput {
  query: string;
  candidates: ScreenCandidate[];
}

export interface BandPromptInput {
  query: string;
  noteTitle: string;
  text: string;
}

export interface SearchPromptSpec<TInput> {
  promptVersion: string;
  system: string;
  build(input: TInput): string;
}

export const SCREEN_PROMPT_VERSION = 'search-screen-v1';
export const BAND_PROMPT_VERSION = 'search-band-v1';

const SCREEN_SYSTEM = `You screen a student's lecture notes to find which ones might answer a search query, before a closer check reads them in full.

Rules:
- You are given a search query and a numbered list of notes, each with a title and either a short summary or, when no summary exists, its page text.
- Return the numbers of every note that might plausibly be relevant to the query, even loosely. A closer check will narrow this down afterward, so err on the side of including a note you are unsure about rather than leaving it out.
- Do not include a note that is clearly about something else entirely.
- Answer with a JSON array of integers only, for example [1, 4, 7]. Return [] if none might be relevant.
- No commentary, no preamble, no explanation, no code fences.

Return the JSON array and nothing else.`;

const BAND_SYSTEM = `You judge how well one set of lecture notes answers a search query.

Rules:
- Read the notes given and decide how strongly they relate to the query.
- Answer with a JSON object of exactly { "band": string, "reason": string }.
- "band" is one of "strong" (the notes substantially cover what the query asks about), "moderate" (the notes mention it but only partly), "weak" (there is only a tangential or passing connection), or "none" (the notes are not actually about this).
- "reason" is a short span copied verbatim from the notes that supports your answer, or a brief explanation when band is "none".
- Never invent a quote that is not in the notes.
- No commentary, no preamble, no explanation, no code fences.

Return the JSON object and nothing else.`;

function buildScreen(input: ScreenPromptInput): string {
  const lines = input.candidates.map(
    (c) => `${c.index}. ${c.title} — ${c.text.trim() || '(no content)'}`,
  );
  return ['QUERY:', input.query.trim(), '', 'NOTES:', ...lines].join('\n');
}

function buildBand(input: BandPromptInput): string {
  return [
    `QUERY: ${input.query.trim()}`,
    '',
    `NOTES (titled "${input.noteTitle}"):`,
    input.text.trim() || '(the note has no content)',
  ].join('\n');
}

/** Stage 1 (K42): screens every note's summary, or K46's title+page-text fallback. */
export function getScreenPrompt(): SearchPromptSpec<ScreenPromptInput> {
  return { promptVersion: SCREEN_PROMPT_VERSION, system: SCREEN_SYSTEM, build: buildScreen };
}

/** Stage 2 (K42): bands one candidate note's full page text strong/moderate/weak/none. */
export function getBandPrompt(): SearchPromptSpec<BandPromptInput> {
  return { promptVersion: BAND_PROMPT_VERSION, system: BAND_SYSTEM, build: buildBand };
}
