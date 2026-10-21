import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Trash2 } from 'lucide-react';

import type { TranscriptionQueue } from '@/audio/transcriptionQueue';
import { formatClock } from '@/audio/format';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { deleteRecording, getRecordingAudio, updateRecording } from '@/storage/recordings';
import type { RecordingRecord, TranscriptSegment } from '@/storage/types';

/**
 * The extension for a recorded blob's MIME type. `MediaRecorder` types carry a
 * codecs parameter (`audio/webm;codecs=opus`), and a stitched recording whose
 * chunks all arrived without a type at all has none to read, so webm - what
 * this app records - is the fallback rather than a guess at nothing.
 */
function extensionFor(type: string): string {
  const subtype = type.split(';')[0]?.split('/')[1];
  return subtype && /^[a-z0-9]+$/i.test(subtype) ? subtype : 'webm';
}

/** A filename that survives every filesystem: no separators, no runs of spaces. */
function downloadName(title: string, startedAt: number, type: string): string {
  const safe = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim() || 'Recording';
  const date = new Date(startedAt).toISOString().slice(0, 10);
  return `${safe} ${date}.${extensionFor(type)}`;
}

/**
 * A transcript as a list of timestamped lines, each seeking the player.
 *
 * Shared by every state that has segments to show - `done`, `running` and
 * `paused` - so a transcription does not change how it reads depending on
 * whether it has finished.
 */
