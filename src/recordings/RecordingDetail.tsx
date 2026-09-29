import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Trash2 } from 'lucide-react';

import type { TranscriptionQueue } from '@/audio/transcriptionQueue';
import { formatClock } from '@/audio/format';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { deleteRecording, getRecordingAudio } from '@/storage/recordings';
import type { RecordingRecord } from '@/storage/types';

/**
 * The selected recording: an audio player, its transcription status (with
 * live progress while it is the queue's active job) and, once done, a
 * seekable list of transcript segments.
 */
export function RecordingDetail({
  recording,
  queue,
  onDelete,
}: {
  recording: RecordingRecord;
  queue: TranscriptionQueue;
  onDelete: (id: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioMissing, setAudioMissing] = useState(false);
  const queueState = useSyncExternalStore(queue.subscribe, queue.getState);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setAudioUrl(null);
    setAudioMissing(false);

    void getRecordingAudio(recording.id).then((blob) => {
      // The recording changed or the view unmounted before this resolved: no
      // URL was created here, so there is nothing of ours left to revoke.
      if (cancelled) return;
      if (!blob) {
        setAudioMissing(true);
        return;
      }
      createdUrl = URL.createObjectURL(blob);
      setAudioUrl(createdUrl);
    });

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
        createdUrl = null;
      }
    };
  }, [recording.id]);

  function seekTo(startMs: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = startMs / 1000;
    const playing = audio.play?.();
    if (playing && typeof playing.catch === 'function') {
      playing.catch(() => {});
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this recording?')) return;
    await deleteRecording(recording.id);
    onDelete(recording.id);
  }

  const transcript = recording.transcript;
  const isActive = queueState.activeId === recording.id;
  const isQueued = queueState.queuedIds.includes(recording.id);
  // A crash or reload can leave a row `pending`/`running` while the queue
  // itself has no memory of it (it is neither the active job nor waiting) -
  // the user must still have a way to kick it off again.
  const stuck =
    (transcript?.status === 'pending' || transcript?.status === 'running') &&
    !isActive &&
    !isQueued;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">{recording.title}</h2>
          <p className="text-xs text-muted-foreground">
            {new Date(recording.startedAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            · {formatClock(recording.durationMs)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete recording"
          onClick={() => void handleDelete()}
        >
          <Trash2 />
        </Button>
      </div>

      {audioMissing ? (
        <p className="text-sm text-muted-foreground">Audio is missing</p>
      ) : audioUrl ? (
        <audio ref={audioRef} controls src={audioUrl} className="w-full" />
      ) : null}

      {transcript === null && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Not transcribed</p>
          <Button size="sm" onClick={() => void queue.retry(recording.id)}>
            Transcribe
          </Button>
        </div>
      )}

      {transcript?.status === 'pending' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Queued for transcription</p>
          {stuck && (
            <Button size="sm" onClick={() => void queue.retry(recording.id)}>
              Retry
            </Button>
          )}
        </div>
      )}

      {transcript?.status === 'running' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Transcribing…</p>
          {isActive && queueState.stage === 'loading' && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Downloading model {Math.round((queueState.progress ?? 0) * 100)}%
              </p>
              <Progress value={Math.round((queueState.progress ?? 0) * 100)} />
            </div>
          )}
          {isActive && queueState.stage === 'transcribing' && (
            <p className="text-xs text-muted-foreground">Transcribing…</p>
          )}
          {stuck && (
            <Button size="sm" onClick={() => void queue.retry(recording.id)}>
              Retry
            </Button>
          )}
        </div>
      )}

      {transcript?.status === 'failed' && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {transcript.error}
          </p>
          <Button size="sm" onClick={() => void queue.retry(recording.id)}>
            Retry
          </Button>
        </div>
      )}

      {transcript?.status === 'done' && (
        <div className="space-y-2">
          {transcript.segments.length === 0 && !transcript.text ? (
            <p className="text-sm text-muted-foreground">No speech detected</p>
          ) : transcript.segments.length > 0 ? (
            <ul className="space-y-1">
              {transcript.segments.map((segment, index) => (
                <li key={index} className="flex items-start gap-2 text-sm">
                  <button
                    type="button"
                    data-start-ms={segment.startMs}
                    onClick={() => seekTo(segment.startMs)}
                    className="shrink-0 tabular-nums text-primary underline-offset-4 hover:underline"
                  >
                    {formatClock(segment.startMs)}
                  </button>
                  <span>{segment.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">{transcript.text}</p>
          )}
          <p className="text-xs text-muted-foreground">{transcript.model}</p>
        </div>
      )}
    </div>
  );
}
