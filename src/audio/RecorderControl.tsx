import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, Mic, Square } from 'lucide-react';

import { getAudioRuntime, startAudioRuntime } from '@/audio/audioRuntime';
import { formatClock } from '@/audio/format';
import type { Recorder } from '@/audio/recorder';
import { useCaptureState } from '@/capture/CaptureContext';
import { Button } from '@/components/ui/button';

/**
 * F2's header control: start/stop recording, with the elapsed time while it
 * runs. Reads `useCaptureState()` at record start to fill the recording's
 * `sessionId`/`noteId` (A10: both are null when there is no active note).
 *
 * `recorder` is normally omitted - AppShell mounts `<RecorderControl />` with
 * no props - and defaults to the app-wide singleton from `getAudioRuntime()`,
 * resolved once and memoized so it survives re-renders; a caller that does
 * pass one (tests) owns starting the audio runtime itself.
 */
export function RecorderControl({ recorder }: { recorder?: Recorder } = {}) {
  const [r] = useState<Recorder>(() => recorder ?? getAudioRuntime().recorder);

  useEffect(() => {
    if (!recorder) startAudioRuntime();
  }, [recorder]);

  const state = useSyncExternalStore(r.subscribe, r.getState);
  const capture = useCaptureState();

  const isBusy = state.status === 'recording' || state.status === 'stopping';

  return (
    <div className="flex items-center gap-2">
      {isBusy ? (
        <Button
          variant="destructive"
          size="sm"
          disabled={state.status === 'stopping'}
          onClick={() => void r.stop()}
        >
          <Square />
          Stop
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={state.status === 'starting'}
          onClick={() =>
            void r.start({ sessionId: capture.activeSessionId, noteId: capture.activeNoteId })
          }
        >
          <Mic />
          Record
        </Button>
      )}

      {isBusy && (
        <>
          <span aria-hidden className="size-2 rounded-full bg-destructive animate-pulse" />
          <span data-testid="recorder-elapsed" className="text-sm tabular-nums">
            {formatClock(state.elapsedMs)}
          </span>
          {state.link?.noteId && (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground"
              title="Linked to the active note"
            >
              <Link className="size-3" />
              Linked to note
            </span>
          )}
        </>
      )}

      {state.error && (
        <span role="alert" className="flex items-center gap-1 text-xs text-destructive">
          {state.error}
          <button
            type="button"
            aria-label="Dismiss"
            className="text-xs underline"
            onClick={() => r.clearError()}
          >
            Dismiss
          </button>
        </span>
      )}
    </div>
  );
}
