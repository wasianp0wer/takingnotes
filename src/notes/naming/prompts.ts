/**
 * K17-K18, K21: the auto-naming prompt registry, versioned (spec §"every
 * prompt lives in a versioned registry"), following
 * `src/transcription/prompts.ts` and `src/gaps/prompts.ts`. One prompt: given
 * a note's page text, return a short title and a one-to-two-sentence summary.
 *
 * Not keyed by model family (A36: this reuses `ollama.model`, same as every
 * other text generation call) - the current revision applies to whatever
 * model is configured. A future revision bumps `PROMPT_VERSION`.
 */

export interface NamingPromptInput {
  /** The note's page text, joined in `pageIndex` order. */
  text: string;
}

export interface NamingPromptSpec {
  promptVersion: string;
  system: string;
  build(input: NamingPromptInput): string;
}

const PROMPT_VERSION = 'naming-v1';

const SYSTEM = `You read a student's lecture notes and produce a short title and a brief summary.

Rules:
- Answer with a JSON object of exactly { "title": string, "summary": string }.
- "title" is a short, specific title for the lecture or topic (a few words, not a sentence) - specific enough that the student could find these notes again among many others. Do not write generic titles like "Lecture notes" or "Class notes".
- "summary" is one to two sentences describing what the notes actually cover.
- Base both only on the notes given. Never invent content that is not there.
- No commentary, no preamble, no explanation, no code fences.

Return the JSON object and nothing else.`;

function build(input: NamingPromptInput): string {
  const text = input.text.trim();
  return [
    'NOTES:',
    text.length > 0 ? text : '(the notes are empty)',
  ].join('\n');
}

/**
 * The prompt for naming a note, plus the version stamped on its summary. Not
 * parameterized by model (unlike `transcription/prompts.ts`'s family
 * branching): A36 reuses `ollama.model` as-is, with no per-family wording
 * needed yet. A future revision that does need one adds the parameter back.
 */
export function getNamingPrompt(): NamingPromptSpec {
  return { promptVersion: PROMPT_VERSION, system: SYSTEM, build };
}
