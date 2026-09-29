import { describe, expect, it } from 'vitest';
import { getPromptFor, modelFamily } from '@/transcription/prompts';

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
  it('versions the prompt by family', () => {
    expect(getPromptFor('gemma4:12b').promptVersion).toBe('gemma-v1');
    expect(getPromptFor('gemma4:12b').family).toBe('gemma');
    expect(getPromptFor('qwen2.5vl:7b').promptVersion).toBe('qwen-vl-v1');
    expect(getPromptFor('llava:13b').promptVersion).toBe('llava-v1');
    expect(getPromptFor('mistral:7b').promptVersion).toBe('generic-v1');
  });

  it('is deterministic', () => {
    expect(getPromptFor('gemma4:12b')).toEqual(getPromptFor('gemma4:12b'));
  });

  it('asks every family for Markdown and [illegible]', () => {
    const models = [
      'gemma4:12b',
      'qwen2.5vl:7b',
      'llava:13b',
      'llama3.2-vision:11b',
      'minicpm-v:8b',
      'mistral:7b',
    ];
    for (const model of models) {
      const { prompt } = getPromptFor(model);
      expect(prompt).toContain('[illegible]');
      expect(prompt).toContain('Markdown');
      expect(prompt.length).toBeGreaterThan(80);
    }
  });
});
