import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, MicOff, Play, Square } from 'lucide-react';

import { getAudioRuntime, startAudioRuntime } from '@/audio/audioRuntime';
import { formatClock } from '@/audio/format';
import type { Recorder } from '@/audio/recorder';
import { useCaptureEngine } from '@/capture/CaptureContext';
import { sessionStartedAtOf } from '@/capture/engine';
import type { CaptureEngine } from '@/capture/types';
import { Button } from '@/components/ui/button';
import type { DeviceController } from '@/device/controller';
import { useHuionDevice } from '@/device/TabletProvider';
import { listNotes } from '@/storage/notes';
import type { NoteRecord } from '@/storage/types';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One session/device/audio error line, dismissible on its own so one failure never hides another. */
function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <span role="alert" className="flex items-center gap-1 text-xs text-destructive">
      {message}
      <button type="button" className="underline" onClick={onDismiss}>
        Dismiss
      </button>
    </span>
  );
}

/**
 * The note whose session was interrupted by a reload or crash, or null. Only the
 * newest note counts: once a later session has run, the old notice is stale.
 *
 * `active` counts as interrupted when it is not the note being written now -
 * the engine's startup recovery may not have flipped it to `interrupted` yet,
 * and it means the same thing to the person reading the header (P3-A4). One
 * session is one note (J4), so an interrupted note is an interrupted session.
 */
export function interruptedNoteOf(
  notes: NoteRecord[],
  activeNoteId: string | null,
): NoteRecord | null {
  const newest = notes.find((note) => !note.legacy);
  if (!newest || newest.id === activeNoteId) return null;
  if (newest.status === 'interrupted' || newest.status === 'active') return newest;
  return null;
}

export interface SessionPanelProps {
  engine: CaptureEngine;
  controller: DeviceController;
  recorder: Recorder;
  /** Clock for the elapsed time. Defaults to `Date.now`. */
  now?: () => number;
}

type Phase = 'idle' | 'starting' | 'ending';

/**
 * P3 (docs/features/p3-spec.md): start a session - one Session, one Note in it,
 * one recording - show its elapsed time, whether audio is recording and the
 * device link, and end all of it together (spec J4).
 *
 * Everything is injected so the panel can be tested against the real engine, a
 * fake device controller and a fake recorder without a provider;
 * `SessionControls` below is the wrapper `AppShell` mounts.
 *
 * Order matters twice. The engine never touches the recorder (architecture
 * §6.5), so the session is started first and the recorder second, and an audio
 * failure is *reported*, never unwound (A28: writing is never blocked). The pad
 * is ensured before the microphone because `requestDevice()` needs the user
 * activation that awaiting `getUserMedia()`'s prompt would consume (P3-A2).
 */
