/** Target sample rate (Hz) Whisper expects for its input PCM. */
export const TARGET_SAMPLE_RATE = 16_000;

/** Downmixes any number of channels to a single mono channel by per-sample averaging. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) {
    return new Float32Array(0);
  }
  if (channels.length === 1) {
    return channels[0].slice();
  }
  const length = Math.min(...channels.map((channel) => channel.length));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[i];
    }
    out[i] = sum / channels.length;
  }
  return out;
}

/** Resamples `input` from `fromRate` to `toRate` Hz using linear interpolation. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) {
    throw new RangeError('Sample rates must be positive');
  }
  if (fromRate === toRate) {
    return input.slice();
  }
  const outLength = Math.round((input.length * toRate) / fromRate);
  const output = new Float32Array(outLength);
  if (input.length === 0) {
    return output;
  }
  const lastIndex = input.length - 1;
  for (let i = 0; i < outLength; i += 1) {
    const srcPos = (i * fromRate) / toRate;
    const floorIndex = Math.min(Math.floor(srcPos), lastIndex);
    const ceilIndex = Math.min(floorIndex + 1, lastIndex);
    const frac = srcPos - floorIndex;
    output[i] = input[floorIndex] * (1 - frac) + input[ceilIndex] * frac;
  }
  return output;
}

/** Decoded audio: raw per-channel samples at the source sample rate. */
export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

/** Injectable dependencies for `decodeToPcm16k`, so tests can avoid real browser audio APIs. */
export interface PcmDeps {
  decode?: (data: ArrayBuffer) => Promise<AudioBuffer>;
  renderOffline?: (buffer: AudioBuffer, targetRate: number) => Promise<Float32Array>;
}

async function defaultDecode(data: ArrayBuffer): Promise<AudioBuffer> {
  if (typeof AudioContext === 'undefined') {
    throw new Error('This browser cannot decode audio');
  }
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(data);
  } finally {
    await ctx.close();
  }
}

async function defaultRenderOffline(buffer: AudioBuffer, targetRate: number): Promise<Float32Array> {
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('OfflineAudioContext is unavailable');
  }
  const frameCount = Math.max(1, Math.ceil(buffer.duration * targetRate));
  const ctx = new OfflineAudioContext(1, frameCount, targetRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Decodes an audio blob and prepares it as 16 kHz mono PCM for Whisper. */
export async function decodeToPcm16k(audio: Blob, deps: PcmDeps = {}): Promise<Float32Array> {
  const data = await audio.arrayBuffer();
  if (data.byteLength === 0) {
    throw new Error('Recording has no audio');
  }

  const decode = deps.decode ?? defaultDecode;
  const renderOffline = deps.renderOffline ?? defaultRenderOffline;

  let buffer: AudioBuffer;
  try {
    buffer = await decode(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not decode the recording: ${message}`);
  }

  try {
    return await renderOffline(buffer, TARGET_SAMPLE_RATE);
  } catch {
    const channels: Float32Array[] = [];
    for (let i = 0; i < buffer.numberOfChannels; i += 1) {
      channels.push(buffer.getChannelData(i));
    }
    return resampleLinear(downmixToMono(channels), buffer.sampleRate, TARGET_SAMPLE_RATE);
  }
}
