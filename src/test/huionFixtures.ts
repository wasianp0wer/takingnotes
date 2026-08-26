import { FakeHuionTransport } from '@/test/fakeHuionTransport';
import { CMD } from '@/utils/huionProtocol';

/**
 * Appends the protocol's one-byte sum checksum. Only PAGE_PACKAGE frames and
 * live pen packets carry a trailing checksum on the wire - command replies
 * end in the 0xED terminator instead. The driver only ever runs
 * `verifyChecksum` on those two frame types and never inspects a command
 * reply's last byte (except to check it is *not* 0xED, when disambiguating an
 * 11-byte live packet from a real 0x8D reply), so using this helper to build
 * command replies is harmless.
 */
export function withChecksum(bytes: number[]): Uint8Array {
  const sum = bytes.reduce((total, byte) => total + byte, 0) & 0xff;
  return new Uint8Array([...bytes, sum]);
}

/**
 * A real 11-byte live pen packet, pen down. Layout is
 * `[hdr0-3][Xlo][Xhi][Ylo][Yhi][Plo][Phi|status][checksum]`, so this is
 * x=0x03e8 (1000), y=0x03e8 (1000), pressure=0x1000 (4096), status=1.
 *
 * Against `connectedFake()`'s A5 geometry (maxX/maxY 32767, maxPressure 8191)
 * that is ~50% pressure - comfortably over the driver's 7% FILTER_PRESS_PERCENT
 * threshold - so `decodeLivePacket` yields a pen-DOWN point rather than
 * flattening it to status 0. The trailing checksum is 0x6b, not 0xED, which is
 * what makes the driver treat a 0x8D frame as live data instead of a reply.
 */
export const LIVE_PEN_DOWN_PACKET = withChecksum([
  0xcd, CMD.ONLINE_ENABLE, 0x0b, 0x00,
  0xe8, 0x03, // x = 1000
  0xe8, 0x03, // y = 1000
  0x00, 0x30, // pressure = 4096, status = 1
]);

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
