import { FakeHuionTransport } from '@/test/fakeHuionTransport';
import { CMD } from '@/utils/huionProtocol';

/** Appends the protocol's one-byte sum checksum, as a real device would. */
export function withChecksum(bytes: number[]): Uint8Array {
  const sum = bytes.reduce((total, byte) => total + byte, 0) & 0xff;
  return new Uint8Array([...bytes, sum]);
}

/**
 * A transport that completes the auth handshake the way a real device does,
 * so a test can start from a connected driver in one line.
 */
export function connectedFake(): FakeHuionTransport {
  const transport = new FakeHuionTransport();
  // Device issues challenge (a,b,c) = (1,2,3).
  transport.on(CMD.VERIFY_CONNECT, () => [
    withChecksum([0xcd, CMD.VERIFY_CONNECT, 0x08, 1, 2, 3, 0]),
  ]);
  // Device accepts the response.
  transport.on(CMD.VERIFY_RESPONSE, () => [
    withChecksum([0xcd, CMD.VERIFY_RESPONSE, 0x08, 1, 0, 0, 0]),
  ]);
  // The driver only resolves `connect()` once MAX_INFO comes back, so the
  // fake has to answer it too. A5 geometry: maxX/maxY 32767, maxPressure 8191.
  transport.on(CMD.MAX_INFO, () => [
    withChecksum([
      0xcd, CMD.MAX_INFO, 0x0b,
      0xff, 0x7f, 0x00, // maxX  = 0x007fff
      0xff, 0x7f, 0x00, // maxY  = 0x007fff
      0xff, 0x1f,       // maxPressure = 0x1fff
    ]),
  ]);
  return transport;
}
