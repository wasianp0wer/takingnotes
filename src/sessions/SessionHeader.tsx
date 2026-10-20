import { NoteTitle } from '@/notes/NoteTitle';
import { ResumeButton } from '@/notes/ResumeButton';
import { TagEditor } from '@/notes/TagEditor';
import { useCaptureEngine } from '@/capture/CaptureContext';
import { tagsOf } from '@/storage/notes';
import type { SessionEntry } from '@/sessions/catalog';

export interface SessionHeaderProps {
  entry: SessionEntry | null;
  activeNoteId: string | null;
  sessionLocked: boolean;
  /** Non-null => K16: the viewed entry is not the one writing goes to. */
  writingDestinationTitle: string | null;
  onChanged(): void;
}

/** Title, tags and Resume for the selected entry, plus the K16 banner. */
export function SessionHeader({
  entry,
  activeNoteId,
  sessionLocked,
  writingDestinationTitle,
  onChanged,
}: SessionHeaderProps) {
  const engine = useCaptureEngine();
  if (!entry) return null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        {entry.kind === 'note' ? (
          <div className="flex flex-col text-session-title">
            <NoteTitle
              key={entry.note.id}
              noteId={entry.note.id}
              title={entry.note.title}
              onRenamed={onChanged}
            />
            <TagEditor noteId={entry.note.id} tags={tagsOf(entry.note)} onChanged={onChanged} />
          </div>
        ) : (
          <span className="text-sm font-medium text-session-title">{entry.recording.title}</span>
        )}
        {entry.kind === 'note' && (
          <ResumeButton
            note={entry.note}
            engine={engine}
            activeNoteId={activeNoteId}
            sessionLocked={sessionLocked}
          />
        )}
      </div>
      {writingDestinationTitle !== null && (
        <p role="status" className="px-4 py-1 text-xs text-muted-foreground">
          {`Writing still goes to "${writingDestinationTitle}"`}
        </p>
      )}
    </div>
  );
}
