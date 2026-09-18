import { describe, expect, it, vi } from 'vitest';

import { createDeviceController } from '@/device/controller';
import { connectedFake, LIVE_PEN_DOWN_PACKET, withChecksum } from '@/test/huionFixtures';
import type { HuionPenPoint } from '@/utils/huionBLE';
import { HuionNoteBLE } from '@/utils/huionBLE';
import { CMD } from '@/utils/huionProtocol';

/**
 * The driver awaits `handleCommand` before it forwards a 0x8D frame to
 * `onPen`, so pen delivery lands a few microtasks after `transport.emit()`
 * returns (unlike the page-turn event, which is dispatched synchronously
 * inside `handleCommand`). One macrotask drains all of them.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** connectedFake() plus a settable stored-page count on the 0x85 reply. */
function pageCountFake(read: () => number) {
  const transport = connectedFake();
  transport.on(CMD.CURRENT_PAGE, () => [
    withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, read() & 0xff, (read() >> 8) & 0xff, 0, 0]),
  ]);
  return transport;
}

describe('device controller', () => {
  it('fans pen points out to every subscriber', async () => {
    // Driven by a real live packet through the fake transport rather than a
    // test-only emit seam: this is the test that actually covers the
    // `device.onPen = ...` wiring in controller.ts. Deleting that line must
    // fail this test.
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const preview = vi.fn();
    const recorder = vi.fn();
    controller.subscribePen(preview);
    controller.subscribePen(recorder);

    await controller.connect();
    transport.emit(LIVE_PEN_DOWN_PACKET);
    await flush();

    expect(preview).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledTimes(1);
    const point = preview.mock.calls[0][0] as HuionPenPoint;
    expect(point.status).toBe(1);
    expect(point.pressure).toBeGreaterThan(0);
    expect(recorder.mock.calls[0][0]).toEqual(point);
  });

  it('fans log lines out to every subscriber', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const first: string[] = [];
    const second: string[] = [];
    controller.subscribeLog((line) => first.push(line));
    const unsubscribeSecond = controller.subscribeLog((line) => second.push(line));

    await controller.connect();

    // The handshake alone logs several lines; both subscribers see all of them.
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);

    unsubscribeSecond();
    const before = second.length;
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));

    expect(first.length).toBeGreaterThan(before);
    expect(second).toHaveLength(before);
  });

  it('fans page turns out to every subscriber', async () => {
    // subscribePageTurn now delivers detector events, not the raw 0x8A
    // notification - so this drives the whole path: the notification only
    // hints the detector to poll sooner, and the poll interval here is set
    // far longer than the test so only that hint can possibly find the turn.
    let count = 0;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { pageTurn: { pollIntervalMs: 60_000 } },
    );
    const first = vi.fn();
    const second = vi.fn();
    controller.subscribePageTurn(first);
    controller.subscribePageTurn(second);

    await controller.connect();
    await controller.startCapture();
    count = 1;
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    await tick(50);
    controller.stopCapture();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reports connection state changes', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const states: boolean[] = [];
    controller.subscribeState((state) => states.push(state.isConnected));

    await controller.connect();
    transport.dropConnection();

    expect(states).toContain(true);
    expect(states[states.length - 1]).toBe(false);
  });

  it('stops delivering to an unsubscribed consumer', async () => {
    // Same detector-backed path as the fan-out test above (see its comment);
    // the count bump plus hint would deliver a page turn if `listener` were
    // still subscribed, which is what makes this test meaningful.
    let count = 0;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { pageTurn: { pollIntervalMs: 60_000 } },
    );
    const listener = vi.fn();
    const unsubscribe = controller.subscribePageTurn(listener);
    await controller.connect();
    await controller.startCapture();

    unsubscribe();
    count = 1;
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    await tick(50);
    controller.stopCapture();

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps delivering to the remaining subscriber after one unsubscribes', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const leaving = vi.fn();
    const staying = vi.fn();
    const unsubscribe = controller.subscribePen(leaving);
    controller.subscribePen(staying);
    await controller.connect();

    unsubscribe();
    transport.emit(LIVE_PEN_DOWN_PACKET);
    await flush();

    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });
});

