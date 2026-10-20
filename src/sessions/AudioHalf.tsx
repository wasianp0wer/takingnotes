import { useEffect, useRef } from 'react';

import type { TranscriptionQueue as AudioTranscriptionQueue } from '@/audio/transcriptionQueue';
import { formatClock } from '@/audio/format';
import { Button } from '@/components/ui/button';
import { RecordingDetail } from '@/recordings/RecordingDetail';
import type { SeekRequest } from '@/sessions/sessionsUiStore';
import type { RecordingRecord } from '@/storage/types';

export interface AudioHalfProps {
  recordings: RecordingRecord[]; // ascending startedAt
  selectedRecordingId: string | null;
  onSelectRecording(id: string): void;
  seek: SeekRequest | null;
  onSeekApplied(token: number): void;
  /** True while this entry is the live note. */
  followNewest: boolean;
  audioQueue: AudioTranscriptionQueue;
  onChanged(): void;
}

/** The audio half: "‹ Recording N of M ›", then the selected recording's player and transcript. */
export function AudioHalf({
  recordings,
  selectedRecordingId,
  onSelectRecording,
  seek,
  onSeekApplied,
  followNewest,
  audioQueue,
  onChanged,
}: AudioHalfProps) {
  const newestId = recordings.at(-1)?.id ?? null;
  const previousNewestId = useRef(newestId);

  useEffect(() => {
    const previous = previousNewestId.current;
    previousNewestId.current = newestId;
    // Only a recording arriving after the first render counts as "new".
    if (followNewest && newestId !== null && previous !== null && newestId !== previous) {
      onSelectRecording(newestId);
    }
    // `onSelectRecording` is not a dependency: a new identity must not re-select.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestId, followNewest]);

  if (recordings.length === 0) return <div className="flex h-full flex-col gap-2 p-2" />;

  const found = recordings.findIndex((r) => r.id === selectedRecordingId);
  const index = found === -1 ? 0 : found;
  const selected = recordings[index]!;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous recording"
          disabled={index <= 0}
          onClick={() => onSelectRecording(recordings[index - 1]!.id)}
        >
          ‹
        </Button>
        <span className="text-sm text-muted-foreground">
          Recording {index + 1} of {recordings.length}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next recording"
          disabled={index >= recordings.length - 1}
          onClick={() => onSelectRecording(recordings[index + 1]!.id)}
        >
          ›
        </Button>
        <span className="text-xs text-timestamp">{formatClock(selected.durationMs)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <RecordingDetail
          key={selected.id}
          recording={selected}
          queue={audioQueue}
          onDelete={onChanged}
          onRenamed={onChanged}
          seek={seek && seek.recordingId === selected.id ? seek : undefined}
          onSeekApplied={onSeekApplied}
        />
      </div>
    </div>
  );
}
