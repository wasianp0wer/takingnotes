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
  /** Where the match sits within `snippet`, when it is visible there. */
  highlight?: { start: number; length: number };
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
  return snippetWithMatch(text, index, length, radius).snippet;
}

/**
 * `snippetAt`, plus where the match sits within the snippet (after the
 * leading ellipsis and trimming; clamped to the visible text, and absent when
 * none of it is visible). Lets a regex hit be highlighted without re-running
 * the pattern.
 */
export function snippetWithMatch(
  text: string,
  index: number,
  length: number,
  radius = 60,
): { snippet: string; highlight?: { start: number; length: number } } {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const window = text.slice(start, end);
  const body = window.trim();
  const snippet = `${prefix}${body}${suffix}`;
  const lead = window.length - window.trimStart().length;
  const from = Math.max(index - start - lead, 0);
  const to = Math.min(index + length - start - lead, body.length);
  if (to <= from) return { snippet };
  return { snippet, highlight: { start: prefix.length + from, length: to - from } };
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

/** One text Find would match against, with the hit it becomes if it matches (less the snippet). */
export interface FindCandidate {
  text: string;
  hit: Omit<FindHit, 'snippet'>;
}

/**
 * The texts Find matches against, in hit order: per note its title, summary
 * and page texts, then every searchable audio segment. The date, tag and
 * source filters are applied here, before any matching. Shared by
 * `findInCorpus` (in-thread) and the advanced search's regex path, which sends
 * the texts to the regex Worker and builds hits with `hitsFromMatches`.
 */
export function collectFindCandidates(
  corpus: SearchCorpus,
  options: FindOptions = {},
): FindCandidate[] {
  const sources = new Set(options.sources ?? ALL_SOURCES);
  const from = options.from ?? null;
  const to = options.to ?? null;
  const tags = options.tags ?? [];
  const tagMode = options.tagMode ?? 'or';
  const inRange = (at: number) => (from === null || at >= from) && (to === null || at <= to);

  const candidates: FindCandidate[] = [];
  // Fix round 3, I4: a map, not a `corpus.notes.find(...)` per segment.
  const noteById = new Map(corpus.notes.map((n) => [n.note.id, n.note]));
  const noteAllowed = (note: { startedAt: number } & Parameters<typeof tagsOf>[0]): boolean =>
    inRange(note.startedAt) && matchesTagFilter(tagsOf(note), tags, tagMode);

  for (const { note, pages } of corpus.notes) {
    if (!noteAllowed(note)) continue;
    if (sources.has('note-title')) {
      candidates.push({
        text: note.title,
        hit: { source: 'note-title', noteId: note.id, noteTitle: note.title },
      });
    }
    if (sources.has('note-summary') && note.summary !== null) {
      candidates.push({
        text: note.summary,
        hit: { source: 'note-summary', noteId: note.id, noteTitle: note.title },
      });
    }
    if (!sources.has('page-text')) continue;
    for (const page of pages) {
      candidates.push({
        text: page.text,
        hit: {
          source: 'page-text',
          noteId: note.id,
          noteTitle: note.title,
          pageIndex: page.pageIndex,
          isTyped: page.isTyped,
        },
      });
    }
  }

  if (!sources.has('audio-segment')) return candidates;
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
    for (const segment of recording.transcript?.segments ?? []) {
      candidates.push({
        text: segment.text,
        hit: {
          source: 'audio-segment',
          noteId,
          noteTitle: owner?.title ?? null,
          recordingId: recording.id,
          recordingTitle: recording.title,
          startMs: segment.startMs,
        },
      });
    }
  }
  return candidates;
}

/** The hits for `candidates`, given each one's first match (`null`: no match), in order. */
export function hitsFromMatches(
  candidates: readonly FindCandidate[],
  matches: readonly ({ index: number; length: number } | null)[],
): FindHit[] {
  const hits: FindHit[] = [];
  candidates.forEach((candidate, i) => {
    const m = matches[i];
    if (m === null || m === undefined) return;
    hits.push({ ...candidate.hit, ...snippetWithMatch(candidate.text, m.index, m.length) });
  });
  return hits;
}

/**
 * K40's Find mode: immediate, local match over the sources K41 names -
 * case-insensitive substring by default, or a guarded regex (see
 * `compileMatcher`). Pure and synchronous so a view can re-run this
 * on every keystroke against an already-loaded `SearchCorpus` without
 * re-reading storage. An invalid or unsafe pattern yields no hits. The
 * advanced search's regex mode does not call this: it runs the same
 * candidates through the regex Worker instead.
 */
export function findInCorpus(corpus: SearchCorpus, query: string, options: FindOptions = {}): FindHit[] {
  const regex = options.regex === true;
  const q = regex ? query : query.trim();
  if (regex ? q.length === 0 : q.length < MIN_QUERY_LENGTH) return [];
  const compiled = compileMatcher(q, { regex });
  if (!compiled.ok) return [];
  const { matcher } = compiled;
  const candidates = collectFindCandidates(corpus, options);
  return hitsFromMatches(candidates, candidates.map((c) => matcher.firstMatch(c.text)));
}
