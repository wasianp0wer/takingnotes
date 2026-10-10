// K8, the mandatory test (⚑ docs/features/s3-spec.md "K8's decode test: what
// it proves, and the one compromise"): a recording truncated mid-stream - a
// crash before `stop()` ever ran, so the WebM container was never finalised
// - must be recovered by K7's startup recovery, and the recovered audio must
// really decode, not merely "exist as some bytes".
//
// This repository's only configured test environment (happy-dom) implements
// no AudioContext/OfflineAudioContext at all, and every other audio test in
// this codebase exercises `decodeToPcm16k` through injected fakes (see
// pcm.test.ts) rather than a real codec - there has never been a way to
// really decode audio in this test suite. To make this test prove something
// real rather than a canned "decode resolves" stub, it uses the system's
// `ffmpeg` (already present on this machine; not an npm dependency, and no
// application code path depends on it) as the `decode` function injected at
// exactly the seam `decodeToPcm16k` already designates for this
// (`PcmDeps.decode`, the same seam that stands in for
// `AudioContext.decodeAudioData` in every other test). If `ffmpeg` is not on
// `PATH`, this test fails loudly - never a silent skip, never a pass.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { recoverInterruptedRecordings, resetAudioRuntimeForTests } from '@/audio/audioRuntime';
import { decodeToPcm16k } from '@/audio/pcm';
import type { MediaRecorderCtor, MediaRecorderLike } from '@/audio/recorder';
import { createRecorder } from '@/audio/recorder';
import { getRecording, getRecordingAudio } from '@/storage/recordings';
import { resetDatabase } from '@/test/resetDb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'truncatable-tone.webm');

/**
 * Real Matroska Cluster element offsets in the committed fixture, found once
 * by scanning the file for the `0x1F43B675` Cluster id (not re-derived at
 * test time - the fixture's bytes are fixed forever once committed).
 * Slicing at these boundaries is what makes each "chunk" below a faithful
 * model of one `MediaRecorder` `ondataavailable` delivery: a real, complete
 * slice of the container, not an arbitrarily corrupted one.
 */
const CLUSTER_OFFSETS = [0, 4675, 8911, 13149, 17387, 21637, 25877, 30070, 34354, 38492, 39440];

/**
 * Only the first 8 "chunks" (bytes 0-34354) ever arrive. The 9th cluster and
 * the trailing Cues element - `ffmpeg`'s finalisation, written only once the
 * whole file is known, the same role `MediaRecorder.stop()`'s own final
 * flush plays in a real recording - are withheld entirely. This is K8's
 * exact risk: a stream truncated mid-flight, with no finalised container,
 * because the process crashed before `stop()` ever ran.
 */
const DELIVERED_CHUNKS = 8;
const TRUNCATED_BYTE_LENGTH = CLUSTER_OFFSETS[DELIVERED_CHUNKS]; // 34354
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

class CrashingMediaRecorder implements MediaRecorderLike {
  static instances: CrashingMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return false;
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  mimeType = '';

  constructor() {
    CrashingMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  /**
   * Deliberately does nothing: in a real crash nothing ever calls `stop()`,
   * so `onstop` never fires and the recorder's in-memory state (whatever a
   * reload would wipe anyway) is simply abandoned. Recovery must find the
   * recording from storage alone, not from anything this object does.
   */
  stop(): void {
    /* no-op: the crash */
  }

  emit(bytes: Uint8Array): void {
    // A fresh copy backed by a real ArrayBuffer: `fixture.subarray(...)`
    // is a Node Buffer view, whose `.buffer` type (ArrayBufferLike) Blob's
    // constructor does not accept directly.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    this.ondataavailable?.({ data: new Blob([copy], { type: 'audio/webm' }) });
  }
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
}

/** A few real microtask turns, enough for fake-indexeddb's async writes to land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * The one real decoder available anywhere near this test suite. Spawns
 * `ffmpeg`, feeds it the raw bytes on stdin, and reads back 16 kHz mono PCM
 * on stdout - substituting for `AudioContext.decodeAudioData` at exactly the
 * seam `decodeToPcm16k` already injects it through. A missing `ffmpeg`
 * rejects with a message naming exactly that, never a silent fallback.
 */
function ffmpegDecode(data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 'f32le', '-ar', '16000', '-ac', '1', 'pipe:1'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`ffmpeg is required for this test but could not be spawned: ${String(error)}`));
      return;
    }
    const out: Buffer[] = [];
    let stderr = '';
    proc.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => {
      reject(new Error(`ffmpeg is required for this test but could not be spawned: ${error.message}`));
    });
    proc.on('close', () => {
      const buffer = Buffer.concat(out);
      if (buffer.length === 0) {
        reject(new Error(`ffmpeg produced no decoded audio. stderr:\n${stderr}`));
        return;
      }
      const pcm = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        Math.floor(buffer.length / Float32Array.BYTES_PER_ELEMENT),
      );
      resolve({
        sampleRate: 16_000,
        numberOfChannels: 1,
        length: pcm.length,
        duration: pcm.length / 16_000,
        getChannelData: () => pcm,
      } as unknown as AudioBuffer);
    });
    proc.stdin!.write(Buffer.from(data));
    proc.stdin!.end();
  });
}

