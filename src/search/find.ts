import type { SearchCorpus } from '@/search/corpus';

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

/**
 * K40's Find mode: immediate, local, case-insensitive substring match over
 * the five sources K41 names. Pure and synchronous so a `SearchView` can
 * re-run this on every keystroke against an already-loaded `SearchCorpus`
 * without re-reading storage.
 */
export function findInCorpus(corpus: SearchCorpus, query: string): FindHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const hits: FindHit[] = [];

  for (const { note, pages } of corpus.notes) {
    if (note.title.toLowerCase().includes(q)) {
      hits.push({
        source: 'note-title',
        noteId: note.id,
        noteTitle: note.title,
        snippet: snippetAround(note.title, q),
      });
    }
    if (note.summary !== null && note.summary.toLowerCase().includes(q)) {
      hits.push({
        source: 'note-summary',
        noteId: note.id,
        noteTitle: note.title,
        snippet: snippetAround(note.summary, q),
      });
    }
    for (const page of pages) {
      if (page.text.toLowerCase().includes(q)) {
        hits.push({
          source: 'page-text',
          noteId: note.id,
          noteTitle: note.title,
          pageIndex: page.pageIndex,
          isTyped: page.isTyped,
          snippet: snippetAround(page.text, q),
        });
      }
    }
  }

  for (const recording of corpus.recordings) {
    const segments = recording.transcript?.segments ?? [];
    for (const segment of segments) {
      if (segment.text.toLowerCase().includes(q)) {
        const noteId = corpus.recordingOwner.get(recording.id) ?? null;
        const noteTitle =
          noteId !== null ? corpus.notes.find((n) => n.note.id === noteId)?.note.title ?? null : null;
        hits.push({
          source: 'audio-segment',
          noteId,
          noteTitle,
          recordingId: recording.id,
          recordingTitle: recording.title,
          startMs: segment.startMs,
          snippet: snippetAround(segment.text, q),
        });
      }
    }
  }

  return hits;
}
