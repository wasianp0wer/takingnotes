/**
 * Prompt registry keyed by model family (spec §3, decision D8).
 *
 * Prompts are plain string constants and `getPromptFor` is pure: the queue
 * stores `promptVersion` alongside every transcript, so the same model must
 * always yield the same version.
 */

export interface PromptSpec {
  family: string;
  promptVersion: string;
  prompt: string;
}

const GENERIC_PROMPT = `Transcribe this image of a handwritten page exactly as it is written.

Rules:
- Output Markdown only. Use Markdown headings for headings, Markdown lists for bulleted or numbered lists, and keep the indentation of nested items.
- Preserve the structure of the page. Reproduce hand-drawn diagrams, arrows and tables as simple ASCII art or indented text in the position where they appear.
- Write [illegible] in place of any word you cannot read. Never guess at a word.
- Do not translate, summarise, correct or reorder anything.
- No commentary, no preamble, no explanation, no code fences.

Return the page's Markdown and nothing else.`;

const GEMMA_PROMPT = `Transcribe this image of a handwritten page exactly as it is written.

Rules:
- Output Markdown only. Use Markdown headings for headings, Markdown lists for bulleted or numbered lists, and keep the indentation of nested items.
- Keep hand-drawn structure: reproduce diagrams, branching trees and arrows as simple ASCII art (for example \`->\`, \`|\`, indentation) in the position where they appear. A flattened diagram loses the idea.
- Write [illegible] in place of any word you cannot read. Never guess at a word, and do not pad the output with repeated lines.
- Do not translate, summarise, correct or reorder anything.
- No commentary, no preamble, no explanation, no code fences.

Return the page's Markdown and nothing else.`;

const QWEN_VL_PROMPT = `Transcribe this image of a handwritten page exactly as it is written.

Rules:
- Output Markdown only. Use Markdown headings for headings, Markdown lists for bulleted or numbered lists, and keep the indentation of nested items.
- Preserve the structure of the page. Reproduce hand-drawn diagrams, arrows and tables as simple ASCII art or indented text in the position where they appear.
- Write [illegible] in place of any word you cannot read. Never guess at a word.
- Do not describe the image, do not output bounding boxes, coordinates or JSON, and do not add HTML.
- No commentary, no preamble, no explanation, no code fences.

Return the page's Markdown and nothing else.`;

const LLAVA_PROMPT = `Transcribe this image of a handwritten page exactly as it is written.

Rules:
- Output Markdown only. Use Markdown headings for headings, Markdown lists for bulleted or numbered lists, and keep the indentation of nested items.
- This is a transcription task, not a description task. Do not say what the image shows, do not mention handwriting, paper or ink — write out the words themselves.
- Reproduce hand-drawn diagrams, arrows and tables as simple ASCII art or indented text in the position where they appear.
- Write [illegible] in place of any word you cannot read. Never guess at a word.
- No commentary, no preamble, no explanation, no code fences.

Return the page's Markdown and nothing else.`;

const PROMPTS: Record<string, string> = {
  gemma: GEMMA_PROMPT,
  'qwen-vl': QWEN_VL_PROMPT,
  llava: LLAVA_PROMPT,
  generic: GENERIC_PROMPT,
};

const FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/^gemma/, 'gemma'],
  [/^qwen.*vl/, 'qwen-vl'],
  [/^(llava|bakllava)/, 'llava'],
  [/^(llama3\.2-vision|llama.*vision)/, 'llama-vision'],
  [/^minicpm-v/, 'minicpm-v'],
];

/**
 * The model family of an Ollama model name, with namespace and tag stripped:
 * `library/gemma4:12b` → `gemma`, `qwen2.5vl:7b` → `qwen-vl`.
 */
export function modelFamily(model: string): string {
  const name = model.toLowerCase().trim().split('/').pop() ?? '';
  const base = name.split(':')[0];
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(base)) return family;
  }
  return 'generic';
}

/** The prompt to send for a model, plus the version recorded with the transcript. */
export function getPromptFor(model: string): PromptSpec {
  const family = modelFamily(model);
  return {
    family,
    promptVersion: `${family}-v1`,
    prompt: PROMPTS[family] ?? GENERIC_PROMPT,
  };
}
