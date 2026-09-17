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
});
