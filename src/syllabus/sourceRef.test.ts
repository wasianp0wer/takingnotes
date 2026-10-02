import { describe, expect, it } from 'vitest';

import { dedupeAssignments } from '@/syllabus/assignments';
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

  it('does not let a # in the import key or title shift the component boundary', () => {
    const d = local(2026, 10, 15);
    const a = sourceRefFor('file:hist#101.pdf', { title: 'Midterm', dueAt: d });
    const b = sourceRefFor('file:hist', { title: '101.pdf#Midterm', dueAt: d });
    expect(a).not.toBe(b);
  });

  it('is stable when the title itself contains separator characters', () => {
    const a = { title: 'Essay #1 @ noon', dueAt: local(2026, 10, 15) };
    expect(sourceRefFor(KEY, a)).toBe(sourceRefFor(KEY, { ...a }));
  });

  it('separates two different titles that both normalize to empty', () => {
    const d = local(2026, 10, 15);
    const dots = sourceRefFor(KEY, { title: '...', dueAt: d });
    const dashes = sourceRefFor(KEY, { title: '---', dueAt: d });
    expect(dots).not.toBe(dashes);
    expect(dots).toBe(sourceRefFor(KEY, { title: '...', dueAt: d }));
    expect(dashes).toBe(sourceRefFor(KEY, { title: '---', dueAt: d }));
  });
});

describe('agreement with dedupeAssignments on "the same day" (day.ts)', () => {
  // sourceRefFor and dedupeAssignments both decide "same day" via the shared
  // day.ts, on purpose (A26): a second, independent notion of "same day" in
  // either module would let them drift apart and reopen that bug silently.
  // These instants sit close to local midnight, where a UTC-based day (e.g.
  // `toISOString()`) would disagree with a local one - the exact drift the
  // shared module exists to prevent.

  it('agree that two instants sharing a local day, but not a UTC day, are the same day', () => {
    const lateAtNight = new Date(2026, 9, 15, 23, 30).getTime(); // 11:30pm, 15 Oct local
    const justAfterMidnight = new Date(2026, 9, 15, 0, 30).getTime(); // 12:30am, 15 Oct local

    const rows = dedupeAssignments([
      { title: 'Essay 1', dueAt: lateAtNight, rawDate: 'a', estimatedMinutes: null, notes: '' },
      {
        title: 'Essay 1',
        dueAt: justAfterMidnight,
        rawDate: 'b',
        estimatedMinutes: null,
        notes: '',
      },
    ]);
    expect(rows).toHaveLength(1);

    expect(sourceRefFor(KEY, { title: 'Essay 1', dueAt: lateAtNight })).toBe(
      sourceRefFor(KEY, { title: 'Essay 1', dueAt: justAfterMidnight }),
    );
  });

  it('agree that two instants on different local days are different days', () => {
    const endOfDay = new Date(2026, 9, 15, 23, 59).getTime();
    const startOfNextDay = new Date(2026, 9, 16, 0, 1).getTime();

    const rows = dedupeAssignments([
      { title: 'Essay 1', dueAt: endOfDay, rawDate: 'a', estimatedMinutes: null, notes: '' },
      { title: 'Essay 1', dueAt: startOfNextDay, rawDate: 'b', estimatedMinutes: null, notes: '' },
    ]);
    expect(rows).toHaveLength(2);

    expect(sourceRefFor(KEY, { title: 'Essay 1', dueAt: endOfDay })).not.toBe(
      sourceRefFor(KEY, { title: 'Essay 1', dueAt: startOfNextDay }),
    );
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
