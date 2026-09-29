import { describe, expect, it, vi } from 'vitest';
import { decodeToPcm16k, downmixToMono, resampleLinear } from '@/audio/pcm';

const f32 = (...v: number[]) => new Float32Array(v);

function fakeAudioBuffer(sampleRate: number, channels: Float32Array[]): AudioBuffer {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    getChannelData: (i: number) => channels[i],
  } as unknown as AudioBuffer;
}

describe('downmixToMono', () => {
  it('averages channels sample by sample', () => {
    expect(Array.from(downmixToMono([f32(1, 0, -1), f32(0, 0, 1)]))).toEqual([0.5, 0, 0]);
  });
  it('copies a mono channel', () => {
    const mono = f32(0.25, 0.5);
    const out = downmixToMono([mono]);
    expect(Array.from(out)).toEqual([0.25, 0.5]);
    expect(out).not.toBe(mono);
  });
  it('uses the shortest channel length and handles no channels', () => {
    expect(downmixToMono([f32(1, 1, 1), f32(1)]).length).toBe(1);
    expect(downmixToMono([]).length).toBe(0);
  });
});

describe('resampleLinear', () => {
  it('downsamples 48k to 16k with the expected length and values', () => {
    const ramp = new Float32Array(48).map((_, i) => i);
    const out = resampleLinear(ramp, 48_000, 16_000);
    expect(out.length).toBe(16);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(3);
    expect(out[15]).toBe(45);
  });
  it('interpolates when upsampling', () => {
    expect(Array.from(resampleLinear(f32(0, 1), 8_000, 16_000))).toEqual([0, 0.5, 1, 1]);
  });
  it('copies at equal rates, keeps constants constant, and rejects bad rates', () => {
    const same = f32(1, 2);
    expect(resampleLinear(same, 16_000, 16_000)).not.toBe(same);
    expect(Array.from(resampleLinear(new Float32Array(441).fill(0.5), 44_100, 16_000)).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
    expect(() => resampleLinear(same, 0, 16_000)).toThrow(RangeError);
    expect(resampleLinear(new Float32Array(0), 48_000, 16_000).length).toBe(0);
  });
});

describe('decodeToPcm16k', () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });

  it('decodes then renders offline at 16 kHz', async () => {
    const buffer = fakeAudioBuffer(48_000, [f32(1, 1, 1)]);
    const decode = vi.fn().mockResolvedValue(buffer);
    const renderOffline = vi.fn().mockResolvedValue(f32(0.1, 0.2));
    const out = await decodeToPcm16k(blob, { decode, renderOffline });
    expect(decode).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(renderOffline).toHaveBeenCalledWith(buffer, 16_000);
    expect(Array.from(out)).toEqual([f32(0.1)[0], f32(0.2)[0]]);
  });

  it('falls back to the pure downmix + resample when offline rendering fails', async () => {
    const buffer = fakeAudioBuffer(32_000, [f32(1, 1, 1, 1), f32(0, 0, 0, 0)]);
    const out = await decodeToPcm16k(blob, {
      decode: async () => buffer,
      renderOffline: async () => { throw new Error('no offline context'); },
    });
    expect(Array.from(out)).toEqual([0.5, 0.5]);
  });

  it('rejects an empty recording and wraps decode failures', async () => {
    await expect(decodeToPcm16k(new Blob([]), { decode: vi.fn() })).rejects.toThrow('Recording has no audio');
    await expect(
      decodeToPcm16k(blob, { decode: async () => { throw new Error('EncodingError'); } }),
    ).rejects.toThrow('Could not decode the recording: EncodingError');
  });
});
