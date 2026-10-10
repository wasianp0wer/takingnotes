import { listAllPageText } from '@/storage/pages';
import { listNotes } from '@/storage/notes';
import { listFinishedRecordings, recordingsForNote } from '@/storage/recordings';
import type { NoteRecord, RecordingRecord } from '@/storage/types';

/**
 * One page's searchable text (S6-spec "Design"). `isTyped` comes from
 * `PageTextProjection.text !== undefined` (K32): that field is present only
 * on a `source: 'typed'` page, which is otherwise indistinguishable from an
 * ink/ROM page in this projection since `setPageText` mirrors typed text
 * into `transcript` (K33) for exactly this reason - one field every reader
 * already knows about.
 */
export interface SearchPage {
  pageId: string;
  pageIndex: number;
  isTyped: boolean;
  /** `transcript.markdown`, trimmed; `''` when not (yet) transcribed. */
  text: string;
}

export interface SearchNote {
  note: NoteRecord;
  /** This note's pages, `pageIndex` order. */
  pages: SearchPage[];
}

export interface SearchCorpus {
  notes: SearchNote[];
  recordings: RecordingRecord[];
  /**
   * recordingId -> noteId, built from `recordingsForNote`
   * (docs/architecture.md §8.5) - the one place that knows both link paths
   * (direct `noteId`, or via the note's session). See S6-A1 for the cost of
   * building this map one note at a time.
   */
  recordingOwner: Map<string, string>;
}

/**
 * One bulk read of storage, shared by Find and smart search (S6-spec
 * "Design") so neither mode re-reads notes/pages/recordings on its own.
 * `listAllPageText()` is what makes this one bulk read instead of one
 * `listPages` call per note, each dragging a note's pen strokes into memory
 * to search a few kilobytes of text (architecture.md §8.5).
 */
export async function loadSearchCorpus(): Promise<SearchCorpus> {
  const [notes, pageRows, recordings] = await Promise.all([
    listNotes(),
    listAllPageText(),
    listFinishedRecordings(),
  ]);

  const pagesByNote = new Map<string, SearchPage[]>();
  for (const row of pageRows) {
    const list = pagesByNote.get(row.noteId) ?? [];
    list.push({
      pageId: row.id,
      pageIndex: row.pageIndex,
      isTyped: row.text !== undefined,
      text: (row.transcript?.markdown ?? '').trim(),
    });
    pagesByNote.set(row.noteId, list);
  }
  for (const list of pagesByNote.values()) list.sort((a, b) => a.pageIndex - b.pageIndex);

  // §8.5: `recordingsForNote` is the one place that knows both link paths
  // (direct `noteId`, or via the note's session) - called once per note
  // rather than re-derived by hand, per the brief.
  const recordingOwner = new Map<string, string>();
  for (const note of notes) {
    for (const recording of await recordingsForNote(note.id)) {
      recordingOwner.set(recording.id, note.id);
    }
  }

  const searchNotes: SearchNote[] = notes.map((note) => ({
    note,
    pages: pagesByNote.get(note.id) ?? [],
  }));

  return { notes: searchNotes, recordings, recordingOwner };
}
