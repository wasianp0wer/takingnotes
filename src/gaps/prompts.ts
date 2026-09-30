/**
 * P1 prompt registry, keyed by model family and versioned (spec §"prompts.ts",
 * decision D8a). Two prompts: `summarize` reduces one chunk of lecture speech to
 * bullet points, `compare` reports the substantive points the speech made and a
 * page's handwriting missed.
 *
 * Prompts are string constants and `getGapPrompt` is pure: every stored
 * suggestion carries the `promptVersion` it came from, so the same model and the
 * same kind must always yield the same version and the same text. Tuning a
 * prompt - including adding a gap kind - is a new version, never an edit in
 * place.
 *
 * Deliberately separate from `src/transcription/prompts.ts`: that registry maps
 * *vision* families, which say nothing about how a text model should be asked.
 */

import type { GapKind } from '@/storage/types';

export type GapPromptKind = 'summarize' | 'compare';

export interface GapPromptSpec {
  kind: GapPromptKind;
  family: string;
  promptVersion: string;
  system: string;
}

/** One chunk of lecture speech, and where it sits in the run of chunks. */
export interface SummarizeInput {
  chunk: string;
  index: number;
  total: number;
}

/** A page's handwriting transcript against the speech it should have captured. */
export interface CompareInput {
  notes: string;
  speech: string;
  /** True when `speech` is bullet summaries rather than a verbatim transcript (J5). */
  summarized: boolean;
}

export interface GapSummarizePrompt extends GapPromptSpec {
  kind: 'summarize';
  build(input: SummarizeInput): string;
}

export interface GapComparePrompt extends GapPromptSpec {
  kind: 'compare';
  build(input: CompareInput): string;
}

/**
 * The kinds a suggestion may carry, in spec order (J6). Exported here because
 * the prompts below name them to the model and `validate.ts` accepts exactly
 * this list: one source, so the prompt and the validator cannot drift apart.
 */
export const GAP_KINDS: readonly GapKind[] = [
  'claim',
  'definition',
  'name-or-date',
  'example',
  'argument-step',
  'other',
];

/** The kinds as the prompts quote them, so a new kind cannot be forgotten in one place. */
const KIND_LIST = GAP_KINDS.map((kind) => `"${kind}"`).join(', ');

/** The substantive-only rule (J6), worded identically in both prompts. */
const SUBSTANTIVE = `claims, definitions, names and dates, argument steps, worked examples, and anything the lecturer flagged as important or examinable`;

const GENERIC_COMPARE = `You compare a student's handwritten lecture notes against what the lecturer actually said, and report only the substantive points the notes missed.

Rules:
- Report a point only when it was stated in the lecture and is absent from the notes.
- Judge on substance, not wording. A point the student wrote in different words, in shorthand, or as an abbreviation is present - leave it out.
- Report substantive content only: ${SUBSTANTIVE}.
- Never report an aside, a greeting, small talk, repetition, or a restatement of something the notes already say.
- Answer with a JSON array of objects, each exactly { "text": string, "kind": string, "sourceQuote": string }.
- "text" states the missing point in one sentence, "kind" is one of ${KIND_LIST}, and "sourceQuote" is a short span copied verbatim from the lecture text that supports the point.
- Never invent a quote. If you cannot copy a supporting span out of the lecture text, leave the point out.
- When nothing substantive is missing, answer with the empty array [].
- No commentary, no preamble, no explanation, no code fences.

Return the JSON array and nothing else.`;

const GEMMA_COMPARE = `You compare a student's handwritten lecture notes against what the lecturer actually said, and report only the substantive points the notes missed.

Rules:
- Report a point only when it was stated in the lecture and is absent from the notes.
- Judge on substance, not wording. A point the student wrote in different words, in shorthand, or as an abbreviation is present - leave it out.
- Report substantive content only: ${SUBSTANTIVE}.
- Never report an aside, a greeting, small talk, repetition, or a restatement of something the notes already say.
- Answer with a JSON array of objects, each exactly { "text": string, "kind": string, "sourceQuote": string }.
- "text" states the missing point in one sentence, "kind" is one of ${KIND_LIST}, and "sourceQuote" is a short span copied verbatim from the lecture text that supports the point.
- Never invent a quote. If you cannot copy a supporting span out of the lecture text, leave the point out.
- Do not pad the output with repeated lines: each object must state a point the others do not.
- When nothing substantive is missing, answer with the empty array [].
- Output JSON only - do not restate the instructions. No commentary, no preamble, no explanation, no code fences.

Return the JSON array and nothing else.`;

