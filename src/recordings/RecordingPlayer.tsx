import { useEffect, useState, type RefObject } from 'react';
import { Download, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';

import { formatClock } from '@/audio/format';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

const SPEEDS = [1, 1.25, 1.5, 2, 0.75] as const;
const SKIP_SECONDS = 15;

/**
 * The length to scrub across. MediaRecorder WebM carries no duration, so the
 * element reports `Infinity` (or NaN before metadata) and the stored length -
 * measured while recording - stands in for it.
 */
export function effectiveDurationMs(audioDuration: number, storedMs: number): number {
  return Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration * 1000 : storedMs;
}

/**
 * A recording's player: play/pause, a scrub bar over the whole recording, 15
 * second skips, a speed cycle and an optional download.
 *
 * ⚑ Not `<audio controls>`: with no duration in the file the native control
 * has nothing to scrub across and cannot seek. The element is still the
 * source of truth - `audioRef` is the caller's handle on it for transcript
 * seeking - and this only mirrors its events into state.
 */
export function RecordingPlayer({
  src,
  durationMs,
  audioRef,
  onDownload,
}: {
  src: string;
  durationMs: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  onDownload?: () => void;
}) {
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [elementDuration, setElementDuration] = useState(NaN);
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const sync = () => {
      setCurrentSeconds(audio.currentTime);
      setElementDuration(audio.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    audio.addEventListener('timeupdate', sync);
    audio.addEventListener('loadedmetadata', sync);
    audio.addEventListener('durationchange', sync);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onPause);
    return () => {
      audio.removeEventListener('timeupdate', sync);
      audio.removeEventListener('loadedmetadata', sync);
      audio.removeEventListener('durationchange', sync);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onPause);
    };
  }, [audioRef, src]);

  const totalMs = effectiveDurationMs(elementDuration, durationMs);
  const totalSeconds = Math.max(1, Math.round(totalMs / 1000));

  function seekToSeconds(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = Math.min(Math.max(seconds, 0), totalMs / 1000);
    audio.currentTime = clamped;
    setCurrentSeconds(clamped);
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      return;
    }
    const started = audio.play();
    if (started && typeof started.catch === 'function') started.catch(() => {});
  }

  function cycleSpeed() {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  }

  const speed = SPEEDS[speedIndex];

  return (
    <div className="space-y-2">
      <audio ref={audioRef} src={src} />
      <Slider
        aria-label="Seek"
        min={0}
        max={totalSeconds}
        step={1}
        value={[Math.min(Math.floor(currentSeconds), totalSeconds)]}
        onValueChange={([seconds]) => seekToSeconds(seconds)}
      />
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={togglePlay}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Back ${SKIP_SECONDS} seconds`}
          onClick={() => seekToSeconds((audioRef.current?.currentTime ?? 0) - SKIP_SECONDS)}
        >
          <RotateCcw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Forward ${SKIP_SECONDS} seconds`}
          onClick={() => seekToSeconds((audioRef.current?.currentTime ?? 0) + SKIP_SECONDS)}
        >
          <RotateCw />
        </Button>
        <span className="px-1 text-xs tabular-nums text-muted-foreground">
          {formatClock(currentSeconds * 1000)} / {formatClock(totalMs)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto tabular-nums"
          aria-label="Playback speed"
          onClick={cycleSpeed}
        >
          {speed}×
        </Button>
        {onDownload && (
          <Button variant="ghost" size="icon-sm" aria-label="Download audio" onClick={onDownload}>
            <Download />
          </Button>
        )}
      </div>
    </div>
  );
}
