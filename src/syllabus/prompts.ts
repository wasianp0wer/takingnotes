/**
 * Syllabus prompt registry, keyed by model family - the Phase 1 pattern (D8a).
 * Pure, and versioned, because the version is recorded with what an import
 * produced: the same model must always yield the same version.
 */

export interface SyllabusPromptSpec {
  family: string;
  promptVersion: string;
  prompt: string;
}

const TEXT_RULES = `You are reading a course syllabus. List every assignment the student must hand in or sit.

Return a JSON array. Each element is an object:
- "title": the assignment as the syllabus names it, e.g. "Essay 1", "Midterm exam", "Response paper 3".
- "dueDate": the due date exactly as the syllabus writes it ("Oct 15", "10/15", "Week 5", "TBD"). Copy it verbatim; do not reformat it and do not work out a year.
- "kind": always the string "deadline".
- "estimatedMinutes": a whole number of minutes of work, only if the syllabus states one. Omit it otherwise.
- "notes": a short detail the syllabus gives (length, weighting, format). Omit it if there is none.

Rules:
- Assignments and exams only. Skip class meetings, lectures, readings with no submission, office hours and policies.
- Do not invent anything. If an item has no date in the text, use an empty string for "dueDate". Never guess a date, a year or an estimate.
- One element per assignment. If the same assignment appears twice, list it once.
- If there are no assignments, return [].
- Output JSON only: no commentary, no explanation, no code fences.`;

const GEMMA_TEXT = `${TEXT_RULES}

Syllabus text follows.`;

const GENERIC_TEXT = GEMMA_TEXT;

const VISION_RULES = `Read this image of a page from a course syllabus and write out its text exactly as it appears.

Rules:
- Plain text only, preserving line breaks, so a schedule table stays one item per line.
- Keep dates and assignment names exactly as printed.
- Write [illegible] for anything you cannot read. Never guess at a word.
- Do not summarise, translate, reorder or explain. No commentary, no code fences.

Return the page's text and nothing else.`;

const TEXT_PROMPTS: Record<string, string> = { gemma: GEMMA_TEXT, generic: GENERIC_TEXT };
const VISION_PROMPTS: Record<string, string> = { gemma: VISION_RULES, generic: VISION_RULES };

const FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/^gemma/, 'gemma'],
  [/^qwen/, 'qwen'],
  [/^(llava|bakllava)/, 'llava'],
  [/^llama/, 'llama'],
];

/** The model family, namespace and tag stripped: `library/gemma4:12b` → `gemma`. */
export function syllabusModelFamily(model: string): string {
  const name = model.toLowerCase().trim().split('/').pop() ?? '';
  const base = name.split(':')[0];
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(base)) return family;
  }
  return 'generic';
}

export function getSyllabusPromptFor(model: string): SyllabusPromptSpec {
  const family = syllabusModelFamily(model);
  return {
    family,
    promptVersion: `syllabus-${family}-v1`,
    prompt: TEXT_PROMPTS[family] ?? GENERIC_TEXT,
  };
}

export function getSyllabusVisionPromptFor(model: string): SyllabusPromptSpec {
  const family = syllabusModelFamily(model);
  return {
    family,
    promptVersion: `syllabus-vision-${family}-v1`,
    prompt: VISION_PROMPTS[family] ?? VISION_RULES,
  };
}
