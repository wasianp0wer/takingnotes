import type { TranscriptSegment } from '@/storage/types';

/** Which phase of a transcription a progress report belongs to. */
export type TranscribeStage = 'loading' | 'transcribing';

export interface TranscribeOptions {
  /** Whisper model id, e.g. `Xenova/whisper-base.en`. */
  model: string;
  /**
   * `p` is 0–1 within `stage`, and always 0 while `transcribing`, where
   * `passes` (decode passes finished so far, with no knowable total) is the
   * real signal. Any call at all is a sign of life for the queue's watchdog.
   */
  onProgress?: (p: number, stage: TranscribeStage, passes?: number) => void;
  signal?: AbortSignal;
  /**
   * Where `pcm` begins in the recording it was sliced from, in ms. Returned
   * segment times are shifted by it, so one window of a chunked
   * transcription lands on the recording's own clock rather than on the
   * window's. Defaults to 0, which is a whole-recording call.
   */
  offsetMs?: number;
}

export interface AudioTranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
}

export interface AudioTranscriber {
  /** 16 kHz mono PCM. The buffer may be transferred (detached) by the implementation. */
  transcribe(pcm: Float32Array, opts: TranscribeOptions): Promise<AudioTranscriptionResult>;
}
