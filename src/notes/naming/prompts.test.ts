import { describe, expect, it } from 'vitest';

import { getNamingPrompt } from '@/notes/naming/prompts';

describe('getNamingPrompt', () => {
  it('carries a versioned promptVersion', () => {
    expect(getNamingPrompt().promptVersion).toBe('naming-v1');
  });

  it('build() embeds the given text', () => {
    const spec = getNamingPrompt();
    expect(spec.build({ text: 'Newton on motion.' })).toContain('Newton on motion.');
  });

  it('the system prompt asks for the exact JSON shape validateNamingResult expects', () => {
    const spec = getNamingPrompt();
    expect(spec.system).toContain('title');
    expect(spec.system).toContain('summary');
  });
});
