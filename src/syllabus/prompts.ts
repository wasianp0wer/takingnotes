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

const TEXT_RULES = `You are reading a course syllabus. List every assignment the student must hand in, submit, or take (including exams and quizzes).

Return a JSON array. Each element is an object:
- "title": the assignment as the syllabus names it, e.g. "Essay 1", "Midterm exam", "Response paper 3".
- "dueDate": the date text the syllabus gives for that item, copied verbatim - "Oct 15", "10/15", "Week 5" and "TBD" are all copied exactly as written. Do not reformat it and do not work out a year. Use "" only when the syllabus gives no date text at all for that item.
- "kind": always the string "deadline".
- "estimatedMinutes": a whole number of minutes of work, only if the syllabus states one. Omit it, or use null, otherwise.
- "notes": a short detail the syllabus gives (length, weighting, format). Omit it, or use null, if there is none.

Rules:
- Assignments and exams only. Skip class meetings, lectures, readings with no submission, office hours and policies.
- Do not invent anything. Never guess a date, a year, an estimate or an assignment the text does not state.
- List each dated occurrence of a recurring item as its own element: twelve weekly response papers with twelve dates are twelve elements, not one. If the syllabus gives no dates for a recurring item, list it once with "" for "dueDate". Never work out a recurrence's dates yourself.
- Do not list the same assignment twice from the same passage.
- If there are no assignments, return [].
- Return the array itself, not an object containing it. The first character of your reply must be [ and the last must be ]. Never wrap it as {"assignments": [...]}.
- Output JSON only: no commentary, no explanation, no code fences.

The shape, for one assignment:
[{"title": "Essay 1", "dueDate": "Oct 15", "kind": "deadline", "estimatedMinutes": 180, "notes": "5 pages"}]`;

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
