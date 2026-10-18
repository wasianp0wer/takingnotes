import { TARGET_SAMPLE_RATE } from '@/audio/pcm';
import { openNotesDb } from '@/storage/db';
import type { PcmCacheRecord } from '@/storage/types';

/**
 * The `pcmCache` store: a recording's decoded audio, held only while its
 * transcription is unfinished. See `PcmCacheRecord` for why it exists and why
 * it is transient.
 *
 * Samples are quantized to Int16 against 32767 rather than 32768, so that
 * ±1.0 - the loudest a normalized sample can be - survives the round trip
 * exactly instead of coming back a hair short.
 */
const FULL_SCALE = 32767;

function clamp(sample: number): number {
  // Clamped, never wrapped: a sample above full scale wrapped into an Int16
  // comes back as a loud sample of the opposite sign, which is audible
  // garbage where clipping is merely clipping.
  if (sample > 1) return 1;
  if (sample < -1) return -1;
  // NaN compares false both ways and would quantize to 0 via Math.round
  // anyway; being explicit keeps that from reading as an accident.
  return Number.isNaN(sample) ? 0 : sample;
}

export async function putPcmCache(recordingId: string, pcm: Float32Array): Promise<void> {
  const samples = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    samples[i] = Math.round(clamp(pcm[i]) * FULL_SCALE);
  }
  const record: PcmCacheRecord = {
    recordingId,
    sampleRate: TARGET_SAMPLE_RATE,
    // `samples.buffer` is this view's whole buffer - it was just allocated
    // here - so there is no risk of storing more than intended.
    samples: samples.buffer,
  };
  const db = await openNotesDb();
  await db.put('pcmCache', record);
}

/** The cached PCM, or `null` when there is no row for this recording. */
export async function getPcmCache(recordingId: string): Promise<Float32Array | null> {
  const db = await openNotesDb();
  const record = await db.get('pcmCache', recordingId);
  if (!record) return null;
  // ⚑ The reason `sampleRate` is stored at all. A row written at another
  // rate would come back as audio of the wrong length, putting every
  // transcript timestamp on the wrong clock with nothing to show it had
  // happened. Treated as a miss, so the caller simply re-decodes.
  if (record.sampleRate !== TARGET_SAMPLE_RATE) return null;
  const samples = new Int16Array(record.samples);
  const pcm = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    pcm[i] = samples[i] / FULL_SCALE;
  }
  return pcm;
}

export async function deletePcmCache(recordingId: string): Promise<void> {
  const db = await openNotesDb();
  await db.delete('pcmCache', recordingId);
}
