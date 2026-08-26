import { describe, expect, it } from 'vitest';

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
