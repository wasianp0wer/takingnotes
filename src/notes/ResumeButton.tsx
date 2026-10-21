import { useState, useSyncExternalStore } from 'react';

import type { CaptureEngine } from '@/capture/types';
import { Button } from '@/components/ui/button';
import { getResumeLock } from '@/notes/resumeLock';
import type { NoteRecord } from '@/storage/types';

export interface ResumeButtonProps {
  note: NoteRecord;
  engine: Pick<CaptureEngine, 'resumeNote'>;
  /** The engine's current active note, or `null` when no note is open. */
  activeNoteId: string | null;
  /** K15: a session locks you into its note, so Resume on any other note is disabled too. */
  sessionLocked: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * K14: the one place Resume is offered - mounted once in
 * `SessionHeader` and once in `SessionControls`'s interrupted banner.
 * Renders nothing for the active note or a legacy note (K14's "any
 * non-legacy note that is not the active note"). Disabled while a session is
 * locked onto a different note (K15), and disabled everywhere - not just the
 * instance clicked - for as long as any `resumeNote()` call is pending
 * (`resumeLock.ts`, closing the `architecture.md` §8.3 hazard window), the
 * same way `PageTurnControls` gates "New page" with its own `inFlight` ref,
 * except this guard is shared rather than local to one component.
 */
export function ResumeButton({ note, engine, activeNoteId, sessionLocked }: ResumeButtonProps) {
  const lock = getResumeLock();
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  const [error, setError] = useState<string | null>(null);

  if (note.legacy || note.id === activeNoteId) return null;

  async function resume() {
    setError(null);
    try {
      await lock.run(() => engine.resumeNote(note.id));
    } catch (err) {
      setError(messageOf(err));
    }
  }

  const disabled = sessionLocked || lockState.pending;

  return (
    <span className="mt-1 flex items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        title={sessionLocked ? 'End the current session before resuming another note' : undefined}
        onClick={() => void resume()}
      >
        Resume
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