describe('capture lifecycle', () => {
  it('emits page turns from the count poll with no 0x8A involved', async () => {
    let count = 0;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { pageTurn: { pollIntervalMs: 10 } },
    );
    const turns: number[] = [];
    controller.subscribePageTurn(() => turns.push(1));

    await controller.connect();
    await controller.startCapture();
    count = 2;
    await tick(80);
    controller.stopCapture();

    expect(turns).toHaveLength(1);
    expect(controller.getState().storedPageCount).toBe(2);
  });

  it('re-polls on reconnect so turns during the gap are found', async () => {
    let count = 0;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      // Poll interval far longer than the test: only the reconnect re-poll
      // can possibly find this turn, which is the point being proven.
      { pageTurn: { pollIntervalMs: 60_000 }, reconnect: { delaysMs: [10] } },
    );
    const turns: number[] = [];
    controller.subscribePageTurn(() => turns.push(1));

    await controller.connect();
    await controller.startCapture();
    transport.dropConnection();
    count = 3; // three page turns while the link was down
    await tick(400);
    controller.stopCapture();

    expect(turns).toHaveLength(1);
    expect(controller.getState().storedPageCount).toBe(3);
  });

  it('does not chase a drop that happened after stopCapture', async () => {
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { reconnect: { delaysMs: [10] } },
    );
    const logs: string[] = [];
    controller.subscribeLog((line) => logs.push(line));

    await controller.connect();
    await controller.startCapture();
    controller.stopCapture();
    transport.dropConnection();
    await tick(80);

    expect(logs.filter((l) => l.includes('Reconnect attempt'))).toEqual([]);
  });

  it('restores streaming end-to-end after a transport-level drop and reconnect', async () => {
    // Task 8: the reconnect machinery restoring the link is not enough - a
    // session that was streaming before the drop must be streaming again
    // after, with no separate user gesture. Goes through the whole stack
    // (reconnectPolicy -> device.reconnect()), not just the driver directly.
    // pageCountFake (not connectedFake) because startCapture() polls
    // CURRENT_PAGE - connectedFake has no responder for it and the poll
    // would hang to its own 5s timeout.
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { reconnect: { delaysMs: [10] } },
    );

    await controller.connect();
    await controller.startStreaming();
    await controller.startCapture();
    expect(controller.getState().isStreaming).toBe(true);

    transport.dropConnection();
    expect(controller.getState().isStreaming).toBe(false);
    // Handshake (~100ms, one real sleep) + streaming restore (~400ms, three
    // real sleeps) + margin for scheduling overhead.
    await tick(700);
    controller.stopCapture();

    expect(controller.getState().isConnected).toBe(true);
    expect(controller.getState().isStreaming).toBe(true);
  });

  it('does not start streaming after a reconnect if it was not active before the drop', async () => {
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { reconnect: { delaysMs: [10] } },
    );

    await controller.connect();
    await controller.startCapture();
    expect(controller.getState().isStreaming).toBe(false);

    transport.dropConnection();
    // Long enough to cover a full (mistaken) restore attempt too - handshake
    // (~100ms) + streaming setup sleeps (~400ms) - so an implementation that
    // wrongly restores unconditionally would be caught here, not hidden by
    // an assertion that ran before its sleeps finished.
    await tick(700);
    controller.stopCapture();

    expect(controller.getState().isConnected).toBe(true);
    expect(controller.getState().isStreaming).toBe(false);
    expect(transport.written.some((f) => f[1] === CMD.ONLINE_ENABLE)).toBe(false);
  });
});

