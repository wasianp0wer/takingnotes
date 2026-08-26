/**
 * Huion Note X10 BLE Protocol
 * Reverse-engineered from APK decompilation.
 * 
 * Service: 0000ffe0-0000-1000-8000-00805f9b34fb
 * Write:   0000ffe2-...  (commands)
 * Notify:  0000ffe1-...  (responses)
 * 
 * Frame format: [0xCD] [CMD] [0x08] [P1] [P2] [P3] [P4] [0xED]
 * Auth:         challenge(a,b,c) → ((a+b)<<2)%255, ((b+c)<<2)%255, ((c+10)<<2)%255
 * 
 * Live packets: 11 bytes (or 22 for double):
 *   [header 4 bytes] [Xlo] [Xhi] [Ylo] [Yhi] [Plo] [Phi|status] [checksum]
 * 
 * Offline point records: 6 bytes each within page packages:
 *   [Xlo] [Xhi] [Ylo] [Yhi] [Plo] [Phi|status]
 *   pressure = ((byte5 & 0x1F) << 8) | byte4
 *   status   = byte5 >> 5
 * 
 * Checksum: sum(all_bytes_except_last) & 0xFF
 */

export const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const NOTIFY_UUID  = '0000ffe1-0000-1000-8000-00805f9b34fb';
export const WRITE_UUID   = '0000ffe2-0000-1000-8000-00805f9b34fb';

export const CMD = {
  VERIFY_CONNECT: 0x81,
  VERIFY_RESPONSE: 0x82,
  CURRENT_PAGE: 0x85,
  REQUEST_PAGE: 0x86,
  PAGE_PACKAGE: 0x87,
  REGET_PACKAGE: 0x88,
  NEXT_PAGE: 0x8A,       // unsolicited notebook button event
  DELETE_PAGE: 0x8B,
  CLEAR_CACHE: 0x8C,
  ONLINE_ENABLE: 0x8D,
  BATTERY: 0x8E,          // reply byte 3 = battery percent
  ROM_INFO: 0x8F,
  DEVICE_NAME: 0x91,      // reply is ASCII string
  MAX_INFO: 0x95,
  SET_PACKET_DISTANCE: 0x96,
} as const;

export function makeFrame(cmd: number, p1 = 0, p2 = 0, p3 = 0, p4 = 0): Uint8Array {
  return new Uint8Array([0xCD, cmd, 0x08, p1, p2, p3, p4, 0xED]);
}

export function verifyChecksum(data: Uint8Array): boolean {
  if (data.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < data.length - 1; i++) sum += data[i];
  return (sum & 0xFF) === data[data.length - 1];
}

export function computeAuthResponse(a: number, b: number, c: number): [number, number, number] {
  return [
    (((a + b) << 2) % 255),
    (((b + c) << 2) % 255),
    (((c + 10) << 2) % 255),
  ];
}

/** Huion app logical page size (HiConfig.DEFAULT_PAGE_WIDTH/HEIGHT for A5) */
export const HUION_DEFAULT_PAGE_WIDTH_A5 = 1409;
export const HUION_DEFAULT_PAGE_HEIGHT_A5 = 1869;
export const HUION_DEFAULT_PAGE_WIDTH_A4 = 2100;
export const HUION_DEFAULT_PAGE_HEIGHT_A4 = 2970;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
