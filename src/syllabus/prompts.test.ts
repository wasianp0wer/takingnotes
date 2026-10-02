import { describe, expect, it } from 'vitest';

import { getSyllabusPromptFor, getSyllabusVisionPromptFor } from '@/syllabus/prompts';

describe('syllabus prompt registry', () => {
  it('versions a prompt per model family, stably', () => {
    const a = getSyllabusPromptFor('gemma4:12b');
    const b = getSyllabusPromptFor('library/gemma4:27b');
    expect(a.family).toBe('gemma');
    expect(a.promptVersion).toBe('syllabus-gemma-v1');
    // The same family always yields the same version: it is recorded per import.
    expect(b.promptVersion).toBe(a.promptVersion);
    expect(b.prompt).toBe(a.prompt);
    expect(getSyllabusPromptFor('mystery-model').promptVersion).toBe('syllabus-generic-v1');
    expect(getSyllabusPromptFor('mystery-model').family).toBe('generic');
  });

  it('gives an unmapped family its own version while sharing the generic prompt', () => {
    // Documented fall-through: qwen/llava/llama have no prompt of their own yet,
    // so they use the generic text - but `promptVersion` is persisted with every
    // import, so each family must still record a version of its own.
    const generic = getSyllabusPromptFor('mystery-model');
    const cases: Array<[string, string]> = [
      ['qwen3:8b', 'qwen'],
      ['llava:13b', 'llava'],
      ['bakllava:latest', 'llava'],
      ['llama4:8b', 'llama'],
    ];
    for (const [model, family] of cases) {
      const spec = getSyllabusPromptFor(model);
      expect(spec.family).toBe(family);
      expect(spec.promptVersion).toBe(`syllabus-${family}-v1`);
      expect(spec.prompt).toBe(generic.prompt);
      expect(spec.promptVersion).not.toBe(generic.promptVersion);
      expect(getSyllabusVisionPromptFor(model).promptVersion).toBe(`syllabus-vision-${family}-v1`);
    }
  });

  it('asks for the JSON array the extractor validates, and nothing else', () => {
    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"dueDate"');
    expect(prompt).toContain('"estimatedMinutes"');
    expect(prompt).toContain('"kind": always the string "deadline"');
    expect(prompt).toContain('no code fences');
  });

  it('forbids the object wrapper, which would throw the whole import away', () => {
    // A non-array is the one reply `parseAssignments` cannot salvage: it throws.
    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt).toContain('not an object containing it');
    expect(prompt).toContain('must be [');
    expect(prompt).toContain('{"assignments": [...]}');
    // A worked example of a single element, so the shape is shown and not only said.
    expect(prompt).toContain('[{"title": "Essay 1", "dueDate": "Oct 15", "kind": "deadline"');
  });

  it('never invents a date, and asks for the date text verbatim', () => {
    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt.toLowerCase()).toContain('do not invent');
    expect(prompt).toContain('Never guess a date, a year, an estimate');
    expect(prompt).toContain('copied verbatim');
    expect(prompt).toContain('do not work out a year');
    // Unambiguous: "TBD" is date text to copy, "" is only for no date text at all.
    expect(prompt).toContain('"TBD" are all copied exactly as written');
    expect(prompt).toContain('Use "" only when the syllabus gives no date text at all');
  });

  it('excludes what is not an assignment, and covers exams in plain words (J7)', () => {
    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt.toLowerCase()).toMatch(/class meeting|lecture/);
    expect(prompt).toContain('Assignments and exams only');
    expect(prompt).toContain('office hours');
    // "sit" is British idiom a mid-sized model may not resolve.
    expect(prompt).toContain('take (including exams and quizzes)');
    expect(prompt).not.toContain('hand in or sit');
  });

  it('keeps every dated occurrence of a recurring item', () => {
    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt).toContain('each dated occurrence');
    expect(prompt).toContain("Never work out a recurrence's dates yourself");
    // The old blanket "list it once" invited collapsing twelve weekly papers into one.
    expect(prompt).not.toContain('If the same assignment appears twice, list it once');
  });

  it('accepts null for the optional fields, which models emit more often than omission', () => {
    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt).toContain('Omit it, or use null, otherwise');
    expect(prompt).toContain('Omit it, or use null, if there is none');
  });

  it('versions the vision prompt separately and asks for text, not JSON', () => {
    const vision = getSyllabusVisionPromptFor('gemma4:12b');
    expect(vision.promptVersion).toBe('syllabus-vision-gemma-v1');
    expect(vision.prompt.toLowerCase()).toContain('text');
    expect(vision.prompt).not.toContain('JSON array');
    expect(vision.prompt).toContain('[illegible]');
    expect(vision.prompt).toContain('preserving line breaks');
  });
});
