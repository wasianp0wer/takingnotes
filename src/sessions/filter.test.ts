import { describe, expect, it } from 'vitest';

import { buildSessionCatalog } from '@/sessions/catalog';
import {
  EMPTY_SIDEBAR_FILTER,
  filterCatalog,
  isAdvancedActive,
} from '@/sessions/filter';
import type { AdvancedFilter, EntryText, RegexOutcome, SidebarFilter } from '@/sessions/filter';
import type { NoteRecord, RecordingRecord } from '@/storage/types';

function note(
  id: string,
  title: string,
  startedAt: number,
  extra: Partial<NoteRecord> = {},
): NoteRecord {
  return {
    id,
    title,
    status: 'complete',
    deviceId: 'd',
    deviceType: 'huion',
    deviceName: null,
    startedAt,
    endedAt: null,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
    ...extra,
  };
}

function rec(id: string, title: string, startedAt: number, noteId: string | null): RecordingRecord {
  return {
    id,
    sessionId: null,
    noteId,
    title,
    startedAt,
    endedAt: null,
    durationMs: 1,
    mimeType: 'audio/webm',
    byteLength: 1,
    transcript: null,
  };
}

const at = (day: number, hour = 10) => new Date(2026, 9, day, hour).getTime();

const catalog = buildSessionCatalog(
  [
    note('a', 'HIST 210 lecture', at(14), { sessionId: 's1', tags: ['hist210'] }),
    note('b', 'Bio notes. v2', at(15), { sessionId: 's2', tags: ['bio'], status: 'interrupted' }),
    note('c', 'Intro', at(13), { sessionId: 's3', tags: ['hist210', 'intro'] }),
    note('u', 'Groceries', at(14, 23)),
  ],
  [rec('r1', 'Voice memo', at(12), null), rec('r2', 'Lecture audio', at(14, 11), 'a')],
);

const textByKey = new Map<string, EntryText>([
  ['note:a', { text: 'The bureau of records', hasTypedPage: true }],
  ['note:b', { text: 'cells', hasTypedPage: false }],
  ['note:c', { text: 'welcome', hasTypedPage: false }],
  ['note:u', { text: 'milk', hasTypedPage: false }],
  ['recording:r1', { text: 'bureau chief spoke', hasTypedPage: false }],
]);

function withAdvanced(patch: Partial<AdvancedFilter>, quick = ''): SidebarFilter {
  return { quick, advanced: { ...EMPTY_SIDEBAR_FILTER.advanced, ...patch } };
}

function keys(f: SidebarFilter, text = textByKey, active: string | null = null, rx = null as RegexOutcome | null) {
  const out = filterCatalog(catalog, f, text, active, rx);
  return { all: [...out.sessions, ...out.uncategorized].map((e) => e.key).sort(), out };
}

const everyKey = keys(EMPTY_SIDEBAR_FILTER).all;