describe('page count single-flight', () => {
  it('coalesces concurrent getStoredPageCount callers into one driver call', async () => {
    // The driver's own getStoredPageCount() is single-flight and throws on a
    // second concurrent call - this composition now has three independent
    // callers of it (detector poll, watchdog ping, this public method), so
    // without coalescing this would reject instead of resolving both.
    const count = 7;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    await controller.connect();

    const [a, b] = await Promise.all([
      controller.getStoredPageCount(),
      controller.getStoredPageCount(),
    ]);

    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(transport.written.filter((frame) => frame[1] === CMD.CURRENT_PAGE)).toHaveLength(1);
  });
});

describe('watchdog-detected drop', () => {
  it('clears isStreaming honestly on drop, then genuinely restores it on reconnect', async () => {
    // The link looks nominally connected (no transport-level disconnect) but
    // stops answering CURRENT_PAGE - exactly what the liveness watchdog
    // exists to catch, as opposed to a real drop (which the other tests in
    // this file cover via transport.dropConnection()).
    const transport = pageCountFake(() => 0);
    let failPing = false;
    const originalWrite = transport.write.bind(transport);
    transport.write = async (data: Uint8Array): Promise<void> => {
      if (failPing && data[1] === CMD.CURRENT_PAGE) {
        throw new Error('simulated unresponsive link');
      }
      await originalWrite(data);
    };

    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      {
        liveness: { idleMs: 0, checkIntervalMs: 10 },
        // Far longer than the test, so only the watchdog's own ping (via
        // CURRENT_PAGE) can possibly trip the failure - not the detector's
        // unrelated background poll.
        pageTurn: { pollIntervalMs: 60_000 },
        reconnect: { delaysMs: [10] },
      },
    );
    const states: { isConnected: boolean; isStreaming: boolean }[] = [];
    controller.subscribeState((s) => states.push({ isConnected: s.isConnected, isStreaming: s.isStreaming }));

    await controller.connect();
    await controller.startStreaming();
    await controller.startCapture();
    expect(controller.getState().isStreaming).toBe(true);

    // Only states from here on are relevant: the initial connect handshake
    // legitimately passes through isConnected: false (e.g. 'Handshaking...')
    // on its way up, which is not the drop this test is about.
    const baseline = states.length;

    failPing = true; // the link now looks connected but never answers a ping
    // Long enough for the watchdog to detect the silence, for at least one
    // full reconnect handshake (which includes a real 100ms sleep) to run to
    // completion, AND (Task 8) for the streaming-restore sequence that
    // follows a successful reconnect (~400ms of its own sleeps) to finish.
    // Because `failPing` never resets, the watchdog keeps re-killing the
    // link after each restore, so this window may catch more than one
    // drop/restore cycle - the assertions below only rely on "restore
    // happened at least once", not on where the window happens to end, so
    // that oscillation doesn't make the test flaky.
    await tick(900);
    controller.stopCapture();

    const afterCapture = states.slice(baseline);
    const dropIndex = afterCapture.findIndex((s) => s.isConnected === false);
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    // Right at the drop, isStreaming must already be false - not stale from
    // before the watchdog killed the link. This is the original bug this
    // test covered: a watchdog-detected drop that left `streaming` (and
    // therefore `isStreaming`) untouched, so reconnecting could report
    // streaming as still active with no pen data arriving.
    expect(afterCapture[dropIndex].isStreaming).toBe(false);
    // Task 8: streaming was active before the drop, so a successful
    // reconnect restores it - genuinely, by re-issuing the enable sequence,
    // not by leaving a stale flag. Proven two ways: the state eventually
    // reports isStreaming true again, and the enable frames were actually
    // written a second time (a stale-flag bug would flip the state without
    // ever writing anything new).
    expect(afterCapture.slice(dropIndex).some((s) => s.isStreaming === true)).toBe(true);
    const enableFrames = transport.written.filter((f) => f[1] === CMD.ONLINE_ENABLE);
    expect(enableFrames.length).toBeGreaterThanOrEqual(4);
  });
});
