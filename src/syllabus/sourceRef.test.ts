import { describe, expect, it } from 'vitest';

import { importKeyForFile, importKeyForPastedText, sourceRefFor } from '@/syllabus/sourceRef';

const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();
const KEY = 'file:hist101.pdf';

describe('sourceRefFor', () => {
  it('is stable for the same import key and assignment', () => {
    const a = { title: 'Essay 1', dueAt: local(2026, 10, 15) };
    expect(sourceRefFor(KEY, a)).toBe(sourceRefFor(KEY, { ...a }));
    expect(sourceRefFor(KEY, a)).toContain(KEY);
  });

  it('ignores case and whitespace in the title', () => {
    const ref = sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15) });
    expect(sourceRefFor(KEY, { title: '  essay   1 ', dueAt: local(2026, 10, 15) })).toBe(ref);
  });

  it('changes when the title changes (A26)', () => {
    const at = local(2026, 10, 15);
    expect(sourceRefFor(KEY, { title: 'Essay 1', dueAt: at })).not.toBe(
      sourceRefFor(KEY, { title: 'Essay one', dueAt: at }),
    );
  });

  it('changes when the resolved day changes', () => {
    expect(sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15) })).not.toBe(
      sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 16) }),
    );
  });

  it('does not change when only the time of day changes', () => {
    expect(sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15, 9) })).toBe(
      sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15, 23) }),
    );
  });

  it('gives an undated assignment a stable ref of its own', () => {
    const ref = sourceRefFor(KEY, { title: 'Final paper', dueAt: null });
    expect(ref).toBe(sourceRefFor(KEY, { title: 'final paper', dueAt: null }));
    expect(ref).toContain('none');
  });

  it('separates two syllabuses that name an assignment the same', () => {
    const a = { title: 'Essay 1', dueAt: local(2026, 10, 15) };
    expect(sourceRefFor('file:hist101.pdf', a)).not.toBe(sourceRefFor('file:engl210.pdf', a));
  });
});

describe('import keys', () => {
  it('names a file', () => {
    expect(importKeyForFile('HIST 101 syllabus.pdf')).toBe('file:HIST 101 syllabus.pdf');
  });

  it('hashes pasted text, deterministically', () => {
    const text = 'Essay 1 due Oct 15\nMidterm Nov 2';
    expect(importKeyForPastedText(text)).toBe(importKeyForPastedText(text));
    expect(importKeyForPastedText(text)).toMatch(/^pasted:[0-9a-f]+$/);
    expect(importKeyForPastedText(text)).not.toBe(importKeyForPastedText(`${text} `));
  });
});
