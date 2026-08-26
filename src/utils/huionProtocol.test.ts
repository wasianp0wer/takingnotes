import { describe, expect, it } from 'vitest';

import {
  clamp,
  CMD,
  computeAuthResponse,
  makeFrame,
  verifyChecksum,
} from '@/utils/huionProtocol';

describe('makeFrame', () => {
  it('builds the documented 8-byte command frame', () => {
    // Frame format: [0xCD] [CMD] [0x08] [P1] [P2] [P3] [P4] [0xED]
    expect(Array.from(makeFrame(CMD.VERIFY_CONNECT))).toEqual([
      0xcd, 0x81, 0x08, 0, 0, 0, 0, 0xed,
    ]);
  });

  it('places all four parameters', () => {
    expect(Array.from(makeFrame(CMD.SET_PACKET_DISTANCE, 1, 3, 0, 0))).toEqual([
      0xcd, 0x96, 0x08, 1, 3, 0, 0, 0xed,
    ]);
  });
});

describe('verifyChecksum', () => {
  it('accepts a frame whose last byte is the sum of the rest', () => {
    // 0x01 + 0x02 + 0x03 = 0x06
    expect(verifyChecksum(new Uint8Array([0x01, 0x02, 0x03, 0x06]))).toBe(true);
  });

  it('wraps the sum at one byte', () => {
    // 0xFF + 0x02 = 0x101, truncated to 0x01
    expect(verifyChecksum(new Uint8Array([0xff, 0x02, 0x01]))).toBe(true);
  });

  it('rejects a corrupted frame', () => {
    expect(verifyChecksum(new Uint8Array([0x01, 0x02, 0x03, 0x07]))).toBe(false);
  });

  it('rejects a frame too short to contain a checksum', () => {
    expect(verifyChecksum(new Uint8Array([0x01]))).toBe(false);
  });
});

describe('computeAuthResponse', () => {
  it('applies the documented handshake formula', () => {
    // ((a+b)<<2)%255, ((b+c)<<2)%255, ((c+10)<<2)%255
    expect(computeAuthResponse(1, 2, 3)).toEqual([12, 20, 52]);
  });

  it('wraps each component at 255', () => {
    // (100+100)<<2 = 800; 800 % 255 = 35
    expect(computeAuthResponse(100, 100, 0)[0]).toBe(35);
  });
});

describe('clamp', () => {
  it('passes a value already inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps both directions', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