function TranscriptSegments({
  segments,
  onSeek,
}: {
  segments: readonly TranscriptSegment[];
  onSeek: (startMs: number) => void;
}) {
  return (
    <ul className="space-y-1">
      {segments.map((segment, index) => (
        <li key={index} className="flex items-start gap-2 text-sm">
          <button
            type="button"
            data-start-ms={segment.startMs}
            onClick={() => onSeek(segment.startMs)}
            className="shrink-0 tabular-nums text-timestamp underline-offset-4 hover:underline"
          >
            {formatClock(segment.startMs)}
          </button>
          <span className="font-transcript">{segment.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The selected recording: an audio player, its transcription status (with
 * live progress while it is the queue's active job) and, once done, a
 * seekable list of transcript segments.
 */
export function RecordingDetail({
  recording,
  queue,
  onDelete,
  seek,
  onSeekApplied,
  onRenamed,
}: {
  recording: RecordingRecord;
  queue: TranscriptionQueue;
  onDelete: (id: string) => void;
  /** Applied once per `token`, after the audio URL is ready. */
  seek?: { token: number; startMs: number };
  onSeekApplied?: (token: number) => void;
  onRenamed?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // Held as well as the player's URL: the download builds its own URL from these
  // bytes, with its own type. A Blob out of storage is a handle to the browser's
  // blob store, not a copy of the audio in JS memory.
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioMissing, setAudioMissing] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const queueState = useSyncExternalStore(queue.subscribe, queue.getState);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const appliedSeekToken = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    void getRecordingAudio(recording.id).then((blob) => {
      // The recording changed or the view unmounted before this resolved: no
      // URL was created here, so there is nothing of ours left to revoke.
      if (cancelled) return;
      if (!blob) {
        setAudioMissing(true);
        return;
      }
      createdUrl = URL.createObjectURL(blob);
      setAudioBlob(blob);
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

  const seekToken = seek?.token;
  const seekStartMs = seek?.startMs;
  useEffect(() => {
    // Waits for the player: the element only exists once the audio URL does.
    if (seekToken === undefined || seekStartMs === undefined || !audioUrl) return;
    if (appliedSeekToken.current === seekToken) return;
    appliedSeekToken.current = seekToken;
    seekTo(seekStartMs);
    onSeekApplied?.(seekToken);
    // `seekTo` and `onSeekApplied` are deliberately not dependencies: a new
    // identity for either must not replay a request already applied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToken, seekStartMs, audioUrl]);

  function startRename() {
    setDraftTitle(recording.title);
    setRenameError(null);
    setRenaming(true);
  }

  function cancelRename() {
    setRenaming(false);
    setRenameError(null);
  }

  async function commitRename() {
    const title = draftTitle.trim();
    if (!title) {
      setRenameError('A title cannot be blank');
      return;
    }
    if (title === recording.title) {
      cancelRename();
      return;
    }
    try {
      await updateRecording(recording.id, { title });
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
      return;
    }
    cancelRename();
    onRenamed?.();
  }

  /**
   * Saves the whole recording as a file.
   *
   * ⚑ Not an `<a href={audioUrl} download>`, which is what this was first: a
   * blob URL that advertises `audio/webm` is media the browser would rather play
   * than save, and Safari ignores `download` on a blob URL altogether and
   * navigates to it - so the recording opened as a stream in a new window
   * instead of being saved. Re-typing the bytes as a generic binary payload is
   * what makes it a download everywhere.
   *
   * `slice` with a content type re-labels the same bytes without copying them,
   * which matters at lecture length; the player's own URL is left alone, since
   * it still needs to be audio.
   */
  function downloadAudio() {
    if (!audioBlob) return;
    const url = URL.createObjectURL(audioBlob.slice(0, audioBlob.size, 'application/octet-stream'));
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadName(recording.title, recording.startedAt, audioBlob.type);
    link.rel = 'noopener';
    // Appended rather than clicked detached: Firefox and Safari ignore a click
    // on an anchor that is not in the document.
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Released on the next tick, not here: revoking inside the same task can
    // cancel the save the click just started.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function handleDelete() {
    if (!window.confirm('Delete this recording?')) return;
    setDeleteError(null);
    try {
      await deleteRecording(recording.id);
    } catch (error) {
      // The row is still there, so say so rather than leaving the click looking
      // like it did nothing (and the rejection unhandled).
      setDeleteError(error instanceof Error ? error.message : String(error));
      return;
    }
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
  /**
   * How far the transcription has got, as a real proportion. From the live
   * queue while this is the active job, and from the persisted cursor
   * otherwise - which is what lets a paused or reloaded job still say where
   * it stopped.
   */
  const completedMs = (isActive ? queueState.completedMs : null) ?? transcript?.completedMs ?? 0;
  const totalMs = (isActive ? queueState.durationMs : null) ?? recording.durationMs;
  const percent = totalMs > 0 ? Math.min(100, Math.round((completedMs / totalMs) * 100)) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          {renaming ? (
            <input
              autoFocus
              aria-label="Recording title"
              value={draftTitle}
              onChange={(event) => {
                setDraftTitle(event.target.value);
                setRenameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename();
                else if (event.key === 'Escape') cancelRename();
              }}
              className="w-full bg-transparent text-sm font-medium"
            />
          ) : (
            <h2 className="text-sm font-medium">
              <button
                type="button"
                title="Rename recording"
                onClick={startRename}
                className="text-left text-session-title"
              >
                {recording.title}
              </button>
            </h2>
          )}
          {renameError && (
            <p role="alert" className="text-xs text-destructive">
              {renameError}
            </p>
          )}
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

      {deleteError && (
        <p role="alert" className="text-sm text-destructive">
          Could not delete this recording: {deleteError}
        </p>
      )}

      {audioMissing ? (
        <p className="text-sm text-muted-foreground">Audio is missing</p>
      ) : audioUrl ? (
        <div className="space-y-2">
          <audio ref={audioRef} controls src={audioUrl} className="w-full" />
          <Button variant="outline" size="sm" onClick={downloadAudio}>
            Download audio
          </Button>
        </div>
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
          {(isActive || isQueued) && (
            <Button variant="outline" size="sm" onClick={() => void queue.pause(recording.id)}>
              Pause
            </Button>
          )}
          {stuck && (
            <Button size="sm" onClick={() => void queue.retry(recording.id)}>
              Retry
            </Button>
          )}
        </div>
      )}

      {transcript?.status === 'paused' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Paused at {formatClock(completedMs)} of {formatClock(totalMs)} ({percent}%)
          </p>
          <Button size="sm" onClick={() => void queue.retry(recording.id)}>
            Resume
          </Button>
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
          {isActive && queueState.stage === null && (
            // Reading and decoding the audio, or loading an already-cached
            // model: the steps of a job that report nothing of their own.
            <p className="text-xs text-muted-foreground">Preparing the audio…</p>
          )}
          {isActive && queueState.stage === 'transcribing' && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {formatClock(completedMs)} of {formatClock(totalMs)} ({percent}%)
              </p>
              <Progress value={percent} />
              {/* ⚑ A climbing count, deliberately not presented as a
                  proportion: the pipeline decides how many decode passes each
                  30-second window needs as it runs, so there is no total here
                  to be a fraction of. The bar above is the real proportion -
                  windows finished against the recording's length - and this
                  is the sign of life *within* the window in flight. */}
              <p className="text-xs text-muted-foreground">
                {queueState.passes ?? 0} passes decoded in this window
              </p>
            </div>
          )}
          {(isActive || isQueued) && (
            <Button variant="outline" size="sm" onClick={() => void queue.pause(recording.id)}>
              Pause
            </Button>
          )}
          {stuck && (
            <Button size="sm" onClick={() => void queue.retry(recording.id)}>
              Retry
            </Button>
          )}
        </div>
      )}

      {(transcript?.status === 'running' || transcript?.status === 'paused') &&
        transcript.segments.length > 0 && (
          // ⚑ Below the status and its controls, not above: on a lecture
          // this list runs to thousands of lines, and anything after it is
          // off screen. Pause and Resume have to stay reachable while the
          // transcript they act on is being read.
          //
          // ⚑ The same list the finished transcript renders, not a paragraph
          // of joined text. A partial transcript's segments carry their
          // `startMs` exactly as a finished one's do, so presenting it
          // differently would drop the timestamp links - and the seek they
          // perform - for the whole time a long job is running, which is
          // precisely when the owner is most likely to be reading along.
          <TranscriptSegments segments={transcript.segments} onSeek={seekTo} />
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
            <TranscriptSegments segments={transcript.segments} onSeek={seekTo} />
          ) : (
            <p className="font-transcript text-sm">{transcript.text}</p>
          )}
          <p className="text-xs text-muted-foreground">{transcript.model}</p>
        </div>
      )}
    </div>
  );
}
