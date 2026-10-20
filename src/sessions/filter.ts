import { noteKey } from '@/sessions/catalog';
import type { SessionCatalog, SessionEntry } from '@/sessions/catalog';
import { entryStartedAt, entryTitle } from '@/sessions/catalog';
import { matchesTagFilter } from '@/notes/tagFilter';
import type { TagFilterMode } from '@/notes/tagFilter';
import { compileMatcher } from '@/search/matcher';
import { tagsOf } from '@/storage/notes';
import type { NoteRecord } from '@/storage/types';

export interface AdvancedFilter {
  /** 'yyyy-mm-dd', local days, inclusive. */
  from: string | null;
  to: string | null;
  tags: string[];
  tagMode: TagFilterMode;
  title: string;
  text: string;
  hasRecording: boolean;
  hasTypedPage: boolean;
  /** Empty = any. */
  statuses: NoteRecord['status'][];
  /** Applies to title and text. */
  regex: boolean;
}

export interface SidebarFilter {
  quick: string;
  advanced: AdvancedFilter;
}

export const EMPTY_SIDEBAR_FILTER: SidebarFilter = {
  quick: '',
  advanced: {
    from: null,
    to: null,
    tags: [],
    tagMode: 'and',
    title: '',
    text: '',
    hasRecording: false,
    hasTypedPage: false,
    statuses: [],
    regex: false,
  },
};

/** Whether any advanced criterion narrows the list (the regex flag alone does not). */
export function isAdvancedActive(filter: AdvancedFilter): boolean {
  return (
    filter.from !== null ||
    filter.to !== null ||
    filter.tags.length > 0 ||
    filter.title.trim() !== '' ||
    filter.text.trim() !== '' ||
    filter.hasRecording ||
    filter.hasTypedPage ||
    filter.statuses.length > 0
  );
}

/** Searchable text of one entry: page transcripts, typed text, summary and audio text, joined. */
export interface EntryText {
  text: string;
  hasTypedPage: boolean;
}

/**
 * The result of running the advanced regex off the main thread (see
 * `useRegexFilter`). `titleKeys` / `textKeys` are the entry keys that match;
 * `null` means that criterion is inactive. `filterCatalog` never builds a
 * RegExp itself.
 */
export interface RegexOutcome {
  pending: boolean;
  error: string | null;
  titleKeys: ReadonlySet<string> | null;
  textKeys: ReadonlySet<string> | null;
}

export interface FilterOutcome {
  sessions: SessionEntry[];
  uncategorized: SessionEntry[];
  error: string | null;
  pending: boolean;
}

/** Start of the local day named by 'yyyy-mm-dd', or null when malformed. */
function localDayStart(day: string, offsetDays = 0): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offsetDays).getTime();
}

function plainContains(needle: string): (text: string) => boolean {
  const compiled = compileMatcher(needle.trim(), { regex: false });
  // Plain mode always compiles.
  return compiled.ok ? compiled.matcher.test : () => true;
}

export function filterCatalog(
  catalog: SessionCatalog,
  filter: SidebarFilter,
  textByKey: ReadonlyMap<string, EntryText> | null,
  activeNoteId: string | null,
  regex: RegexOutcome | null,
): FilterOutcome {
  const { advanced } = filter;
  const quick = filter.quick.trim();
  const titleNeedle = advanced.title.trim();
  const textNeedle = advanced.text.trim();
  const fromMs = advanced.from === null ? null : localDayStart(advanced.from);
  const toMs = advanced.to === null ? null : localDayStart(advanced.to, 1);

  let pending = false;
  let error: string | null = null;

  // Regex mode: title/text come from the worker's keys. Plain mode: substring.
  let titleTest: ((e: SessionEntry) => boolean) | null = null;
  let textTest: ((e: SessionEntry) => boolean) | null = null;
  if (advanced.regex) {
    if (regex?.pending) pending = true;
    else if (regex?.error) error = regex.error;
    else if (regex) {
      const { titleKeys, textKeys } = regex;
      if (titleKeys) titleTest = (e) => titleKeys.has(e.key);
      if (textKeys) textTest = (e) => textKeys.has(e.key);
    }
  } else {
    if (titleNeedle !== '') {
      const contains = plainContains(titleNeedle);
      titleTest = (e) => contains(entryTitle(e));
    }
    if (textNeedle !== '') {
      if (textByKey === null) pending = true;
      else {
        const contains = plainContains(textNeedle);
        textTest = (e) => contains(textByKey.get(e.key)?.text ?? '');
      }
    }
  }

  let typedTest: ((e: SessionEntry) => boolean) | null = null;
  if (advanced.hasTypedPage) {
    if (textByKey === null) pending = true;
    else typedTest = (e) => e.kind === 'note' && textByKey.get(e.key)?.hasTypedPage === true;
  }

  const keep = (e: SessionEntry): boolean => {
    if (activeNoteId !== null && e.key === noteKey(activeNoteId)) return true;
    if (quick !== '') {
      const q = quick.toLowerCase();
      const inTitle = entryTitle(e).toLowerCase().includes(q);
      const inTags = e.kind === 'note' && tagsOf(e.note).some((t) => t.toLowerCase().includes(q));
      if (!inTitle && !inTags) return false;
    }
    const started = entryStartedAt(e);
    if (fromMs !== null && started < fromMs) return false;
    if (toMs !== null && started >= toMs) return false;
    if (advanced.tags.length > 0) {
      if (e.kind !== 'note') return false;
      if (!matchesTagFilter(tagsOf(e.note), advanced.tags, advanced.tagMode)) return false;
    }
    if (advanced.hasRecording && e.kind === 'note' && e.recordings.length === 0) return false;
    if (advanced.statuses.length > 0) {
      if (e.kind !== 'note' || !advanced.statuses.includes(e.note.status)) return false;
    }
    if (titleTest && !titleTest(e)) return false;
    if (textTest && !textTest(e)) return false;
    if (typedTest && !typedTest(e)) return false;
    return true;
  };

  return {
    sessions: catalog.sessions.filter(keep),
    uncategorized: catalog.uncategorized.filter(keep),
    error,
    pending,
  };
}