describe('filterCatalog', () => {
  it('an empty filter keeps everything', () => {
    expect(everyKey).toEqual(['note:a', 'note:b', 'note:c', 'note:u', 'recording:r1']);
    expect(isAdvancedActive(EMPTY_SIDEBAR_FILTER.advanced)).toBe(false);
  });

  it('quick filter is a case-insensitive substring over title and tags', () => {
    expect(keys(withAdvanced({}, 'HIST')).all).toEqual(['note:a', 'note:c']);
    expect(keys(withAdvanced({}, 'voice')).all).toEqual(['recording:r1']);
  });

  it('the quick box is never regex', () => {
    expect(keys(withAdvanced({ regex: true }, '.')).all).toEqual(['note:b']);
    expect(keys(withAdvanced({}, '.')).all).toEqual(['note:b']);
  });

  it('date range uses local-day bounds, inclusive', () => {
    const f = withAdvanced({ from: '2026-10-14', to: '2026-10-14' });
    expect(keys(f).all).toEqual(['note:a', 'note:u']);
    expect(isAdvancedActive(f.advanced)).toBe(true);
  });

  it('tags follow matchesTagFilter in and/or modes', () => {
    expect(keys(withAdvanced({ tags: ['hist210', 'intro'], tagMode: 'and' })).all).toEqual([
      'note:c',
    ]);
    expect(keys(withAdvanced({ tags: ['hist210', 'bio'], tagMode: 'or' })).all).toEqual([
      'note:a',
      'note:b',
      'note:c',
    ]);
  });

  it('hasRecording keeps notes with recordings and every orphan recording', () => {
    expect(keys(withAdvanced({ hasRecording: true })).all).toEqual(['note:a', 'recording:r1']);
  });

  it('hasTypedPage keeps notes with a typed page', () => {
    expect(keys(withAdvanced({ hasTypedPage: true })).all).toEqual(['note:a']);
  });

  it('statuses keep only matching notes and drop orphan recordings', () => {
    expect(keys(withAdvanced({ statuses: ['interrupted'] })).all).toEqual(['note:b']);
  });

  it('plain title is a case-insensitive substring', () => {
    expect(keys(withAdvanced({ title: 'hist 2' })).all).toEqual(['note:a']);
  });

  it('regex title uses the matched keys from the regex outcome', () => {
    const rx: RegexOutcome = {
      pending: false,
      error: null,
      titleKeys: new Set(['note:a']),
      textKeys: null,
    };
    expect(keys(withAdvanced({ title: '^HIST \\d+', regex: true }), textByKey, null, rx).all).toEqual(
      ['note:a'],
    );
  });

  it('an outcome is ignored when regex is off', () => {
    const rx: RegexOutcome = { pending: true, error: 'x', titleKeys: new Set(), textKeys: null };
    const { all, out } = keys(withAdvanced({ title: 'intro' }), textByKey, null, rx);
    expect(all).toEqual(['note:c']);
    expect(out.error).toBeNull();
    expect(out.pending).toBe(false);
  });

  it('an invalid regex reports an error and does not empty the list', () => {
    const rx: RegexOutcome = {
      pending: false,
      error: 'Invalid pattern: Unterminated character class',
      titleKeys: null,
      textKeys: null,
    };
    const f = withAdvanced({ title: '[', regex: true, statuses: ['complete'] }, '');
    const { all, out } = keys(f, textByKey, null, rx);
    expect(out.error).toBe('Invalid pattern: Unterminated character class');
    // status criterion still applies, the regex one does not: not emptied.
    expect(all).toEqual(['note:a', 'note:c', 'note:u']);
  });

  it('a pending regex leaves the lists unchanged by the regex criteria', () => {
    const rx: RegexOutcome = { pending: true, error: null, titleKeys: null, textKeys: null };
    const { all, out } = keys(withAdvanced({ title: 'x', regex: true }), textByKey, null, rx);
    expect(out.pending).toBe(true);
    expect(all).toEqual(everyKey);
  });

  it('regex text uses textKeys', () => {
    const rx: RegexOutcome = {
      pending: false,
      error: null,
      titleKeys: null,
      textKeys: new Set(['recording:r1']),
    };
    expect(keys(withAdvanced({ text: 'bur', regex: true }), textByKey, null, rx).all).toEqual([
      'recording:r1',
    ]);
  });

  it('text criteria wait for the text index', () => {
    const f = withAdvanced({ text: 'bureau' });
    const waiting = filterCatalog(catalog, f, null, null, null);
    expect(waiting.pending).toBe(true);
    expect([...waiting.sessions, ...waiting.uncategorized]).toHaveLength(5);
    const ready = keys(f);
    expect(ready.out.pending).toBe(false);
    expect(ready.all).toEqual(['note:a', 'recording:r1']);
  });

  it('the active note is never hidden', () => {
    const f = withAdvanced({ statuses: ['interrupted'] });
    expect(keys(f, textByKey, 'a').all).toEqual(['note:a', 'note:b']);
  });
});
