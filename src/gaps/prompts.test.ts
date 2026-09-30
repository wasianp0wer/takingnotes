import { describe, expect, it } from 'vitest';

import { GAP_KINDS, gapModelFamily, gapPromptVersion, getGapPrompt } from '@/gaps/prompts';

const MODELS = ['gemma4:12b', 'mistral:7b'];

describe('gapModelFamily', () => {
  it('maps gemma names, with namespace and tag stripped', () => {
    expect(gapModelFamily('gemma4:12b')).toBe('gemma');
    expect(gapModelFamily('library/gemma4:latest')).toBe('gemma');
    expect(gapModelFamily('GEMMA3:4B')).toBe('gemma');
  });

  it('falls back to generic', () => {
    expect(gapModelFamily('mistral:7b')).toBe('generic');
    expect(gapModelFamily('')).toBe('generic');
  });
});

describe('getGapPrompt', () => {
  it('versions each prompt by kind and family', () => {
    expect(getGapPrompt('compare', 'gemma4:12b').promptVersion).toBe('gap-compare-gemma-v1');
    expect(getGapPrompt('summarize', 'gemma4:12b').promptVersion).toBe('gap-summarize-gemma-v1');
    expect(getGapPrompt('compare', 'mistral:7b').promptVersion).toBe('gap-compare-generic-v1');
    expect(getGapPrompt('summarize', 'mistral:7b').promptVersion).toBe('gap-summarize-generic-v1');
  });

  it('never shares a version between the two kinds', () => {
    for (const model of MODELS) {
      expect(getGapPrompt('compare', model).promptVersion).not.toBe(
        getGapPrompt('summarize', model).promptVersion,
      );
    }
  });

  it('is deterministic', () => {
    const a = getGapPrompt('compare', 'gemma4:12b');
    const b = getGapPrompt('compare', 'gemma4:12b');
    expect(a.promptVersion).toBe(b.promptVersion);
    expect(a.system).toBe(b.system);
    expect(a.build({ notes: 'n', speech: 's', summarized: false })).toBe(
      b.build({ notes: 'n', speech: 's', summarized: false }),
    );
  });

  it('asks every family for the JSON shape P1 stores', () => {
    for (const model of MODELS) {
      const spec = getGapPrompt('compare', model);
      const text = `${spec.system}\n${spec.build({ notes: 'n', speech: 's', summarized: false })}`;
      for (const kind of GAP_KINDS) expect(text).toContain(kind);
      expect(text).toContain('text');
      expect(text).toContain('kind');
      expect(text).toContain('sourceQuote');
      expect(text).toContain('JSON');
      expect(text).toMatch(/empty (JSON )?array|\[\]/);
      expect(text.length).toBeGreaterThan(200);
    }
  });

  it('asks every family to summarize substantively, as bullet points', () => {
    for (const model of MODELS) {
      const spec = getGapPrompt('summarize', model);
      const text = `${spec.system}\n${spec.build({ chunk: 'c', index: 0, total: 3 })}`;
      expect(text.toLowerCase()).toContain('bullet');
      expect(text.toLowerCase()).toContain('substantive');
      expect(text).toContain('c');
    }
  });

  it('embeds what it is given and keeps the two prompts apart', () => {
    const compare = getGapPrompt('compare', 'gemma4:12b');
    const built = compare.build({ notes: 'THE-NOTES', speech: 'THE-SPEECH', summarized: false });
    expect(built).toContain('THE-NOTES');
    expect(built).toContain('THE-SPEECH');
    expect(built).not.toContain('sourceQuote-free');
    const summarize = getGapPrompt('summarize', 'gemma4:12b');
    expect(summarize.build({ chunk: 'THE-CHUNK', index: 1, total: 4 })).toContain('THE-CHUNK');
    expect(summarize.build({ chunk: 'x', index: 1, total: 4 })).not.toContain('sourceQuote');
  });

  it('says when the notes are empty and when the speech was summarized', () => {
    const compare = getGapPrompt('compare', 'gemma4:12b');
    expect(compare.build({ notes: '', speech: 's', summarized: false }).toLowerCase()).toContain(
      'nothing',
    );
    expect(compare.build({ notes: 'n', speech: 's', summarized: true }).toLowerCase()).toContain(
      'summar',
    );
  });
});

describe('gapPromptVersion', () => {
  it('is the compare version for a direct comparison', () => {
    expect(gapPromptVersion('gemma4:12b', false)).toBe('gap-compare-gemma-v1');
  });

  it('names both prompts, summarize first, for a summarized comparison', () => {
    expect(gapPromptVersion('gemma4:12b', true)).toBe(
      'gap-summarize-gemma-v1+gap-compare-gemma-v1',
    );
    expect(gapPromptVersion('mistral:7b', true)).toBe(
      'gap-summarize-generic-v1+gap-compare-generic-v1',
    );
  });
});

describe('GAP_KINDS', () => {
  it('is the six kinds the storage type allows, in spec order', () => {
    expect(GAP_KINDS).toEqual([
      'claim',
      'definition',
      'name-or-date',
      'example',
      'argument-step',
      'other',
    ]);
  });
});
