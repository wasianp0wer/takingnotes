import { describe, expect, it, vi } from 'vitest';

import { attachPageTurnCapture } from '@/capture/pageTurnCapture';
import { createStubCaptureEngine } from '@/capture/pageTurnTestEngine';
import { createDeviceController } from '@/device/controller';
import { connectedFake, withChecksum } from '@/test/huionFixtures';
import { HuionNoteBLE } from '@/utils/huionBLE';
import { CMD } from '@/utils/huionProtocol';

/**
 * F4 against the *real* `createDeviceController`, because the drop sequence the
 * lifecycle rules hinge on only exists there: `onStatus('Disconnected')`
 * publishes `{ isConnected: false, isReconnecting: false }` synchronously and
 * `handleDrop()` publishes `isReconnecting: true` immediately after. A stop on
 * that first emission flips the controller's `capturing` off, `handleDrop()`
 * returns early, and the reconnect chase never starts - which no test driven by
 * the fake controller can notice, because the fake has no `handleDrop`.
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** connectedFake() plus a stored-page count on the 0x85 reply, as startCapture polls it. */
function pageCountFake(read: () => number) {
  const transport = connectedFake();
  transport.on(CMD.CURRENT_PAGE, () => [
    withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, read() & 0xff, (read() >> 8) & 0xff, 0, 0]),
  ]);
  return transport;
}

async function liveController() {
  const transport = pageCountFake(() => 0);
  const controller = createDeviceController(
    () => new HuionNoteBLE(transport),
    // Poll interval far longer than the test: nothing here depends on the
    // detector's own tick, only on the lifecycle calls F4 makes.
    { reconnect: { delaysMs: [10] }, pageTurn: { pollIntervalMs: 60_000 } },
  );
  await controller.connect();
  await controller.startStreaming();
  return { transport, controller };
}

describe('attachPageTurnCapture against the real device controller', () => {
  it('leaves the reconnect chase armed on a transport-level drop', async () => {
    const { transport, controller } = await liveController();
    const stopCapture = vi.fn(controller.stopCapture);
    controller.stopCapture = stopCapture;
    const onError = vi.fn();
    const detach = attachPageTurnCapture({
      controller,
      engine: createStubCaptureEngine(),
      onError,
    });
    await flush();

    transport.dropConnection();
    await flush();

    expect(controller.getState().isReconnecting).toBe(true);
    expect(stopCapture).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    detach();
    expect(stopCapture).toHaveBeenCalledTimes(1);
  });

  it('keeps the same capture across a successful reconnect', async () => {
    const { transport, controller } = await liveController();
    const startCapture = vi.fn(controller.startCapture);
    const stopCapture = vi.fn(controller.stopCapture);
    controller.startCapture = startCapture;
    controller.stopCapture = stopCapture;
    const detach = attachPageTurnCapture({
      controller,
      engine: createStubCaptureEngine(),
      onError: vi.fn(),
    });
    await flush();
    expect(startCapture).toHaveBeenCalledTimes(1);

    transport.dropConnection();
    // Handshake (~100ms) plus the streaming restore's own sleeps (~400ms).
    await tick(700);

    expect(controller.getState().isConnected).toBe(true);
    expect(controller.getState().isStreaming).toBe(true);
    expect(controller.getState().isReconnecting).toBe(false);
    // Capture was never given up, so it is never started a second time.
    expect(stopCapture).not.toHaveBeenCalled();
    expect(startCapture).toHaveBeenCalledTimes(1);

    detach();
  });

  it('forwards a real 0x8A-triggered page turn to the engine', async () => {
    // Guards the wiring end to end: the turn comes from a real CMD.NEXT_PAGE
    // (0x8A) frame through the controller's own direct-emit path (K28), not
    // from a test-only emit seam. Phase 1/2's count-rise mechanism this test
    // used to drive is gone (K29): the pad does not commit pages to ROM
    // while streaming, so a bare count change - as below, left at 0 - no
    // longer matters here at all.
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { pageTurn: { pollIntervalMs: 60_000 } },
    );
    await controller.connect();
    await controller.startStreaming();
    const engine = createStubCaptureEngine();
    const detach = attachPageTurnCapture({ controller, engine, onError: vi.fn() });
    await flush();
    await engine.startNote();

    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    await flush();
    detach();

    expect(engine.newPageCalls).toEqual(['device-turn']);
    expect(engine.getState().pageIndex).toBe(1);
  });
});
