import { describe, expect, it, vi } from 'vitest';

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

  it('does not leave a stale resolver that can swallow a download\'s own CURRENT_PAGE reply', async () => {
    // Reproduces the bug the timeout-and-resolver-leak fix addresses: a
    // failed write must not leave `pageCountResolve` set, because a later,
    // unrelated CURRENT_PAGE reply (e.g. downloadPages()'s own query) would
    // be intercepted by it and never reach the download's own handling -
    // downloadPages() would then silently fall back to its much longer
    // (15s+) timeout instead of resolving as soon as its reply lands.
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    await device.connect();

    const originalWrite = transport.write.bind(transport);
    transport.write = () => Promise.reject(new Error('write failed'));
    await expect(device.getStoredPageCount()).rejects.toThrow('write failed');
    transport.write = originalWrite;

    // Device reports zero stored pages, so a healthy downloadPages() call
    // resolves as soon as its CURRENT_PAGE reply arrives, well before any
    // timeout fires.
    transport.on(CMD.ROM_INFO, () => [
      withChecksum([0xcd, CMD.ROM_INFO, 0x08, 0, 0, 0, 0]),
    ]);
    transport.on(CMD.CURRENT_PAGE, () => [
      withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 0, 0, 0, 0]),
    ]);

    vi.useFakeTimers();
    try {
      const downloadPromise = device.downloadPages();
      // Flush the macrotasks FakeHuionTransport uses to deliver the ROM_INFO
      // reply and then the CURRENT_PAGE reply it triggers - both scheduled
      // via setTimeout(fn, 0), well short of any real timeout.
      await vi.advanceTimersByTimeAsync(50);

      let settled = false;
      void downloadPromise.then(() => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(true);
      await expect(downloadPromise).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its pending resolver when the write fails', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    await device.connect();

    // Make the next write fail, simulating a transport-level error.
    const originalWrite = transport.write.bind(transport);
    transport.write = () => Promise.reject(new Error('write failed'));

    await expect(device.getStoredPageCount()).rejects.toThrow('write failed');

    // Restore a working write and arm a CURRENT_PAGE reply. A stale resolver
    // from the failed call above would be overwritten by this fresh call
    // regardless of the fix, but this still guards against the resolver
    // being left in a state that throws or rejects on the next legitimate
    // query.
    transport.write = originalWrite;
    transport.on(CMD.CURRENT_PAGE, () => [
      withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 9, 0, 0, 0]),
    ]);

    expect(await device.getStoredPageCount()).toBe(9);
  });
});
