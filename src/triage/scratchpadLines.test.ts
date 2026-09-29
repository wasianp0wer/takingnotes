import { describe, expect, it } from 'vitest';

import { lineAtCursor, removeLine, taskTitleFromLine } from '@/triage/scratchpadLines';

describe('lineAtCursor', () => {
  const text = 'a\nbb\nccc';

  it('finds the first line when the cursor is at 0', () => {
    expect(lineAtCursor(text, 0)).toEqual({ text: 'a', start: 0, end: 1 });
  });

  it('finds the middle line when the cursor is inside it', () => {
    expect(lineAtCursor(text, 3)).toEqual({ text: 'bb', start: 2, end: 4 });
  });

  it('finds the middle line when the cursor is at its end', () => {
    expect(lineAtCursor(text, 4)).toEqual({ text: 'bb', start: 2, end: 4 });
  });

  it('clamps a cursor past the end of the text to the last line', () => {
    expect(lineAtCursor(text, 9)).toEqual({ text: 'ccc', start: 5, end: 8 });
  });

  it('handles empty text', () => {
    expect(lineAtCursor('', 0)).toEqual({ text: '', start: 0, end: 0 });
  });

  it('handles text starting with a newline without misplacing the first line', () => {
    expect(lineAtCursor('\nx', 0)).toEqual({ text: '', start: 0, end: 0 });
  });
});

describe('removeLine', () => {
  it('removes a middle line and the following newline', () => {
    const text = 'a\nbb\nccc';
    const range = lineAtCursor(text, 3); // 'bb'
    expect(removeLine(text, range)).toEqual({ text: 'a\nccc', cursor: 2 });
  });

  it('removes the last line and the preceding newline, clamping the cursor', () => {
    const text = 'a\nbb\nccc';
    const range = lineAtCursor(text, 9); // 'ccc', clamped
    expect(removeLine(text, range)).toEqual({ text: 'a\nbb', cursor: 4 });
  });

  it('removes the only line, leaving empty text', () => {
    const text = 'only';
    const range = lineAtCursor(text, 0);
    expect(removeLine(text, range)).toEqual({ text: '', cursor: 0 });
  });

  it('removes the first line and the following newline', () => {
    const text = 'a\nbb\nccc';
    const range = lineAtCursor(text, 0); // 'a'
    expect(removeLine(text, range)).toEqual({ text: 'bb\nccc', cursor: 0 });
  });
});

describe('taskTitleFromLine', () => {
  it('strips a dash bullet', () => expect(taskTitleFromLine('- buy milk')).toBe('buy milk'));

  it('strips an asterisk checkbox bullet and trims trailing space', () =>
    expect(taskTitleFromLine('  * [ ] call Sam ')).toBe('call Sam'));

  it('strips a numbered bullet', () => expect(taskTitleFromLine('1. read ch 4')).toBe('read ch 4'));

  it('strips a checked checkbox with no bullet', () =>
    expect(taskTitleFromLine('[x] done thing')).toBe('done thing'));

  it('strips a bullet character', () => expect(taskTitleFromLine('• item')).toBe('item'));

  it('reduces whitespace-only lines to empty', () => expect(taskTitleFromLine('   ')).toBe(''));

  it('leaves a leading dash that is part of a word alone', () =>
    expect(taskTitleFromLine('-dash-in-word')).toBe('-dash-in-word'));
});
