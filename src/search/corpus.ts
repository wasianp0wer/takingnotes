import { listAllPageText } from '@/storage/pages';
import { listNotes } from '@/storage/notes';
import { listFinishedRecordings, recordingOwnersByNote } from '@/storage/recordings';
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
  /**
   * Fix round 3, C1: this note's owned recordings' transcript text
   * (`AudioTranscriptRecord.text` of each `status: 'done'` recording
   * `recordingOwner` attributes to this note), joined oldest-first. `''`
   * when the note owns no done-transcribed recording. K41 lists audio
   * transcripts as one of smart search's five sources same as Find's; this
   * is what lets `smartSearch.ts` read it without re-deriving the
   * recording -> note attribution a second time.
   */
  audioText: string;
  /**
   * The recording `audioText` came from (the earliest-started done-
   * transcribed owned recording), or `null` when there is none. The
   * honest target for a smart-search hit whose note has no page text to
   * point at instead (fix round 3, C1's band-granularity ruling) - this is
   * literally the recording whose words produced the hit.
   */
  primaryRecordingId: string | null;
}

export interface SearchCorpus {
  notes: SearchNote[];
  recordings: RecordingRecord[];
  /**
   * recordingId -> noteId, built from `recordingOwnersByNote`
   * (docs/architecture.md §8.5, extended fix round 3 I5) - the one place
   * that knows both link paths (direct `noteId`, or via the note's
   * session), done in one pass over already-loaded notes and finished
   * recordings rather than one `recordingsForNote` call per note (S6-A1,
   * superseded).
   */
  recordingOwner: Map<string, string>;
  /**
   * How many finished recordings in this corpus are not fully transcribed -
   * absent, `running` or `paused`. Surfaced so `SearchView` can say results
   * may be incomplete, in **both** modes: since a `running` transcript now
   * carries real segments, Find returns partial hits whether or not anything
   * asked it to.
   */
  partialTranscriptCount: number;
}

/**
 * Whether a recording's transcript text is real content rather than a
 * leftover from a different run.
 *
 * `running` and `paused` count: since transcription became chunked, those
 * rows carry every window finished so far, and the owner would rather search
 * the first forty minutes of a lecture than nothing at all. What they do not
 * carry is completeness, which is why `partialTranscriptCount` exists.
 *
 * `failed` is still excluded: its text is whatever a previous attempt left
 * behind, and nothing is coming to finish it without the owner asking.
 */
function hasSearchableTranscript(recording: RecordingRecord): boolean {
  const status = recording.transcript?.status;
  return status === 'done' || status === 'running' || status === 'paused';
}

/** Not fully transcribed: nothing yet, or stopped partway. */
function isPartiallyTranscribed(recording: RecordingRecord): boolean {
  const status = recording.transcript?.status;
  return status === undefined || status === 'running' || status === 'paused';
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

  // §8.5, extended fix round 3 I5: one pass over data already in hand,
  // rather than one `recordingsForNote` call (and its own full
  // `listFinishedRecordings()` scan) per note.
  const recordingOwner = recordingOwnersByNote(notes, recordings);

  // Fix round 3, C1: group each note's own searchable recordings,
  // oldest first, so `audioText` reads like the lecture unfolded and
  // `primaryRecordingId` names the earliest (likely the main sitting).
  const recordingsByNote = new Map<string, RecordingRecord[]>();
  for (const recording of recordings) {
    if (!hasSearchableTranscript(recording)) continue;
    const ownerId = recordingOwner.get(recording.id);
    if (ownerId === undefined) continue;
    const list = recordingsByNote.get(ownerId) ?? [];
    list.push(recording);
    recordingsByNote.set(ownerId, list);
  }
  for (const list of recordingsByNote.values()) list.sort((a, b) => a.startedAt - b.startedAt);

  const searchNotes: SearchNote[] = notes.map((note) => {
    const owned = recordingsByNote.get(note.id) ?? [];
    // Only recordings that actually have something to say - a transcript
    // with blank text (silence, a Whisper run that heard nothing, or a job
    // that has not finished its first window yet) contributes to neither the
    // joined text nor the "primary" choice, so `primaryRecordingId` always
    // names a recording whose words are genuinely part of `audioText`.
    const contributing = owned
      .map((r) => ({ recording: r, text: (r.transcript?.text ?? '').trim() }))
      .filter((entry) => entry.text.length > 0);
    return {
      note,
      pages: pagesByNote.get(note.id) ?? [],
      audioText: contributing.map((entry) => entry.text).join('\n\n'),
      primaryRecordingId: contributing[0]?.recording.id ?? null,
    };
  });

  return {
    notes: searchNotes,
    recordings,
    recordingOwner,
    partialTranscriptCount: recordings.filter(isPartiallyTranscribed).length,
  };
}