export function SessionPanel({ engine, controller, recorder, now = Date.now }: SessionPanelProps) {
  const capture = useSyncExternalStore(engine.subscribe, engine.getState);
  const device = useSyncExternalStore(controller.subscribeState, controller.getState);
  const audio = useSyncExternalStore(recorder.subscribe, recorder.getState);

  const [phase, setPhase] = useState<Phase>('idle');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [interrupted, setInterrupted] = useState<NoteRecord | null>(null);
  const [dismissedNoteId, setDismissedNoteId] = useState<string | null>(null);

  const startedAt = sessionStartedAtOf(capture);
  const isActive = startedAt !== null;
  const recording = audio.status === 'recording' || audio.status === 'stopping';

  // Alive only while mounted: a start that resolves after an unmount must not
  // set state (React logs a warning) - and must not throw either.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // One tick a second while a session runs, so the clock moves without the
  // engine having to publish anything.
  useEffect(() => {
    if (!isActive) return;
    const handle = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(handle);
  }, [isActive]);

  // Re-read when the active note changes: that covers the first render (where
  // the engine's startup recovery may still be in flight), a note the pen
  // auto-starts, and a session that just ended.
  useEffect(() => {
    let alive = true;
    void listNotes()
      .then((notes) => {
        if (alive) setInterrupted(interruptedNoteOf(notes, capture.activeNoteId));
      })
      .catch((error: unknown) => {
        console.error('[session] reading the notes list failed', error);
      });
    return () => {
      alive = false;
    };
  }, [capture.activeNoteId]);

  const start = useCallback(async () => {
    setPhase('starting');
    setSessionError(null);
    setDeviceError(null);
    setAudioError(null);

    let ids: { sessionId: string; noteId: string };
    try {
      ids = await engine.startSession();
    } catch (error) {
      console.error('[session] starting the session failed', error);
      if (mounted.current) {
        setSessionError(messageOf(error));
        setPhase('idle');
      }
      return;
    }

    // The pad: connect and stream, which is all F4's page-turn capture needs -
    // `attachPageTurnCapture` (mounted once by AppShell) starts the controller's
    // capture itself as soon as both are true.
    try {
      const state = controller.getState();
      if (!state.isConnected) {
        await controller.connect();
        await controller.startStreaming();
      } else if (!state.isStreaming) {
        await controller.startStreaming();
      }
    } catch (error) {
      console.error('[session] the pad could not be started', error);
      if (mounted.current) setDeviceError(messageOf(error));
    }

    // Audio last, and never fatal: the session is already capturing.
    try {
      await recorder.start(ids);
      const after = recorder.getState();
      if (after.status !== 'recording') {
        if (mounted.current) setAudioError(after.error ?? 'Recording did not start');
      } else if (after.link?.sessionId !== ids.sessionId || after.link?.noteId !== ids.noteId) {
        // The recorder singleton is shared with the header's Record button
        // (P3-A3). If it was already recording, `recorder.start()` above was
        // a silent no-op (recorder.ts line 204) and the recording keeps the
        // link it captured earlier, not this session's - so this session's
        // pages have no audio of their own, and P1's gap-filling would find
        // none. Reported plainly (A28), never unwound: the session keeps
        // running and keeps capturing handwriting.
        if (mounted.current) {
          setAudioError(
            'The microphone was already recording for an earlier session, so this session has no audio of its own.',
          );
        }
      }
    } catch (error) {
      console.error('[session] recording could not start', error);
      if (mounted.current) setAudioError(messageOf(error));
    }

    if (mounted.current) setPhase('idle');
  }, [controller, engine, recorder]);

  const end = useCallback(async () => {
    setPhase('ending');
    try {
      await engine.endSession();
    } catch (error) {
      console.error('[session] ending the session failed', error);
      if (mounted.current) setSessionError(messageOf(error));
    } finally {
      // Always: the audio is in memory (A11) and only `stop()` saves it and
      // queues its transcription.
      try {
        await recorder.stop();
      } catch (error) {
        console.error('[session] stopping the recording failed', error);
        if (mounted.current) setAudioError(messageOf(error));
      }
      if (mounted.current) setPhase('idle');
    }
  }, [engine, recorder]);

  const link = device.isReconnecting
    ? 'Reconnecting...'
    : device.isConnected
      ? device.isStreaming
        ? `Pad connected${device.deviceName ? ` · ${device.deviceName}` : ''}`
        : 'Pad connected, not streaming'
      : 'Pad not connected';

  return (
    <div aria-label="Session" className="flex flex-wrap items-center gap-2">
      {isActive ? (
        <Button variant="destructive" size="sm" disabled={phase !== 'idle'} onClick={() => void end()}>
          <Square />
          {phase === 'ending' ? 'Ending...' : 'End session'}
        </Button>
      ) : (
        <Button variant="default" size="sm" disabled={phase !== 'idle'} onClick={() => void start()}>
          <Play />
          {phase === 'starting' ? 'Starting...' : 'Start session'}
        </Button>
      )}

      {isActive && (
        <>
          <span data-testid="session-elapsed" className="text-sm tabular-nums">
            {formatClock(now() - startedAt)}
          </span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {recording ? <Mic className="size-3" /> : <MicOff className="size-3" />}
            {recording ? 'Recording' : 'No audio'}
          </span>
          <span className="text-xs text-muted-foreground">{link}</span>
        </>
      )}

      {sessionError && <ErrorBanner message={sessionError} onDismiss={() => setSessionError(null)} />}
      {deviceError && <ErrorBanner message={deviceError} onDismiss={() => setDeviceError(null)} />}
      {audioError && <ErrorBanner message={audioError} onDismiss={() => setAudioError(null)} />}

      {interrupted && interrupted.id !== dismissedNoteId && (
        <span role="status" className="flex items-center gap-1 text-xs text-amber-600">
          {`"${interrupted.title}" was interrupted; its audio recording was lost.`}
          <button
            type="button"
            className="underline"
            onClick={() => setDismissedNoteId(interrupted.id)}
          >
            Dismiss
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * AppShell's mount point (docs/architecture.md §6.7): no props, reads the
 * engine, the device controller and the app-wide recorder singleton - the same
 * instance `RecorderControl` drives (P3-A3), so a session's recording and the
 * header's Record button can never be two different recordings.
 */
export function SessionControls() {
  const engine = useCaptureEngine();
  const { controller } = useHuionDevice();
  const [recorder] = useState<Recorder>(() => getAudioRuntime().recorder);

  useEffect(() => {
    startAudioRuntime();
  }, []);

  return <SessionPanel engine={engine} controller={controller} recorder={recorder} />;
}
