// K8, the mandatory test (⚑ docs/features/s3-spec.md "K8's decode test: what
// it proves, and the one compromise"; residual-risk note in
// docs/architecture.md §8.2): a recording truncated mid-stream - a crash
// before `stop()` ever ran, so the WebM container was never finalised -
// must be recovered by K7's startup recovery, and the recovered audio must
// really decode, not merely "exist as some bytes".
//
// Two layers, deliberately split (fix round 1 on S3):
//
// 1. A structural check that runs unconditionally, with no external tool.
//    It parses the recovered bytes as EBML/Matroska by hand (a valid header,
//    every chunk boundary landing on a real Cluster element, each of those
//    Clusters self-describing a size that lands exactly on the next
//    boundary) and needs nothing beyond Node. This guards S3's own
//    stitching logic hermetically and can never be skipped, so it alone is
//    enough to catch a stitching regression (seq-order bug, a dropped
//    chunk, truncation at the wrong byte) even on a machine with no ffmpeg.
// 2. A real-decode check using the system's `ffmpeg` (not an npm
//    dependency; no application code path depends on it) as the `decode`
//    function injected at exactly the seam `decodeToPcm16k` already
//    designates for this (`PcmDeps.decode`, the same seam every other test
//    in this codebase fakes, since `happy-dom` provides no real
//    `AudioContext` at all). This is strictly more than (1) proves - real
//    decoded, non-silent PCM - but it is the one place in this suite that
//    depends on something outside `npm`, so it is conditional: skipped with
//    an explicit, named reason when `ffmpeg` is not on `PATH` (never a bare
//    skip, never a silent one), and still fails loudly - never a quiet
//    fallback - when `ffmpeg` *is* present and decode fails.
import { spawnSync, spawn } from 'node:child_process';
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
 *
 * Index 0 (byte 0) is the EBML header + Segment info + Tracks, ending where
 * the first real Cluster starts; every later entry (indices 1-9) is a real
 * Cluster start. The structural check below relies on exactly this shape.
 */
const CLUSTER_OFFSETS = [0, 4675, 8911, 13149, 17387, 21637, 25877, 30070, 34354, 38492, 39440];

/**
 * Only the first 8 "chunks" (bytes 0-34354) ever arrive. The 9th cluster and
 * the trailing Cues element - `ffmpeg`'s finalisation, written only once the
 * whole file is known - are withheld entirely, modelling the crash: nothing
 * ever called `stop()`.
 *
 * ⚑ This fixture's finalisation is not a faithful stand-in for
 * `MediaRecorder.stop()`'s: `ffmpeg` writes a known Segment size and a
 * SeekHead pointing at these Cues, neither of which a real `MediaRecorder`
 * ever writes (its Segment size is unknown from the first byte, streamed
 * from the start, and it never writes Cues at all, stop() or no stop()).
 * See the residual-risk note in `docs/architecture.md` §8.2 for what that
 * means for this test's real-decode half.
 */
const DELIVERED_CHUNKS = 8;
const TRUNCATED_BYTE_LENGTH = CLUSTER_OFFSETS[DELIVERED_CHUNKS]; // 34354
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];

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
 * Drives the real `recorder.ts` with a `MediaRecorder` that delivers the
 * fixture's first `DELIVERED_CHUNKS` real chunks and then crashes (never
 * calls `stop()`, never fires `onstop`), then runs the real K7 recovery
 * against the same `fake-indexeddb`, and returns the recovered bytes.
 * Shared by both the structural and the real-decode test below so there is
 * exactly one place that does this dance.
 */
async function recoverCrashedRecording(): Promise<{ recordingId: string; bytes: Uint8Array }> {
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
  return { recordingId, bytes };
}

// --- EBML/Matroska, parsed by hand (no dependency) -------------------------
//
// Just enough of the format to prove the stitched bytes are a well-formed
// container, not merely "the right number of bytes": vint-encoded element
// ids and sizes are exactly what Matroska is built from. See the Matroska/
// EBML spec (https://www.rfc-editor.org/rfc/rfc8794) for the general rule;
// what's below is only what's needed to walk a known Cluster sequence.