beforeEach(async () => {
  await resetDatabase();
  resetAudioRuntimeForTests();
  CrashingMediaRecorder.instances = [];
});

describe('K8: a stitched, truncated recording survives real decode', () => {
  it('recovers a crash-truncated recording and the recovered bytes really decode to non-silent audio', async () => {
    const fixture = readFileSync(FIXTURE_PATH);

    const recorder = createRecorder({
      getUserMedia: async () => fakeStream(),
      MediaRecorder: CrashingMediaRecorder as unknown as MediaRecorderCtor,
      // Every storage dependency is left at its default, so this really
      // exercises createRecording / appendRecordingChunk against
      // fake-indexeddb, the same as the production recorder.
    });

    await recorder.start({ sessionId: null, noteId: null });
    const fake = CrashingMediaRecorder.instances[0];
    expect(fake).toBeDefined();

    for (let i = 0; i < DELIVERED_CHUNKS; i += 1) {
      fake.emit(fixture.subarray(CLUSTER_OFFSETS[i], CLUSTER_OFFSETS[i + 1]));
    }
    await flush();

    // The crash: nothing calls stop(), nothing calls onstop. recorder.ts's
    // in-memory state is simply abandoned, exactly as a reload would leave
    // it. Recovery must find and close this recording from storage alone.
    const recoveredIds: string[] = [];
    await recoverInterruptedRecordings({
      enqueue: async (id) => {
        recoveredIds.push(id);
      },
    });

    expect(recoveredIds).toHaveLength(1);
    const recordingId = recoveredIds[0];

    const after = await getRecording(recordingId);
    expect(after).toBeDefined();
    expect(after!.endedAt).not.toBeNull();
    expect(after!.byteLength).toBe(TRUNCATED_BYTE_LENGTH);

    const audioBlob = await getRecordingAudio(recordingId);
    expect(audioBlob).not.toBeNull();
    const bytes = new Uint8Array(await audioBlob!.arrayBuffer());
    expect(bytes.length).toBe(TRUNCATED_BYTE_LENGTH);
    // Real EBML magic, not a placeholder - this really is a (truncated)
    // Matroska/WebM stream, not arbitrary bytes that happen to be the right
    // length.
    expect(Array.from(bytes.slice(0, 4))).toEqual(EBML_MAGIC);

    // "Survives the decode path": decodeToPcm16k is the real, unmodified
    // application function; only its `decode` seam is pointed at ffmpeg
    // instead of a browser's AudioContext, and `renderOffline` is a
    // pass-through because ffmpeg already resampled to 16 kHz mono.
    const pcm = await decodeToPcm16k(audioBlob!, {
      decode: ffmpegDecode,
      renderOffline: async (buffer) => buffer.getChannelData(0) as Float32Array,
    });

    // "Plays": real decoded signal recovered from before the crash - more
    // than two seconds of the original four, and genuinely non-silent, not
    // an empty or all-zero buffer a lenient decoder could hand back for a
    // corrupt stream.
    expect(pcm.length).toBeGreaterThan(16_000 * 2);
    let maxAbs = 0;
    for (const sample of pcm) maxAbs = Math.max(maxAbs, Math.abs(sample));
    expect(maxAbs).toBeGreaterThan(0.01);
  }, 20_000);

  it('sanity companion: the untruncated fixture decodes to the full ~4s of real audio', async () => {
    const fixture = readFileSync(FIXTURE_PATH);
    const blob = new Blob([fixture], { type: 'audio/webm' });

    const pcm = await decodeToPcm16k(blob, {
      decode: ffmpegDecode,
      renderOffline: async (buffer) => buffer.getChannelData(0) as Float32Array,
    });

    expect(pcm.length).toBeGreaterThan(16_000 * 3.9);
    let maxAbs = 0;
    for (const sample of pcm) maxAbs = Math.max(maxAbs, Math.abs(sample));
    expect(maxAbs).toBeGreaterThan(0.01);
  }, 20_000);
});
