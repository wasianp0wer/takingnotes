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
    expect(getSyllabusPromptFor('mystery-model').promptVersion).toBe('syllabus-generic-v1');
  });

  it('asks for the JSON array the extractor validates, and nothing else', () => {
    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain('title');
    expect(prompt).toContain('dueDate');
    expect(prompt).toContain('estimatedMinutes');
    // J7: deadlines only, no class meetings; and never invent a date.
    expect(prompt.toLowerCase()).toContain('do not invent');
    expect(prompt.toLowerCase()).toMatch(/class meeting|lecture/);
  });

  it('versions the vision prompt separately and asks for text, not JSON', () => {
    const vision = getSyllabusVisionPromptFor('gemma4:12b');
    expect(vision.promptVersion).toBe('syllabus-vision-gemma-v1');
    expect(vision.prompt.toLowerCase()).toContain('text');
    expect(vision.prompt).not.toContain('JSON array');
  });
});