/** The length (1-8 bytes) of an EBML vint, from its leading byte's marker bit. */
function vintLength(firstByte: number): number {
  if (firstByte === 0) {
    throw new Error('Invalid EBML vint: leading byte is 0x00');
  }
  let mask = 0x80;
  let length = 1;
  while ((firstByte & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  return length;
}

/** Decodes an EBML element *size* vint at `offset` (the length-marker bit is stripped from the value). */
function readElementSize(bytes: Uint8Array, offset: number): { size: number; headerLength: number } {
  const headerLength = vintLength(bytes[offset]);
  const marker = 0x80 >> (headerLength - 1);
  let size = bytes[offset] & (marker - 1);
  for (let i = 1; i < headerLength; i += 1) {
    size = size * 256 + bytes[offset + i];
  }
  return { size, headerLength };
}

/**
 * The structural half of K8, with no external tool: the recovered bytes
 * really are a well-formed (if unfinalised) Matroska/WebM stream, not just
 * the right number of bytes with the right first four. Specifically:
 *
 * - a valid EBML header at the front;
 * - every chunk boundary (where S3's recorder split `MediaRecorder`
 *   deliveries) lands on a real Cluster element - proving stitching
 *   preserved them in order, with nothing dropped or reordered;
 * - each of those Clusters is *complete*: its own declared size, decoded
 *   from its EBML header, places its end exactly at the next chunk boundary
 *   (or, for the last one, exactly at the truncation point) - never short
 *   (a corrupt/cut element) and never long (bytes spilling past where this
 *   truncated stream actually ends);
 * - the overall byte length matches exactly what withholding the final
 *   cluster and the Cues trailer should leave.
 *
 * Failing any of these means the *stitching*, not a browser or `ffmpeg`, is
 * what's broken - which is exactly the risk this half of K8 exists to catch
 * on every machine, with or without `ffmpeg`.
 */
function assertStructurallyValidStitchedWebm(bytes: Uint8Array): void {
  expect(bytes.length).toBe(TRUNCATED_BYTE_LENGTH);
  expect(Array.from(bytes.slice(0, 4))).toEqual(EBML_MAGIC);

  for (let i = 1; i < DELIVERED_CHUNKS; i += 1) {
    const clusterStart = CLUSTER_OFFSETS[i];
    const expectedEnd = CLUSTER_OFFSETS[i + 1];
    expect(
      Array.from(bytes.slice(clusterStart, clusterStart + 4)),
      `chunk boundary at byte ${clusterStart} should be a real Cluster element`,
    ).toEqual(CLUSTER_ID);

    const { size, headerLength } = readElementSize(bytes, clusterStart + 4);
    const actualEnd = clusterStart + 4 + headerLength + size;
    expect(
      actualEnd,
      `Cluster at byte ${clusterStart} should be complete, ending exactly at the next chunk boundary`,
    ).toBe(expectedEnd);
  }
}

// --- The real decoder, conditional on it being on PATH ----------------------

function detectFfmpeg(): boolean {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

const FFMPEG_AVAILABLE = detectFfmpeg();
const FFMPEG_MISSING_MESSAGE =
  '[K8] ffmpeg was not found on PATH, so the real-decode assertion below is NOT ' +
  'verified this run (it is skipped, not passed). The structural test still runs ' +
  'unconditionally and does not need ffmpeg. To verify the real-decode half: ' +
  'install ffmpeg (e.g. `brew install ffmpeg` on macOS, `apt-get install ffmpeg` on ' +
  'Debian/Ubuntu) and re-run `npm test -- src/audio/incrementalRecovery.decode.test.ts`.';

if (!FFMPEG_AVAILABLE) {
  // Deliberately visible in the test run's own output, not just the (easy to
  // miss) list of skipped test names - this is the "explicit message", not a
  // bare skip.
  console.warn(FFMPEG_MISSING_MESSAGE);
}

/**
 * The one real decoder available anywhere near this test suite. Spawns
 * `ffmpeg`, feeds it the raw bytes on stdin, and reads back 16 kHz mono PCM
 * on stdout - substituting for `AudioContext.decodeAudioData` at exactly the
 * seam `decodeToPcm16k` already injects it through. Only called once
 * `FFMPEG_AVAILABLE` is already known true; if `ffmpeg` is present but the
 * decode itself fails, this still rejects loudly - never a silent fallback.
 */
function ffmpegDecode(data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 'f32le', '-ar', '16000', '-ac', '1', 'pipe:1'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`ffmpeg could not be spawned: ${String(error)}`));
      return;
    }
    const out: Buffer[] = [];
    let stderr = '';
    proc.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => {
      reject(new Error(`ffmpeg could not be spawned: ${error.message}`));
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
  it('recovers a crash-truncated recording whose stitched bytes are a structurally valid, complete Matroska stream (no external tool required)', async () => {
    const { bytes } = await recoverCrashedRecording();
    assertStructurallyValidStitchedWebm(bytes);
  }, 20_000);

  it.skipIf(!FFMPEG_AVAILABLE)(
    FFMPEG_AVAILABLE
      ? 'real decode via ffmpeg: the recovered bytes decode to non-silent audio'
      : 'real decode via ffmpeg: the recovered bytes decode to non-silent audio [SKIPPED - ffmpeg not on PATH; see the console warning above]',
    async () => {
      const { bytes } = await recoverCrashedRecording();
      // A fresh copy backed by a definite ArrayBuffer - `bytes`' declared
      // type is widened to Uint8Array<ArrayBufferLike>, which Blob's
      // constructor does not accept directly (same reasoning as
      // CrashingMediaRecorder.emit() above).
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      const audioBlob = new Blob([copy], { type: 'audio/webm' });

      // "Survives the decode path": decodeToPcm16k is the real, unmodified
      // application function; only its `decode` seam is pointed at ffmpeg
      // instead of a browser's AudioContext, and `renderOffline` is a
      // pass-through because ffmpeg already resampled to 16 kHz mono.
      const pcm = await decodeToPcm16k(audioBlob, {
        decode: ffmpegDecode,
        renderOffline: async (buffer) => buffer.getChannelData(0) as Float32Array,
      });

      // "Plays": real decoded signal recovered from before the crash - more
      // than two seconds of the original four, and genuinely non-silent,
      // not an empty or all-zero buffer a lenient decoder could hand back
      // for a corrupt stream.
      expect(pcm.length).toBeGreaterThan(16_000 * 2);
      let maxAbs = 0;
      for (const sample of pcm) maxAbs = Math.max(maxAbs, Math.abs(sample));
      expect(maxAbs).toBeGreaterThan(0.01);
    },
    20_000,
  );

  it.skipIf(!FFMPEG_AVAILABLE)(
    FFMPEG_AVAILABLE
      ? 'sanity companion: the untruncated fixture decodes to the full ~4s of real audio via ffmpeg'
      : 'sanity companion: the untruncated fixture decodes to the full ~4s of real audio via ffmpeg [SKIPPED - ffmpeg not on PATH; see the console warning above]',
    async () => {
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
    },
    20_000,
  );
});
