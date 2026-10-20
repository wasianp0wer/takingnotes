import { recordingOwnersByNote } from "@/storage/recordings";
import type { NoteRecord, RecordingRecord } from "@/storage/types";

export type EntryKey = `note:${string}` | `recording:${string}`;

export type SessionEntry =
  | {
      kind: "note";
      key: `note:${string}`;
      note: NoteRecord;
      /** Recordings owned by this note, `startedAt` ascending. */
      recordings: RecordingRecord[];
    }
  | {
      kind: "recording";
      key: `recording:${string}`;
      recording: RecordingRecord;
    };

export interface SessionCatalog {
  /** Notes that belong to a session, newest first. */
  sessions: SessionEntry[];
  /** Notes with no session plus recordings with no owning note, newest first. */
  uncategorized: SessionEntry[];
}

export function noteKey(noteId: string): `note:${string}` {
  return `note:${noteId}`;
}

export function recordingKey(recordingId: string): `recording:${string}` {
  return `recording:${recordingId}`;
}

export function entryStartedAt(entry: SessionEntry): number {
  return entry.kind === "note"
    ? entry.note.startedAt
    : entry.recording.startedAt;
}

export function entryTitle(entry: SessionEntry): string {
  return entry.kind === "note" ? entry.note.title : entry.recording.title;
}

/**
 * Groups notes and finished recordings into the sidebar's two lists. Ownership
 * comes from `recordingOwnersByNote`, the single place that knows both link
 * paths (direct `noteId`, or via the note's session).
 */
export function buildSessionCatalog(
  notes: readonly NoteRecord[],
  finished: readonly RecordingRecord[],
): SessionCatalog {
  const owners = recordingOwnersByNote(notes, finished);
  const byNote = new Map<string, RecordingRecord[]>();
  const orphans: RecordingRecord[] = [];
  const noteIds = new Set(notes.map((n) => n.id));

  for (const recording of finished) {
    const noteId = owners.get(recording.id);
    if (noteId === undefined || !noteIds.has(noteId)) {
      orphans.push(recording);
      continue;
    }
    const list = byNote.get(noteId);
    if (list) list.push(recording);
    else byNote.set(noteId, [recording]);
  }

  const sessions: SessionEntry[] = [];
  const uncategorized: SessionEntry[] = [];
  for (const note of notes) {
    const recordings = (byNote.get(note.id) ?? []).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    const entry: SessionEntry = {
      kind: "note",
      key: noteKey(note.id),
      note,
      recordings,
    };
    if (typeof note.sessionId === "string") sessions.push(entry);
    else uncategorized.push(entry);
  }
  for (const recording of orphans) {
    uncategorized.push({
      kind: "recording",
      key: recordingKey(recording.id),
      recording,
    });
  }

  const newestFirst = (a: SessionEntry, b: SessionEntry) =>
    entryStartedAt(b) - entryStartedAt(a);
  sessions.sort(newestFirst);
  uncategorized.sort(newestFirst);
  return { sessions, uncategorized };
}

export function findEntry(
  catalog: SessionCatalog,
  key: string | null,
): SessionEntry | null {
  if (key === null) return null;
  return (
    catalog.sessions.find((e) => e.key === key) ??
    catalog.uncategorized.find((e) => e.key === key) ??
    null
  );
}