const GENERIC_SUMMARIZE = `You reduce one passage of lecture speech to its key points, as bullet points.

Rules:
- Write one point per line, each line starting with "- ".
- Keep substantive content only: ${SUBSTANTIVE}.
- Drop asides, greetings, small talk, repetition and restatements.
- Copy names, dates and numbers verbatim; never round a number or paraphrase a name.
- No preamble, no heading, no closing summary, no commentary.
- Return nothing at all if the passage contains no substantive content.

Return the bullet points and nothing else.`;

const GEMMA_SUMMARIZE = `You reduce one passage of lecture speech to its key points, as bullet points.

Rules:
- Write one point per line, each line starting with "- ".
- Keep substantive content only: ${SUBSTANTIVE}.
- Drop asides, greetings, small talk, repetition and restatements.
- Copy names, dates and numbers verbatim; never round a number or paraphrase a name.
- Do not pad the output with repeated lines: each point must state something the others do not.
- Output the bullet points only - do not restate the instructions. No preamble, no heading, no closing summary, no commentary.
- Return nothing at all if the passage contains no substantive content.

Return the bullet points and nothing else.`;

const COMPARE_SYSTEM: Record<string, string> = {
  gemma: GEMMA_COMPARE,
  generic: GENERIC_COMPARE,
};

const SUMMARIZE_SYSTEM: Record<string, string> = {
  gemma: GEMMA_SUMMARIZE,
  generic: GENERIC_SUMMARIZE,
};

const FAMILY_PATTERNS: Array<[RegExp, string]> = [[/^gemma/, 'gemma']];

/**
 * The text-prompt family of an Ollama model name, with namespace and tag
 * stripped: `library/gemma4:12b` → `gemma`, anything else → `generic`.
 */
export function gapModelFamily(model: string): string {
  const name = model.toLowerCase().trim().split('/').pop() ?? '';
  const base = name.split(':')[0];
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(base)) return family;
  }
  return 'generic';
}

function versionFor(kind: GapPromptKind, family: string): string {
  return `gap-${kind}-${family}-v1`;
}

function buildSummarize(input: SummarizeInput): string {
  return [
    `Passage ${input.index + 1} of ${input.total} of one lecture recording. It may start or end mid-sentence, so summarize only what is here and do not treat it as a whole lecture.`,
    '',
    'PASSAGE:',
    input.chunk.trim(),
  ].join('\n');
}

function buildCompare(input: CompareInput): string {
  const notes = input.notes.trim();
  const parts: string[] = [];
  if (input.summarized) {
    parts.push(
      'The lecture text below is a summary of the speech in bullet points, not a verbatim transcript, so a supporting quote may be one of those bullets.',
      '',
    );
  }
  parts.push(
    'NOTES (what the student wrote):',
    notes.length > 0 ? notes : '(the student wrote nothing on this page)',
    '',
    'LECTURE (what was said):',
    input.speech.trim(),
  );
  return parts.join('\n');
}

/**
 * The prompt for a kind and a model, plus the version stamped on whatever it
 * produces. Two overloads over one implementation so a caller's `build` is typed
 * to the kind it asked for rather than a union of both inputs.
 */
export function getGapPrompt(kind: 'summarize', model: string): GapSummarizePrompt;
export function getGapPrompt(kind: 'compare', model: string): GapComparePrompt;
export function getGapPrompt(
  kind: GapPromptKind,
  model: string,
): GapSummarizePrompt | GapComparePrompt {
  const family = gapModelFamily(model);
  if (kind === 'summarize') {
    return {
      kind,
      family,
      promptVersion: versionFor(kind, family),
      system: SUMMARIZE_SYSTEM[family] ?? GENERIC_SUMMARIZE,
      build: buildSummarize,
    };
  }
  return {
    kind,
    family,
    promptVersion: versionFor(kind, family),
    system: COMPARE_SYSTEM[family] ?? GENERIC_COMPARE,
    build: buildCompare,
  };
}

/**
 * The version recorded on a suggestion: the compare prompt alone for a direct
 * comparison, or both prompts for a summarized one. Summarizing changes what the
 * comparison ever sees, so the two runs are different prompt lineages and one
 * must not claim to be the other.
 */
export function gapPromptVersion(model: string, summarized: boolean): string {
  const family = gapModelFamily(model);
  const compare = versionFor('compare', family);
  return summarized ? `${versionFor('summarize', family)}+${compare}` : compare;
}
