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
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const first = vi.fn();
    const second = vi.fn();
    controller.subscribePageTurn(first);
    controller.subscribePageTurn(second);

    await controller.connect();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));

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
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const listener = vi.fn();
    const unsubscribe = controller.subscribePageTurn(listener);
    await controller.connect();

    unsubscribe();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));

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
