/**
 * Prompt registry keyed by model family (spec §3, decision D8).
 *
 * Every family gets the same rules (v2, owner 2026-10-20: underlined text is
 * the heading cue, a handwritten line break is not an output line break, and
 * freestanding diagrams are described rather than drawn), followed by one
 * guard that family in particular needs. The prompt also carries one fact
 * about the page - whether it is the first page of the session - because the
 * model sees a single image and cannot otherwise tell a session title from a
 * section heading.
 *
 * Prompts are plain string constants and `getPromptFor` is pure: the queue
 * stores `promptVersion` alongside every transcript, so the same model must
 * always yield the same version. The page position is not part of the version:
 * it is a fact about the page, not a tuning of the prompt.
 */

export interface PromptSpec {
  family: string;
  promptVersion: string;
  prompt: string;
}

/** What the prompt needs to know about the page's place in its note. */
export interface PagePosition {
  /** True for the first page of the note; its first underlined line is the session title. */
  firstPage: boolean;
}

const PROMPT_VERSION = 'v2';

const FIRST_PAGE_HEADING_RULE =
  '- This is the first page of the session. The first underlined line is the session title: write it as "# ". Every other underlined line is "## ".';

const LATER_PAGE_HEADING_RULE =
  '- This is not the first page of the session, so every underlined line is "## ".';

function sharedRules(position: PagePosition): string {
  const headingRule = position.firstPage ? FIRST_PAGE_HEADING_RULE : LATER_PAGE_HEADING_RULE;
  return `Transcribe the handwritten page in this image into Markdown.

The words must be exact: never translate, summarise, correct, reorder or guess. Write [illegible] in place of any word you cannot read. The layout is clean Markdown, not a copy of where lines fall on the page.

Headings
- Underlined text is a heading. Text that is not underlined is never a heading, however large it is written.
${headingRule}

Paragraphs
- A new handwritten line is not a new line in the output. When a line continues the sentence or thought above it, join them into one paragraph.
- Start a new paragraph, with a blank line, only where the writer clearly began a new point: after a heading, between separate notes, or where the sense changes.

Lists
- A dash, dot, arrow or number at the start of a line marks a list item. Write it as "- " or "1. " and keep the indentation of nested items.

Notation and diagrams
- Notation inside the flow of the text stays as text: arrows between words (a <- b, x -> y -> z, p <-> q), equals and inequality signs, implications, simple relations. Write these with LaTeX ($\\leftarrow$, $\\rightarrow$, $\\leftrightarrow$, $\\Rightarrow$) or the plain symbol, in the place they appear.
- A hand-drawn table with rows and columns becomes a Markdown table.
- A freestanding drawing is different: a tree, flowchart, box-and-arrow picture, graph, timeline, sketch, or anything whose meaning depends on where things sit on the page. Never recreate one of these with characters or ASCII art. In its place write one italic bracketed note that says what it shows and includes its labels, for example: *[Diagram: a tree with "Executive" at the root branching to "President" and "Cabinet".]*
- The test: if it can be written as one line of text or maths without losing meaning, write it. If it needs a two-dimensional layout, describe it.

Maths
- Write mathematical notation as LaTeX between $...$, or $$...$$ on a line of its own.

Corrections
- Leave out words that are struck through. Put inserted words where the caret points.

Output
- Markdown only. No commentary, no preamble, no code fences, and nothing about the paper, ink or handwriting.`;
}

/** The one guard each family has needed in practice, appended after the shared rules. */
const FAMILY_GUARDS: Record<string, string> = {
  gemma: '- Do not pad the output with repeated lines.',
  'qwen-vl': '- Do not output bounding boxes, coordinates, JSON or HTML.',
  llava:
    '- This is a transcription task, not a description task. Do not say what the image shows; write out the words themselves.',
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

/**
 * The version a transcript of `model` will record, for a caller that has not
 * loaded the page yet (the queue's `pending` mark). Equal to the `promptVersion`
 * of `getPromptFor` for either page position.
 */
export function promptVersionFor(model: string): string {
  return `${modelFamily(model)}-${PROMPT_VERSION}`;
}

/** The prompt to send for a model and page, plus the version recorded with the transcript. */
export function getPromptFor(model: string, position: PagePosition): PromptSpec {
  const family = modelFamily(model);
  const guard = FAMILY_GUARDS[family];
  const prompt = guard ? `${sharedRules(position)}\n${guard}` : sharedRules(position);
  return {
    family,
    promptVersion: promptVersionFor(model),
    prompt,
  };
}
