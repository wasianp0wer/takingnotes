import { describe, expect, it } from 'vitest';

import { validateNamingResult } from '@/notes/naming/validate';

describe('validateNamingResult', () => {
  it('accepts {title, summary} and trims both', () => {
    expect(validateNamingResult({ title: '  Newton on motion  ', summary: '  A lecture. ' })).toEqual({
      title: 'Newton on motion',
      summary: 'A lecture.',
    });
  });

  it('allows a blank title (setNoteSummary treats it as a failed generation)', () => {
    expect(validateNamingResult({ title: '  ', summary: 'A summary.' })).toEqual({
      title: '',
      summary: 'A summary.',
    });
  });

  it('throws when the value is not an object', () => {
    expect(() => validateNamingResult('not an object')).toThrow();
    expect(() => validateNamingResult(null)).toThrow();
    expect(() => validateNamingResult([{ title: 'x', summary: 'y' }])).toThrow();
  });

  it('throws when a required field is missing or the wrong type', () => {
    expect(() => validateNamingResult({ title: 'x' })).toThrow();
    expect(() => validateNamingResult({ summary: 'y' })).toThrow();
    expect(() => validateNamingResult({ title: 1, summary: 'y' })).toThrow();
    expect(() => validateNamingResult({ title: 'x', summary: 2 })).toThrow();
  });

  it('throws when summary is blank - unlike title, a blank summary is not a documented failure mode', () => {
    expect(() => validateNamingResult({ title: 'x', summary: '   ' })).toThrow();
  });
});
