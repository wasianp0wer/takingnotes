import { describe, expect, it } from 'vitest';

import {
  BAND_LABELS,
  getBandPrompt,
  getScreenPrompt,
  SCREEN_EXAMPLE_INDICES,
} from '@/search/prompts';
import { validateBandResult, validateScreenIndices } from '@/search/validate';

describe('search prompts', () => {
  it('getScreenPrompt builds a numbered candidate list the validator can key back into', () => {
    const spec = getScreenPrompt();
    const text = spec.build({
      query: 'recursion',
      candidates: [
        { index: 1, title: 'Lecture 1', text: 'covers loops' },
        { index: 2, title: 'Lecture 2', text: 'covers recursion and base cases' },
      ],
    });
    expect(text).toContain('recursion');
    expect(text).toContain('Lecture 1');
    expect(text).toContain('Lecture 2');
    expect(text).toMatch(/1\./);
    expect(text).toMatch(/2\./);
  });

  it('getScreenPrompt says (no content) for a blank candidate text rather than leaving it empty', () => {
    const spec = getScreenPrompt();
    const text = spec.build({ query: 'q', candidates: [{ index: 1, title: 'T', text: '   ' }] });
    expect(text).toContain('(no content)');
  });

  it('getBandPrompt builds the query, the note title and its text', () => {
    const spec = getBandPrompt();
    const text = spec.build({ query: 'entropy', noteTitle: 'Thermo 2', text: 'discusses entropy at length' });
    expect(text).toContain('entropy');
    expect(text).toContain('Thermo 2');
    expect(text).toContain('discusses entropy at length');
  });

  it("round-trips the screen prompt's own literal worked example through its validator (fix round 3, I3)", () => {
    const spec = getScreenPrompt();
    expect(spec.system).toContain('JSON array of integers');
    // `SCREEN_EXAMPLE_INDICES` is the literal array interpolated into the
    // prompt's own wording (see prompts.ts) - not a hand-typed stand-in
    // that could silently diverge from what the prompt actually shows.
    expect(spec.system).toContain(`[${SCREEN_EXAMPLE_INDICES.join(', ')}]`);
    const reply = JSON.stringify(SCREEN_EXAMPLE_INDICES);
    const parsed = JSON.parse(reply) as unknown;
    const validIndices = new Set<number>(SCREEN_EXAMPLE_INDICES);
    expect(validateScreenIndices(parsed, validIndices)).toEqual([...SCREEN_EXAMPLE_INDICES].sort((a, b) => a - b));
  });

  it("round-trips a worked band reply through its validator", () => {
    const spec = getBandPrompt();
    expect(spec.system).toContain('"band"');
    expect(spec.system).toContain('"reason"');
    const reply = '{"band": "strong", "reason": "mentions recursion directly"}';
    const parsed = JSON.parse(reply) as unknown;
    expect(validateBandResult(parsed)).toEqual({ band: 'strong', reason: 'mentions recursion directly' });
  });

  // Fix round 3, I3: the band prompt's wording is built from `BAND_LABELS`
  // (see prompts.ts's `BAND_RULE_LIST`), and `validateBandResult`'s
  // accepted set is built from the same array. This test imports
  // `BAND_LABELS` rather than typing out "strong"/"moderate"/"weak"/"none"
  // by hand, so it automatically covers whatever the prompt actually
  // claims the model may answer with - a pass that renames or adds a band
  // changes this one array, and this test (and the validator) pick the
  // change up without being edited.
  it.each(BAND_LABELS)('every label the band prompt quotes ("%s") round-trips through validateBandResult to itself', (label) => {
    const spec = getBandPrompt();
    expect(spec.system).toContain(`"${label}"`);
    expect(validateBandResult({ band: label, reason: 'x' }).band).toBe(label);
  });

  it('prompt versions are stable, non-empty and distinct from each other and from every existing registry', () => {
    const screen = getScreenPrompt().promptVersion;
    const band = getBandPrompt().promptVersion;
    expect(screen).toBe('search-screen-v1');
    expect(band).toBe('search-band-v1');
    expect(screen).not.toBe(band);
    const existing = ['naming-v1', 'gemma-v1', 'generic-v1', 'typed/1'];
    expect(existing).not.toContain(screen);
    expect(existing).not.toContain(band);
  });

  it('getScreenPrompt is deterministic for the same input', () => {
    const spec = getScreenPrompt();
    const input = { query: 'q', candidates: [{ index: 1, title: 'T', text: 'x' }] };
    expect(spec.build(input)).toBe(spec.build(input));
  });
});
