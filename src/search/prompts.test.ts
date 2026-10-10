import { describe, expect, it } from 'vitest';

import { getBandPrompt, getScreenPrompt } from '@/search/prompts';
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

  it("round-trips a worked screen reply, written from the prompt's own stated shape, through its validator", () => {
    const spec = getScreenPrompt();
    expect(spec.system).toContain('JSON array of integers');
    // The example is `[1, 4, 7]` per the prompt's own wording.
    const reply = '[1, 3]';
    const parsed = JSON.parse(reply) as unknown;
    expect(validateScreenIndices(parsed, 5)).toEqual([1, 3]);
  });

  it("round-trips a worked band reply, written from the prompt's own stated shape, through its validator", () => {
    const spec = getBandPrompt();
    expect(spec.system).toContain('"band"');
    expect(spec.system).toContain('"reason"');
    const reply = '{"band": "strong", "reason": "mentions recursion directly"}';
    const parsed = JSON.parse(reply) as unknown;
    expect(validateBandResult(parsed)).toEqual({ band: 'strong', reason: 'mentions recursion directly' });
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
