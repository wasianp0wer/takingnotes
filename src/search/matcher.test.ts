import { describe, expect, it } from 'vitest';

import { MAX_PATTERN_LENGTH, compileMatcher } from '@/search/matcher';

function ok(query: string, regex: boolean) {
  const r = compileMatcher(query, { regex });
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.matcher;
}

function err(query: string): string {
  const r = compileMatcher(query, { regex: true });
  if (r.ok) throw new Error(`expected rejection of ${query}`);
  return r.error;
}

describe('compileMatcher', () => {
  it('plain mode is a case-insensitive substring, not a pattern', () => {
    const m = ok('a.b', false);
    expect(m.test('xA.Bx')).toBe(true);
    expect(m.test('axb')).toBe(false);
  });

  it('regex mode is case-insensitive', () => {
    expect(ok('a.b', true).test('AXB')).toBe(true);
  });

  it('firstMatch returns index and length', () => {
    expect(ok('b+', true).firstMatch('aabbbc')).toEqual({ index: 2, length: 3 });
    expect(ok('bc', false).firstMatch('aaBC')).toEqual({ index: 2, length: 2 });
    expect(ok('zz', true).firstMatch('aabbbc')).toBeNull();
  });

  it('reports a syntax error as Invalid pattern', () => {
    expect(err('[')).toMatch(/^Invalid pattern/);
  });

  it('rejects a pattern over the length limit, naming it', () => {
    expect(err('a'.repeat(MAX_PATTERN_LENGTH + 1))).toContain(String(MAX_PATTERN_LENGTH));
    expect(compileMatcher('a'.repeat(MAX_PATTERN_LENGTH), { regex: true }).ok).toBe(true);
  });

  it.each(['(a+)+$', '(a*)*', '(\\w+\\s?)+$', '(a|aa)+', '(?:a+)+', 'x((a)*b)+', '(a+){2,}', '(a|b){1,5}', '(a+){30}b', '(\\w+\\s?){12}$', '(a|a){25}b', '(a+){20}'])(
    'rejects nested repetition %s',
    (p) => {
      expect(err(p)).toContain('too long to run');
    },
  );

  it.each(['(abc)+', '(foo|bar)?', 'colou?r', '(a)?b+', '\\(a+\\)+', '[(a+]+', '(a+)', '(ab){3}', '(?=a+)b', '(?<n>ab)+'])(
    'accepts safe pattern %s',
    (p) => {
      expect(compileMatcher(p, { regex: true }).ok).toBe(true);
    },
  );

  // No cap on unbounded quantifiers: these are ordinary patterns, and the
  // Worker's time budget (regexRunner.ts) is what stops a slow one.
  it.each(['\\w+\\s+\\w+', '\\d+:\\d+:\\d+', '.*foo.*bar.*', 'a+b+c+d+'])(
    'accepts ordinary pattern %s with several unbounded quantifiers',
    (p) => {
      expect(compileMatcher(p, { regex: true }).ok).toBe(true);
    },
  );

  it('ignores quantifier characters inside classes and escapes when counting', () => {
    expect(compileMatcher('[+*][+*][+*]\\+\\+', { regex: true }).ok).toBe(true);
  });

  it('treats a zero-length regex match as no match', () => {
    for (const p of ['x*', '^', '$', 'x?']) {
      const m = ok(p, true);
      expect(m.test('abc')).toBe(false);
      expect(m.firstMatch('abc')).toBeNull();
    }
  });

  it('test() is stateless across calls', () => {
    const m = ok('abc', true);
    expect(m.test('abc')).toBe(true);
    expect(m.test('abc')).toBe(true);
  });
});
