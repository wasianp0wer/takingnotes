import { afterEach, describe, expect, it, vi } from 'vitest';

import { BleHuionTransport } from '@/utils/huionTransport';

/**
 * Installs a minimal Web Bluetooth stub on `navigator` that is just complete
 * enough for `BleHuionTransport.open()` to walk its whole happy path.
 */
function stubBluetooth(identity: { name?: string; id?: string }) {
  const characteristic = {
    addEventListener: vi.fn(),
    startNotifications: vi.fn(async () => {}),
    writeValueWithoutResponse: vi.fn(async () => {}),
  };
  const service = { getCharacteristic: vi.fn(async () => characteristic) };
  const server = { getPrimaryService: vi.fn(async () => service) };
  const gatt = { connect: vi.fn(async () => server), disconnect: vi.fn() };
  const device = { ...identity, gatt, addEventListener: vi.fn() };

  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    writable: true,
    value: { requestDevice: vi.fn(async () => device) },
  });

  return { device, gatt };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'bluetooth');
});

describe('BleHuionTransport identity', () => {
  it('keeps the device name and id after close()', async () => {
    // `notebookUuid` is derived from `deviceId` and is the storage key for
    // everything downloaded from this device. Callers legitimately read it
    // AFTER the link has dropped (the driver's own disconnect handler reports
    // `deviceName`, and Phase 2 finalises a session once the device may
    // already be gone), so nulling `this.device` in close() must not regress
    // identity to 'Unknown'/'unknown' - that would key notes as
    // `huion:unknown`.
    const { gatt } = stubBluetooth({ name: 'Huion Note X10', id: 'dev-123' });
    const transport = new BleHuionTransport();

    expect(transport.deviceName).toBe('Unknown');
    expect(transport.deviceId).toBe('unknown');

    await transport.open();
    expect(transport.deviceName).toBe('Huion Note X10');
    expect(transport.deviceId).toBe('dev-123');

    await transport.close();

    expect(gatt.disconnect).toHaveBeenCalled();
    expect(transport.deviceName).toBe('Huion Note X10');
    expect(transport.deviceId).toBe('dev-123');
  });
});
