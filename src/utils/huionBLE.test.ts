import { describe, expect, it } from 'vitest';

import { FakeHuionTransport } from '@/test/fakeHuionTransport';
import { connectedFake, withChecksum } from '@/test/huionFixtures';
import { HuionNoteBLE } from '@/utils/huionBLE';
import { CMD, computeAuthResponse } from '@/utils/huionProtocol';

describe('HuionNoteBLE handshake', () => {
  it('replies to the auth challenge with the computed response', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);

    await device.connect();

    const reply = transport.written.find((frame) => frame[1] === CMD.VERIFY_RESPONSE);
    expect(reply).toBeDefined();
    const [r1, r2, r3] = computeAuthResponse(1, 2, 3);
    expect([reply![3], reply![4], reply![5]]).toEqual([r1, r2, r3]);
    expect(device.isConnected).toBe(true);
  });

  it('exposes a notebook uuid derived from the device id', async () => {
    const device = new HuionNoteBLE(connectedFake());
    await device.connect();
    expect(device.notebookUuid).toBe('huion:fake-device-id');
  });

  it('reports disconnected when the transport drops', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    await device.connect();

    transport.dropConnection();

    expect(device.isConnected).toBe(false);
  });

  it('forwards the page-turn button event', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    let turns = 0;
    device.onNextPage = () => { turns += 1; };
    await device.connect();

    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));

    expect(turns).toBe(1);
  });
});

describe('getStoredPageCount', () => {
  it('returns the page count the device reports', async () => {
    const transport = connectedFake();
    // 0x85 reply carries the count at bytes 3-4, little-endian.
    transport.on(CMD.CURRENT_PAGE, () => [
      withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 7, 0, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    expect(await device.getStoredPageCount()).toBe(7);
  });

  it('decodes a count above 255 from both bytes', async () => {
    const transport = connectedFake();
    // 300 = 0x012C -> low byte 0x2C, high byte 0x01
    transport.on(CMD.CURRENT_PAGE, () => [
      withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 0x2c, 0x01, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    expect(await device.getStoredPageCount()).toBe(300);
  });

  it('rejects when not authenticated', async () => {
    const device = new HuionNoteBLE(new FakeHuionTransport());
    await expect(device.getStoredPageCount()).rejects.toThrow();
  });
});
