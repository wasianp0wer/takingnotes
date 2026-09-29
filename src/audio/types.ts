import type { TranscriptSegment } from '@/storage/types';

/** Which phase of a transcription a progress report belongs to. */
export type TranscribeStage = 'loading' | 'transcribing';

export interface TranscribeOptions {
  /** Whisper model id, e.g. `Xenova/whisper-base.en`. */
  model: string;
  /** `p` is 0–1 within `stage`. */
  onProgress?: (p: number, stage: TranscribeStage) => void;
  signal?: AbortSignal;
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
