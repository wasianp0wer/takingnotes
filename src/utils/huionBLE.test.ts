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

describe('downloadPage', () => {
  it('requests the page it was asked for', async () => {
    const transport = connectedFake();
    transport.on(CMD.REQUEST_PAGE, () => [
      // Reply: zero packages -> an empty page, which the driver finishes immediately.
      withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 0, 0, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    const page = await device.downloadPage(3);

    const request = transport.written.find((frame) => frame[1] === CMD.REQUEST_PAGE);
    expect(request![3]).toBe(3);
    expect(page.pageNum).toBe(3);
    expect(page.strokes).toEqual([]);
  });

  it('rejects when not authenticated', async () => {
    const device = new HuionNoteBLE(new FakeHuionTransport());
    await expect(device.downloadPage(0)).rejects.toThrow();
  });

  it('leaves bulk download state untouched', async () => {
    const transport = connectedFake();
    transport.on(CMD.REQUEST_PAGE, () => [
      withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 0, 0, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    await device.downloadPage(1);
    await device.downloadPage(2);

    // A second single-page pull must not inherit the first one's buffers.
    const requests = transport.written.filter((frame) => frame[1] === CMD.REQUEST_PAGE);
    expect(requests.map((frame) => frame[3])).toEqual([1, 2]);
  });

  it('does not let page 1 data leak into page 2 (real package data, not just an empty page)', async () => {
    const transport = connectedFake();
    // Page 1 gets a real reply carrying two package frames with an actual
    // stroke; page 2 gets an empty reply. If page 2's decode somehow saw
    // page 1's leftover packages/expectedPackageCount, it would decode a
    // non-empty page instead of an empty one.
    transport.on(CMD.REQUEST_PAGE, (frame) => {
      if (frame[3] === 1) {
        return [
          withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 2, 0, 0, 0]),
          // pkg 1: one active point (x=1000,y=1000,pressure=4096,status=1)
          withChecksum([0xcd, CMD.PAGE_PACKAGE, 0x0c, 1, 0, 0xe8, 0x03, 0xe8, 0x03, 0x00, 0x30]),
          // pkg 2 (== expectedPackageCount): a second active point far
          // enough away to survive the distance filter and close the stroke.
          withChecksum([0xcd, CMD.PAGE_PACKAGE, 0x0c, 2, 0, 0x88, 0x13, 0x88, 0x13, 0x00, 0x30]),
        ];
      }
      return [withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 0, 0, 0, 0])];
    });
    const device = new HuionNoteBLE(transport);
    await device.connect();

    const page1 = await device.downloadPage(1);
    expect(page1.strokes.length).toBeGreaterThan(0);
    expect(page1.strokes[0].points.length).toBeGreaterThan(0);

    const page2 = await device.downloadPage(2);
    expect(page2.pageNum).toBe(2);
    expect(page2.strokes).toEqual([]);
  });

  it('is not hijacked by an unsolicited ROM_INFO/CURRENT_PAGE pair mid-pull', async () => {
    // The device is known to send unsolicited frames (CMD.NEXT_PAGE fires on
    // a physical page-turn button press), so an unsolicited ROM_INFO/
    // CURRENT_PAGE pair arriving mid single-page pull is plausible, not
    // contrived. The old implementation gated the bulk-orchestration
    // branches on `pageResolve` truthiness, and downloadPage() set a
    // placeholder pageResolve so those guards would pass - letting the pair
    // kick off a bulk restart at page 0 in the middle of the page-3 pull.
    //
    // Driven entirely via transport.emit() (bypassing the responder/
    // macrotask machinery) so the sequencing is deterministic rather than a
    // race between the page's own reply and the injected frames: each emit
    // call runs the driver's handling synchronously up to its next await,
    // so by the time one emit() returns, any write() it triggered has
    // already landed in `transport.written`.
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    await device.connect();

    const promise = device.downloadPage(3);
    // Page 3's own ack: 1 package expected, so the pull stays open (doesn't
    // finish on the ack alone) while the injected chatter below plays out.
    transport.emit(withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 1, 0, 0, 0]));

    // Unsolicited ROM_INFO arrives mid-pull...
    transport.emit(withChecksum([0xcd, CMD.ROM_INFO, 0x08, 0, 0, 0, 0]));
    // ...followed by its CURRENT_PAGE reply, reporting 5 pages stored. A
    // hijacked driver reacts to this by firing its own REQUEST_PAGE(0).
    transport.emit(withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 5, 0, 0, 0]));
    // The device's actual (delayed) ack for the real request, this time
    // carrying 0 packages. A hijacked driver instead treats this as the ack
    // for the REQUEST_PAGE(0) it fired itself, and resolves page 0.
    transport.emit(withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 0, 0, 0, 0]));

    const page = await promise;

    expect(page.pageNum).toBe(3);
    const requestPageFrames = transport.written.filter((frame) => frame[1] === CMD.REQUEST_PAGE);
    expect(requestPageFrames).toHaveLength(1);
    expect(requestPageFrames[0][3]).toBe(3);
  });

  it('rejects a concurrent downloadPages() instead of silently discarding it', async () => {
    // Reproduces the hang finding: downloadPages() used to share pageResolve
    // with downloadPage() with no mutual exclusion, so starting a bulk
    // download while a single-page pull was in flight would overwrite
    // pageResolve with the bulk resolver, which finishCurrentPageDownload's
    // singlePageResolve branch would then null out and never call - the
    // bulk caller (TabletPanel) would hang forever.
    const transport = connectedFake();
    transport.on(CMD.REQUEST_PAGE, () => [
      withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 0, 0, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    const singlePromise = device.downloadPage(1);
    await expect(device.downloadPages()).rejects.toThrow(/single/i);

    // The in-flight single-page pull must be unaffected and finish cleanly.
    const page = await singlePromise;
    expect(page.pageNum).toBe(1);

    // Back to idle: a real downloadPages() call now succeeds normally.
    transport.on(CMD.ROM_INFO, () => [
      withChecksum([0xcd, CMD.ROM_INFO, 0x08, 0, 0, 0, 0]),
    ]);
    transport.on(CMD.CURRENT_PAGE, () => [
      withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 0, 0, 0, 0]),
    ]);
    await expect(device.downloadPages()).resolves.toEqual([]);
  });

  it('rejects a concurrent downloadPage() while a bulk download is in flight', async () => {
    const transport = connectedFake();
    // No ROM_INFO/CURRENT_PAGE responders configured, so downloadPages()
    // stays pending on its own 15s timeout for the duration of this test -
    // long enough to assert the mutual exclusion without needing it to
    // resolve. Use fake timers so the test doesn't actually wait 15s.
    const device = new HuionNoteBLE(transport);
    await device.connect();

    vi.useFakeTimers();
    try {
      const bulkPromise = device.downloadPages();
      await expect(device.downloadPage(0)).rejects.toThrow(/bulk/i);
      // PAGE_DOWNLOAD_TIMEOUT_MS is private to huionBLE.ts; 15s matches it.
      await vi.advanceTimersByTimeAsync(15_000);
      await bulkPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wedge downloadMode when a continuation write fails mid-bulk-download', async () => {
    // The spec calls bulk download "flaky", so a transient BLE write
    // failure partway through is realistic. This targets the
    // CURRENT_PAGE handler's requestPageDownload(0) write - one of three
    // continuation writes (triggered from inside handleCommand, not from
    // a method's own initial call) that used to propagate up to the
    // generic notification-handler catch and get silently logged,
    // leaving downloadMode stuck at 'bulk' with nothing left to reset it
    // short of the download's own (possibly very long, for a multi-page
    // walk) scaled timeout.
    const transport = connectedFake();
    transport.on(CMD.ROM_INFO, () => [
      withChecksum([0xcd, CMD.ROM_INFO, 0x08, 0, 0, 0, 0]),
    ]);
    transport.on(CMD.CURRENT_PAGE, () => [
      // 3 pages stored, so the resulting scaled timeout (3 * 15s) is far
      // longer than this test should ever need to wait.
      withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 3, 0, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    const originalWrite = transport.write.bind(transport);
    transport.write = (data: Uint8Array) => {
      if (data[1] === CMD.REQUEST_PAGE) {
        return Promise.reject(new Error('simulated BLE write failure'));
      }
      return originalWrite(data);
    };

    vi.useFakeTimers();
    try {
      const bulkPromise = device.downloadPages();
      // Cascade: ROM_INFO ack -> write(CURRENT_PAGE) -> CURRENT_PAGE ack ->
      // requestPageDownload(0)'s REQUEST_PAGE write, which fails.
      await vi.advanceTimersByTimeAsync(100);

      // Checked first, so a regression fails fast (a rejection) instead of
      // hanging until the 5s test timeout: downloadMode must actually have
      // been released by the failed continuation write, not just the
      // original bulk download's own promise. A subsequent single-page
      // pull must succeed rather than be rejected as "already in progress".
      transport.write = originalWrite;
      transport.on(CMD.REQUEST_PAGE, () => [
        withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 0, 0, 0, 0]),
      ]);
      const pagePromise = device.downloadPage(0);
      // Still under fake timers - this pull's own REQUEST_PAGE reply is
      // scheduled via setTimeout(0) too, so it needs its own advance.
      await vi.advanceTimersByTimeAsync(100);
      const page = await pagePromise;
      expect(page.pageNum).toBe(0);

      // The original in-flight bulk download must also have settled (with
      // partial data, the existing convention) rather than being left to
      // hang until its full 45s scaled timeout.
      await expect(bulkPromise).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
