// The message protocol shared by the main thread (`whisperClient.ts`) and the Whisper
// worker, plus the pure mapping from Whisper's chunk output to `TranscriptSegment`s.
// Deliberately free of any `@huggingface/transformers` import so both sides and the
// tests can load it without pulling in the model runtime.
import type { TranscriptSegment } from '@/storage/types';
import type { TranscribeStage } from '@/audio/types';

/** One timestamped chunk as Whisper's ASR pipeline returns it. Seconds; `end` may be missing. */
export interface WhisperChunk {
  timestamp: [number, number | null];
  text: string;
}

export type WhisperRequest =
  | { type: 'transcribe'; id: number; model: string; pcm: Float32Array }
  | { type: 'cancel'; id: number };

export type WhisperResponse =
  | {
      type: 'progress';
      id: number;
      stage: TranscribeStage;
      /** 0-1 while `loading`. Always 0 while `transcribing`: see `passes`. */
      progress: number;
      /**
       * Decode passes finished so far, while `transcribing`. There is
       * deliberately no total: the pipeline decides how many passes a window
       * needs as it goes (`_generate_with_seek`), so the only honest report is
       * the count, and a count is enough to tell a working job from a dead one.
       */
      passes?: number;
    }
  | { type: 'result'; id: number; text: string; chunks: WhisperChunk[] }
  | { type: 'error'; id: number; message: string };

/**
 * Whisper's decoder holds 448 positions in total, the prompt prefix included,
 * so a new-token cap has to leave room for the init tokens. 440 is far more
 * than a 30-second chunk of real speech ever needs (that would be several
 * hundred words a minute) while still being a hard stop.
 */
const MAX_NEW_TOKENS = 440;

/** Options passed to the Whisper pipeline call itself (global constraints). */
export const WHISPER_OPTIONS = {
  return_timestamps: true,
  chunk_length_s: 30,
  stride_length_s: 5,
  /**
   * ⚑ Load-bearing, and not only as a safety cap: this is what keeps a single
   * window from running thousands of decode passes and never finishing.
   *
   * With `return_timestamps` set and no `max_new_tokens`, transformers.js
   * routes through `WhisperForConditionalGeneration._generate_with_seek`
   * (`modeling_whisper.js:157`). That function's `while (seek < total_frames)`
   * loop advances by `seek += segment_offset`, and in its "ends mid-segment"
   * branch `segment_offset = last_ts_pos * input_stride` - which is **zero**
   * whenever the model's last complete segment boundary is the `<|0.00|>`
   * timestamp. Nothing guards against a zero advance, so the loop re-generates
   * the same audio for ever. Every spin emits a progress report, which is why
   * the pass counter climbs without bound and why the stall watchdog - which
   * reads any report as a sign of life - never fires.
   *
   * Degenerate decodes are what produce that `<|0.00|>` boundary: repetition
   * loops, crosstalk, overlapping speakers, long silence. A seminar recording
   * is squarely in that territory.
   *
   * Setting this takes the plain `super.generate()` path instead. Timestamps
   * survive, because `WhisperTimeStampLogitsProcessor` is installed before the
   * branch; and nothing is lost by skipping the seek loop, because
   * `chunk_length_s` above already splits the audio into 30-second pieces -
   * the long-form splitting the seek loop exists to do - and the pipeline
   * stitches them back with `stride_length_s`.
   *
   * It also bounds an ordinary repetition loop, which would otherwise run to
   * the decoder's own limit on every affected chunk.
   */
  max_new_tokens: MAX_NEW_TOKENS,
} as const;

/**
 * Maps Whisper chunks (seconds) to transcript segments (ms offsets from the recording start).
 * Chunks are sorted by start and blank ones dropped; a missing end is filled from the next
 * chunk's start, or from `durationMs` for the last chunk.
 *
 * `durationMs` is the duration of whatever audio was transcribed, and
 * `offsetMs` is where that audio began in the recording. For a whole-recording
 * call both are what they have always been (`offsetMs` 0); for one window of a
 * chunked transcription, `durationMs` is the window's length and `offsetMs` is
 * its start, which is what lifts the window's local times back onto the
 * recording's own clock.
 */
export function chunksToSegments(
  chunks: readonly WhisperChunk[],
  durationMs: number,
  offsetMs = 0,
): TranscriptSegment[] {
  const kept = chunks
    .filter((chunk) => chunk.text.trim() !== '')
    .sort((a, b) => a.timestamp[0] - b.timestamp[0]);

  return kept.map((chunk, index) => {
    const [startSeconds, endSeconds] = chunk.timestamp;
    const startMs = Math.round(startSeconds * 1000) + offsetMs;
    const end = endSeconds ?? kept[index + 1]?.timestamp[0] ?? durationMs / 1000;
    return {
      startMs,
      // The offset lands on the end too, including the `durationMs` fallback:
      // without it the last segment of every window after the first would be
      // stamped back near the start of the recording.
      endMs: Math.max(startMs, Math.round(end * 1000) + offsetMs),
      text: chunk.text.trim(),
    };
  });
}

/** The language a model id pins, or `null` when the model is multilingual. */
export function languageForModel(model: string): string | null {
  return /\.en$/i.test(model) ? 'en' : null;
}
