import { hasSearchableTranscript, type SearchCorpus } from '@/search/corpus';
import { compileMatcher } from '@/search/matcher';
import { tagsOf } from '@/storage/notes';
import { matchesTagFilter, type TagFilterMode } from '@/notes/tagFilter';

/**
 * Fix round 3, I4: below this, a query matches so broadly (every note
 * whose title happens to contain a common letter) that the result is
 * noise, not a find - and on a semester-sized library, scanning for a
 * one-character query is exactly the "tens of thousands of segments"
 * case the coordinator named.
 */
export const MIN_QUERY_LENGTH = 2;

export type FindHitSource = 'note-title' | 'note-summary' | 'page-text' | 'audio-segment';

export interface FindHit {
  source: FindHitSource;
  /** `null` only for an 'audio-segment' hit whose recording has no owning note (A10). */
  noteId: string | null;
  noteTitle: string | null;
  /** 'page-text' only. */
  pageIndex?: number;
  /** 'page-text' only - K32's typed/ink distinction. */
  isTyped?: boolean;
  /** 'audio-segment' only. */
  recordingId?: string;
  recordingTitle?: string;
  startMs?: number;
  snippet: string;
}

/**
 * Text around the first case-insensitive match of `query` in `text`, trimmed,
 * with a leading/trailing ellipsis when truncated. Returns the text verbatim
 * (no ellipses) when it already fits within `radius` of the match.
 */
export function snippetAround(text: string, query: string, radius = 60): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(query.toLowerCase());
  if (at === -1) return text.trim().slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/** Like `snippetAround`, but for a match already located by index and length. */
export function snippetAt(text: string, index: number, length: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export interface FindOptions {
  regex?: boolean;
  /** Epoch ms, inclusive. */
  from?: number | null;
  /** Epoch ms, inclusive. */
  to?: number | null;
  tags?: readonly string[];
  /** Default 'or'. */
  tagMode?: TagFilterMode;
  /** Default: all four. */
  sources?: readonly FindHitSource[];
}

const ALL_SOURCES: readonly FindHitSource[] = ['note-title', 'note-summary', 'page-text', 'audio-segment'];

/**
 * K40's Find mode: immediate, local match over the sources K41 names -
 * case-insensitive substring by default, or a guarded regex (see
 * `compileMatcher`). Pure and synchronous so a `SearchView` can re-run this
 * on every keystroke against an already-loaded `SearchCorpus` without
 * re-reading storage. An invalid or unsafe pattern yields no hits.
 */
export function findInCorpus(corpus: SearchCorpus, query: string, options: FindOptions = {}): FindHit[] {
  const regex = options.regex === true;
  const q = regex ? query : query.trim();
  if (regex ? q.length === 0 : q.length < MIN_QUERY_LENGTH) return [];
  const compiled = compileMatcher(q, { regex });
  if (!compiled.ok) return [];
  const { matcher } = compiled;

  const sources = new Set(options.sources ?? ALL_SOURCES);
  const from = options.from ?? null;
  const to = options.to ?? null;
  const tags = options.tags ?? [];
  const tagMode = options.tagMode ?? 'or';
  const inRange = (at: number) => (from === null || at >= from) && (to === null || at <= to);

  const hits: FindHit[] = [];
  const snippetOf = (text: string): string => {
    const m = matcher.firstMatch(text);
    return m ? snippetAt(text, m.index, m.length) : text.trim().slice(0, 120);
  };

  // Fix round 3, I4: hoisted out of the per-segment loop below, which
  // previously called `corpus.notes.find(...)` - a linear scan - once per
  // *matching segment* rather than once per `findInCorpus` call.
  const noteById = new Map(corpus.notes.map((n) => [n.note.id, n.note]));
  const noteAllowed = (note: { startedAt: number } & Parameters<typeof tagsOf>[0]): boolean =>
    inRange(note.startedAt) && matchesTagFilter(tagsOf(note), tags, tagMode);

  for (const { note, pages } of corpus.notes) {
    if (!noteAllowed(note)) continue;
    if (sources.has('note-title') && matcher.test(note.title)) {
      hits.push({ source: 'note-title', noteId: note.id, noteTitle: note.title, snippet: snippetOf(note.title) });
    }
    if (sources.has('note-summary') && note.summary !== null && matcher.test(note.summary)) {
      hits.push({ source: 'note-summary', noteId: note.id, noteTitle: note.title, snippet: snippetOf(note.summary) });
    }
    if (!sources.has('page-text')) continue;
    for (const page of pages) {
      if (matcher.test(page.text)) {
        hits.push({
          source: 'page-text',
          noteId: note.id,
          noteTitle: note.title,
          pageIndex: page.pageIndex,
          isTyped: page.isTyped,
          snippet: snippetOf(page.text),
        });
      }
    }
  }

  if (!sources.has('audio-segment')) return hits;
  for (const recording of corpus.recordings) {
    // ⚑ The same predicate smart search uses, rather than no gate at all.
    // Reading `segments` unconditionally returned a *failed* transcript's
    // leftovers - which `corpus.ts` deliberately withholds from smart search
    // as a stale attempt's - so the two modes disagreed about whether that
    // text was trustworthy, and the ungated one had no warning attached.
    if (!hasSearchableTranscript(recording)) continue;
    const noteId = corpus.recordingOwner.get(recording.id) ?? null;
    const owner = noteId !== null ? noteById.get(noteId) : undefined;
    // An owned recording follows its note; an orphan is dated by its own start
    // and has no tags, so any tag filter excludes it.
    if (owner !== undefined) {
      if (!noteAllowed(owner)) continue;
    } else if (!inRange(recording.startedAt) || tags.length > 0) {
      continue;
    }
    const segments = recording.transcript?.segments ?? [];
    for (const segment of segments) {
      if (matcher.test(segment.text)) {
        hits.push({
          source: 'audio-segment',
          noteId,
          noteTitle: owner?.title ?? null,
          recordingId: recording.id,
          recordingTitle: recording.title,
          startMs: segment.startMs,
          snippet: snippetOf(segment.text),
        });
      }
    }
  }

  return hits;
}
