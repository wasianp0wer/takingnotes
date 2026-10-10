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

/**
 * Fix round 3, I3: the bands the model may assign, including the "not
 * relevant" sentinel - the one list both the prompt's wording and
 * `validate.ts`'s accepted values are built from, mirroring
 * `gaps/prompts.ts`'s `GAP_KINDS`/`KIND_LIST` pattern. A pass that renames
 * or adds a band changes this array once; the prompt text and the
 * validator pick it up automatically, so they cannot drift the way a
 * hand-copied list in each place could.
 */
export const SMART_SEARCH_BANDS = ['strong', 'moderate', 'weak'] as const;
export type SmartSearchBand = (typeof SMART_SEARCH_BANDS)[number];
export const BAND_LABELS = [...SMART_SEARCH_BANDS, 'none'] as const;
export type BandLabel = (typeof BAND_LABELS)[number];

const BAND_DESCRIPTION: Record<BandLabel, string> = {
  strong: 'the notes substantially cover what the query asks about',
  moderate: 'the notes mention it but only partly',
  weak: 'there is only a tangential or passing connection',
  none: 'the notes are not actually about this',
};

const BAND_RULE_LIST = BAND_LABELS.map(
  (label) => `"${label}" (${BAND_DESCRIPTION[label]})`,
).join(', ');

/**
 * Fix round 3, I3: the worked example the screen prompt shows the model -
 * also imported verbatim by the round-trip test, so the test exercises the
 * literal example the prompt gives rather than a hand-typed stand-in that
 * could silently diverge from it.
 */
export const SCREEN_EXAMPLE_INDICES = [1, 4, 7] as const;

const SCREEN_SYSTEM = `You screen a student's lecture notes to find which ones might answer a search query, before a closer check reads them in full.

Rules:
- You are given a search query and a numbered list of notes, each with a title and either a short summary or, when no summary exists, its page text, its recording's transcript, or both.
- Return the numbers of every note that might plausibly be relevant to the query, even loosely. A closer check will narrow this down afterward, so err on the side of including a note you are unsure about rather than leaving it out.
- Do not include a note that is clearly about something else entirely.
- Answer with a JSON array of integers only, for example [${SCREEN_EXAMPLE_INDICES.join(', ')}]. Return [] if none might be relevant.
- No commentary, no preamble, no explanation, no code fences.

Return the JSON array and nothing else.`;

const BAND_SYSTEM = `You judge how well one set of lecture notes answers a search query.

Rules:
- Read the notes given and decide how strongly they relate to the query.
- Answer with a JSON object of exactly { "band": string, "reason": string }.
- "band" is one of ${BAND_RULE_LIST}.
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

/** Stage 1 (K42): screens every note's summary, or K46's title+page-text/recording fallback. */
export function getScreenPrompt(): SearchPromptSpec<ScreenPromptInput> {
  return { promptVersion: SCREEN_PROMPT_VERSION, system: SCREEN_SYSTEM, build: buildScreen };
}

/** Stage 2 (K42): bands one candidate note's full page text and recording transcript strong/moderate/weak/none. */
export function getBandPrompt(): SearchPromptSpec<BandPromptInput> {
  return { promptVersion: BAND_PROMPT_VERSION, system: BAND_SYSTEM, build: buildBand };
}
