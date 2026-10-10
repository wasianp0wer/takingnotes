import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { getAudioRuntime } from '@/audio/audioRuntime';
import { formatClock } from '@/audio/format';
import type { TranscriptionQueue } from '@/audio/transcriptionQueue';
import { RecordingDetail } from '@/recordings/RecordingDetail';
import { listFinishedRecordings } from '@/storage/recordings';
import type { RecordingRecord } from '@/storage/types';

function statusWord(recording: RecordingRecord): string {
  const transcript = recording.transcript;
  if (transcript === null) return 'Not transcribed';
  switch (transcript.status) {
    case 'pending':
      return 'Queued';
    case 'running':
      return 'Transcribing';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    default:
      return 'Not transcribed';
  }
}

/**
 * Fix round 1, Finding 1: an external caller (Search, via `AppShell`)
 * asking this view to select a specific recording. `token` is bumped on
 * every request, including a repeat of the exact recording already
 * selected - without it, a second identical request would silently do
 * nothing (the view has already "seen" that id).
 */
export interface RecordingsExternalSelection {
  token: number;
  recordingId: string;
  /** The segment to look for, when the request names one (K41). */
  startMs?: number;
}

export interface RecordingsViewProps {
  /** Tests only - a real mount defaults to the app-wide singleton. */
  queue?: TranscriptionQueue;
  /** See `RecordingsExternalSelection`. */
  external?: RecordingsExternalSelection;
  /** Called once the request above has been applied, so the caller (`AppShell`) can clear its own pending state. */
  onExternalSelectionApplied?: () => void;
}

/**
 * F2's Recordings tab: the list of captured recordings on the left, the
 * selected one's player and transcript on the right.
 *
 * `queue` is normally omitted - `AppShell` mounts `<RecordingsView />` with no
 * props - and defaults to the app-wide singleton from `getAudioRuntime()`,
 * resolved once so it survives re-renders; a caller that passes one (tests)
 * owns starting the audio runtime itself.
 */
export function RecordingsView(props?: RecordingsViewProps) {
  const [queue] = useState<TranscriptionQueue>(() => props?.queue ?? getAudioRuntime().queue);
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The segment a Search hit named, shown as a hint beside the player since
  // this view cannot seek `RecordingDetail`'s audio element itself (it owns
  // its own ref; seeking it is `RecordingDetail`'s file to add, outside
  // this fix's ownership - see docs/features/s6-report.md). Cleared when
  // the user picks a different recording by hand.
  const [segmentHintMs, setSegmentHintMs] = useState<number | null>(null);
  // Bumped at the start of every `load()` call; a resolution is only applied
  // if it is still the most recently *started* one. `subscribeChanges` fires
  // once per persisted status write (pending -> running -> done in quick
  // succession), so two reads can be in flight as separate IndexedDB
  // transactions - without this, an older snapshot resolving after a newer
  // one would silently win and strand the UI on stale status text. Bumping
  // it again on unmount (in the effect's cleanup) also makes this subsume a
  // plain "still mounted" guard, so there is no separate mounted ref.
  const seqRef = useRef(0);
  // The external token already applied, so a request is honoured at most
  // once (same reasoning as `NotesView`'s `appliedExternalToken`). A ref,
  // not state: it is read and written only from inside `load()` (an effect
  // callback, never render), and doesn't itself need to trigger a re-render
  // - `setSelectedId`/`setSegmentHintMs` already do.
  const appliedExternalTokenRef = useRef<number | null>(null);
  const external = props?.external;
  const onExternalSelectionApplied = props?.onExternalSelectionApplied;

  // Subscribes the view to the queue's live state (active/queued ids,
  // progress) so it re-renders in step with `RecordingDetail`, not only when
  // a persisted write fires `subscribeChanges`.
  useSyncExternalStore(queue.subscribe, queue.getState);

  // Depends on `external`/`onExternalSelectionApplied` (not `[]`) so a new
  // request arriving while this view is already mounted still re-runs the
  // effect below and applies it immediately, not only on the next
  // unrelated reload. Harmless to recreate on every *unrelated* parent
  // render too, as long as those props keep a stable identity when nothing
  // has actually changed - `AppShell`'s `navigationTarget`-derived props do
  // (a `useState` value and a `useCallback`), so this does not resubscribe
  // on every render, only on an actual new request.
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    // listFinishedRecordings(), not listRecordings(): since K5 a
    // RecordingRecord exists from the moment recording starts, with a
    // zero-byte recordingAudio row. Listing that here would show a player
    // with nothing to play and a "Not transcribed" label that looks stuck.
    const list = await listFinishedRecordings();
    if (seq !== seqRef.current) return;
    setRecordings(list);

    if (
      external !== undefined &&
      external.token !== appliedExternalTokenRef.current &&
      list.some((r) => r.id === external.recordingId)
    ) {
      appliedExternalTokenRef.current = external.token;
      setSelectedId(external.recordingId);
      setSegmentHintMs(external.startMs ?? null);
      onExternalSelectionApplied?.();
      return;
    }

    setSelectedId((current) =>
      current && list.some((r) => r.id === current) ? current : (list[0]?.id ?? null),
    );
  }, [external, onExternalSelectionApplied]);

  useEffect(() => {
    void load();
    const unsubscribe = queue.subscribeChanges(() => {
      void load();
    });
    return () => {
      // Invalidates any load still in flight from this mount so it cannot
      // apply a stale snapshot after unmount.
      seqRef.current += 1;
      unsubscribe();
    };
  }, [queue, load]);

  function handleDelete() {
    void load();
  }

  if (recordings.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          No recordings yet. Use Record in the header to capture audio.
        </p>
      </div>
    );
  }

  const selected = recordings.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="w-full shrink-0 overflow-auto border-b border-border md:w-72 md:border-b-0 md:border-r">
        <ul>
          {recordings.map((recording) => (
            <li key={recording.id}>
              <button
                type="button"
                data-recording-id={recording.id}
                onClick={() => {
                  setSelectedId(recording.id);
                  setSegmentHintMs(null);
                }}
                aria-current={recording.id === selectedId}
                className="flex w-full flex-col gap-0.5 border-b border-border px-4 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent"
              >
                <span className="font-medium">{recording.title}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(recording.startedAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}{' '}
                  · {formatClock(recording.durationMs)}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {recording.noteId && <span>Linked to note</span>}
                  <span>{statusWord(recording)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {selected && segmentHintMs !== null && (
          <p className="mb-2 text-xs text-muted-foreground">
            Jumped here from search — look for the segment at {formatClock(segmentHintMs)}.
          </p>
        )}
        {selected && (
          <RecordingDetail
            key={selected.id}
            recording={selected}
            queue={queue}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  );
}
