import { describe, expect, it } from 'vitest';

import { getNamingPrompt } from '@/notes/naming/prompts';
import { validateNamingResult } from '@/notes/naming/validate';

describe('getNamingPrompt', () => {
  it('carries a versioned promptVersion', () => {
    expect(getNamingPrompt().promptVersion).toBe('naming-v1');
  });

  it('build() embeds the given text', () => {
    const spec = getNamingPrompt();
    expect(spec.build({ text: 'Newton on motion.' })).toContain('Newton on motion.');
  });

  it('the system prompt names the exact JSON keys validateNamingResult expects, round-tripping a worked example through it (fix round 1, Important 4)', () => {
    // `toContain('title')` / `toContain('summary')` (the original version of
    // this test) passes against a prompt asking for `title_text`, a nested
    // object, or YAML - this is the only guard anywhere on the
    // prompt<->validator pairing, and no real-model test covers it, so a
    // mismatch would mean naming silently never succeeds against real Gemma
    // while every other test here stays green. A regex anchored on the
    // literal `{ "title": string, "summary": string }` fragment, plus
    // actually running a worked example through the validator, both fail if
    // the prompt's documented shape and the validator's expected shape ever
    // drift apart.
    const spec = getNamingPrompt();
    expect(spec.system).toMatch(/\{\s*"title"\s*:\s*string\s*,\s*"summary"\s*:\s*string\s*\}/);

    const workedExample = '{"title": "Newton on motion", "summary": "Covers the three laws of motion."}';
    const result = validateNamingResult(JSON.parse(workedExample));
    expect(result).toEqual({
      title: 'Newton on motion',
      summary: 'Covers the three laws of motion.',
    });
  });
});
