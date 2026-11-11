import { describe, expect, it } from 'vitest';
import { getPromptFor, modelFamily, promptVersionFor } from '@/transcription/prompts';

describe('modelFamily', () => {
  it('maps gemma model names to the gemma family', () => {
    expect(modelFamily('gemma4:12b')).toBe('gemma');
    expect(modelFamily('gemma3:4b')).toBe('gemma');
    expect(modelFamily('library/gemma4:latest')).toBe('gemma');
    expect(modelFamily('GEMMA4:12B')).toBe('gemma');
  });

  it('maps the other known vision families', () => {
    expect(modelFamily('qwen2.5vl:7b')).toBe('qwen-vl');
    expect(modelFamily('llava:13b')).toBe('llava');
    expect(modelFamily('bakllava:latest')).toBe('llava');
    expect(modelFamily('llama3.2-vision:11b')).toBe('llama-vision');
    expect(modelFamily('minicpm-v:8b')).toBe('minicpm-v');
  });

  it('falls back to generic for unknown models', () => {
    expect(modelFamily('mistral:7b')).toBe('generic');
    expect(modelFamily('')).toBe('generic');
  });
});

describe('getPromptFor', () => {
  const FIRST = { firstPage: true };
  const LATER = { firstPage: false };
  const MODELS = [
    'gemma4:12b',
    'qwen2.5vl:7b',
    'llava:13b',
    'llama3.2-vision:11b',
    'minicpm-v:8b',
    'mistral:7b',
  ];

  it('versions the prompt by family at v2', () => {
    expect(getPromptFor('gemma4:12b', FIRST).promptVersion).toBe('gemma-v2');
    expect(getPromptFor('gemma4:12b', FIRST).family).toBe('gemma');
    expect(getPromptFor('qwen2.5vl:7b', FIRST).promptVersion).toBe('qwen-vl-v2');
    expect(getPromptFor('llava:13b', FIRST).promptVersion).toBe('llava-v2');
    expect(getPromptFor('mistral:7b', FIRST).promptVersion).toBe('generic-v2');
  });

  it('keeps one version for both page positions: position is a fact, not a tuning', () => {
    expect(getPromptFor('gemma4:12b', FIRST).promptVersion).toBe(
      getPromptFor('gemma4:12b', LATER).promptVersion,
    );
  });

  it('exposes the version alone, for a caller that has not loaded the page yet', () => {
    expect(promptVersionFor('gemma4:12b')).toBe('gemma-v2');
    expect(promptVersionFor('gemma4:12b')).toBe(getPromptFor('gemma4:12b', LATER).promptVersion);
    expect(promptVersionFor('mistral:7b')).toBe('generic-v2');
  });

  it('is deterministic', () => {
    expect(getPromptFor('gemma4:12b', FIRST)).toEqual(getPromptFor('gemma4:12b', FIRST));
  });

  it("makes the first page's first underlined line an H1 and the rest H2", () => {
    const { prompt } = getPromptFor('gemma4:12b', FIRST);
    expect(prompt).toContain('This is the first page of the session');
    expect(prompt).toContain('"# "');
    expect(prompt).toContain('"## "');
    expect(prompt).not.toContain('This is not the first page');
  });

  it('makes every underlined line on a later page an H2 and never mentions H1', () => {
    const { prompt } = getPromptFor('gemma4:12b', LATER);
    expect(prompt).toContain('This is not the first page of the session');
    expect(prompt).toContain('"## "');
    expect(prompt).not.toContain('"# "');
    expect(prompt).not.toContain('This is the first page');
  });

  it('gives every family the shared rules', () => {
    for (const model of MODELS) {
      for (const position of [FIRST, LATER]) {
        const { prompt } = getPromptFor(model, position);
        expect(prompt, model).toContain('[illegible]');
        expect(prompt, model).toContain('Markdown');
        // Underlined text is the heading cue.
        expect(prompt, model).toContain('Underlined text is a heading');
        // A handwritten line break is not an output line break.
        expect(prompt, model).toContain('A new handwritten line is not a new line in the output');
        // Freestanding diagrams are described, never drawn...
        expect(prompt, model).toContain('*[Diagram:');
        expect(prompt, model).not.toContain('ASCII art in the position');
        expect(prompt, model).not.toContain('A flattened diagram loses the idea');
        // ...but inline notation stays as text.
        expect(prompt, model).toContain('$\\rightarrow$');
        expect(prompt, model).toContain('Markdown table');
        expect(prompt, model).toContain('no code fences');
      }
    }
  });

  it('keeps the family-specific guards after the shared rules', () => {
    const gemma = getPromptFor('gemma4:12b', FIRST).prompt;
    expect(gemma).toContain('repeated lines');
    expect(gemma.indexOf('repeated lines')).toBeGreaterThan(gemma.indexOf('Output'));

    expect(getPromptFor('qwen2.5vl:7b', FIRST).prompt).toContain('bounding boxes');
    expect(getPromptFor('llava:13b', FIRST).prompt).toContain('not a description task');

    const generic = getPromptFor('mistral:7b', FIRST).prompt;
    expect(generic).not.toContain('repeated lines');
    expect(generic).not.toContain('bounding boxes');
    expect(generic).not.toContain('not a description task');
  });
});
