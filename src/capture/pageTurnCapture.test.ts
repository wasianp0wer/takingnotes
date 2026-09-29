import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachPageTurnCapture } from '@/capture/pageTurnCapture';
import { createStubCaptureEngine } from '@/capture/pageTurnTestEngine';
import type { DeviceState } from '@/device/controller';
import { createFakeDeviceController, type FakeDeviceController } from '@/test/fakeDeviceController';

const LIVE: Partial<DeviceState> = {
  isConnected: true,
  isStreaming: true,
  deviceName: 'Fake Huion Note',
  status: 'Live streaming',
};

/** Lets pending promise callbacks (a rejected newPage, a startCapture) run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function lifecycle(controller: FakeDeviceController): string[] {
  return controller.calls.filter((c) => c === 'startCapture' || c === 'stopCapture');
}

function setup(initial: Partial<DeviceState> = {}) {
  const controller = createFakeDeviceController(initial);
  const engine = createStubCaptureEngine();
  const onError = vi.fn();
  const detach = attachPageTurnCapture({ controller, engine, onError });
  return { controller, engine, onError, detach };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachPageTurnCapture - capture lifecycle', () => {
  it('does not start capture while disconnected', () => {
    const { controller } = setup();
    expect(lifecycle(controller)).toEqual([]);
    expect(controller.isCapturing).toBe(false);
  });

  it('starts capture once when attached to a connected, streaming pad', () => {
    const { controller } = setup(LIVE);
    expect(lifecycle(controller)).toEqual(['startCapture']);
    expect(controller.isCapturing).toBe(true);
  });

  it('waits for streaming: connect alone is mid-handshake', async () => {
    const { controller } = setup();
    await controller.connect();
    expect(lifecycle(controller)).toEqual([]);
    await controller.startStreaming();
    expect(lifecycle(controller)).toEqual(['startCapture']);
  });

  it('does not start again on later state changes while capturing', () => {
    const { controller } = setup(LIVE);
    controller.setDeviceState({ storedPageCount: 4 });
    controller.setDeviceState({ status: 'Something else' });
    expect(lifecycle(controller)).toEqual(['startCapture']);
  });

  it('keeps capture running through a reconnect and does not restart it', () => {
    const { controller } = setup(LIVE);
    controller.setDeviceState({ isConnected: false, isStreaming: false, isReconnecting: true });
    controller.setDeviceState({ status: 'Reconnect attempt 2' });
    // Driver handshake done, streaming not yet restored.
    controller.setDeviceState({ isConnected: true, isReconnecting: false });
    controller.setDeviceState({ isStreaming: true });
    expect(lifecycle(controller)).toEqual(['startCapture']);
    expect(controller.isCapturing).toBe(true);
  });

  it('does not stop on the first emission of a two-step drop', async () => {
    // The real controller publishes an unexpected drop as two synchronous
    // emissions: onStatus('Disconnected') first, with isReconnecting still
    // false, and only then handleDrop()'s isReconnecting: true. Stopping on
    // the first one flips the controller's `capturing` off, so handleDrop()
    // returns early and auto-reconnect never starts.
    const { controller, onError } = setup(LIVE);
    controller.setDeviceState({ isConnected: false, isStreaming: false });
    controller.setDeviceState({ isReconnecting: true });
    await flush();

    expect(lifecycle(controller)).toEqual(['startCapture']);
    expect(controller.isCapturing).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops capture once when the reconnect gives up', async () => {
    const { controller } = setup(LIVE);
    controller.setDeviceState({ isConnected: false, isStreaming: false, isReconnecting: true });
    controller.setDeviceState({ isReconnecting: false });
    controller.setDeviceState({ status: 'Disconnected' });
    await flush();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture']);
  });

  it('restarts after a give-up and a manual reconnect', async () => {
    const { controller } = setup(LIVE);
    controller.setDeviceState({ isConnected: false, isStreaming: false, isReconnecting: true });
    controller.setDeviceState({ isReconnecting: false });
    await flush();
    await controller.connect();
    await controller.startStreaming();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture', 'startCapture']);
    expect(controller.isCapturing).toBe(true);
  });

  it('stops on a manual disconnect and starts again on the next connect', async () => {
    const { controller } = setup(LIVE);
    await controller.disconnect();
    await flush();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture']);
    await controller.connect();
    await controller.startStreaming();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture', 'startCapture']);
  });

  it('stops capture once on detach and then ignores the controller', () => {
    const { controller, engine, detach } = setup(LIVE);
    detach();
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture']);

    controller.emitPageTurn();
    controller.setDeviceState({ isConnected: false, isStreaming: false });
    controller.setDeviceState({ ...LIVE });
    expect(engine.newPageCalls).toEqual([]);
    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture']);
  });

  it('does not stop a capture it never started, and detach is idempotent', () => {
    const { controller, detach } = setup();
    detach();
    detach();
    expect(lifecycle(controller)).toEqual([]);
  });

  it('reports a stopCapture that throws instead of propagating it', () => {
    const { controller, onError, detach } = setup(LIVE);
    const failure = new Error('detector already gone');
    controller.stopCapture = () => {
      throw failure;
    };

    expect(() => detach()).not.toThrow();
    expect(onError).toHaveBeenCalledWith('stopCapture failed', failure);
  });

  it('attach, detach, attach (StrictMode) leaves one capture and one subscription', () => {
    const controller = createFakeDeviceController(LIVE);
    const engine = createStubCaptureEngine();
    const first = attachPageTurnCapture({ controller, engine, onError: vi.fn() });
    first();
    attachPageTurnCapture({ controller, engine, onError: vi.fn() });

    expect(lifecycle(controller)).toEqual(['startCapture', 'stopCapture', 'startCapture']);
    expect(controller.isCapturing).toBe(true);
    controller.emitPageTurn();
    expect(engine.newPageCalls).toEqual(['device-turn']);
  });
});

describe('attachPageTurnCapture - page turns', () => {
  it('turns into exactly one newPage("device-turn")', async () => {
    const { controller, engine } = setup(LIVE);
    await engine.startNote();

    controller.emitPageTurn({ storedPageCount: 3 });
    await flush();

    expect(engine.newPageCalls).toEqual(['device-turn']);
    expect(engine.getState().pageIndex).toBe(1);
  });

  it('forwards every turn, with no local dedupe', async () => {
    const { controller, engine } = setup(LIVE);
    await engine.startNote();

    controller.emitPageTurn();
    controller.emitPageTurn();
    await flush();

    expect(engine.newPageCalls).toEqual(['device-turn', 'device-turn']);
    expect(engine.getState().pageIndex).toBe(2);
  });

  it('a turn with no active note is harmless (A7)', async () => {
    const { controller, engine, onError } = setup(LIVE);

    controller.emitPageTurn();
    await flush();
    controller.emitPageTurn();
    await flush();

    expect(engine.newPageCalls).toEqual(['device-turn', 'device-turn']);
    expect(engine.getState().activeNoteId).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(controller.isCapturing).toBe(true);
  });

  it('reports a rejected newPage and keeps forwarding', async () => {
    const { controller, engine, onError } = setup(LIVE);
    await engine.startNote();
    const failure = new Error('disk full');
    engine.newPageImpl = () => Promise.reject(failure);

    controller.emitPageTurn();
    await flush();

    expect(onError).toHaveBeenCalledWith('newPage failed', failure);
    expect(controller.isCapturing).toBe(true);

    engine.newPageImpl = async () => 'page-x';
    controller.emitPageTurn();
    await flush();
    expect(engine.newPageCalls).toEqual(['device-turn', 'device-turn']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a newPage that throws synchronously', () => {
    const { controller, engine, onError } = setup(LIVE);
    const failure = new Error('boom');
    engine.newPageImpl = () => {
      throw failure;
    };

    expect(() => controller.emitPageTurn()).not.toThrow();
    expect(onError).toHaveBeenCalledWith('newPage failed', failure);
  });

  it('logs to console.error by default', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = createFakeDeviceController(LIVE);
    const engine = createStubCaptureEngine();
    const failure = new Error('disk full');
    engine.newPageImpl = () => Promise.reject(failure);
    attachPageTurnCapture({ controller, engine });

    controller.emitPageTurn();
    await flush();

    expect(spy).toHaveBeenCalledWith('[page-turn] newPage failed', failure);
  });
});

describe('attachPageTurnCapture - startCapture failures', () => {
  it('reports a rejected startCapture, cleans up, and retries on the next state change', async () => {
    const controller = createFakeDeviceController(LIVE);
    const engine = createStubCaptureEngine();
    const onError = vi.fn();
    const failure = new Error('not authenticated');
    const realStart = controller.startCapture;
    controller.startCapture = vi.fn(() => Promise.reject(failure));

    attachPageTurnCapture({ controller, engine, onError });
    await flush();

    expect(onError).toHaveBeenCalledWith('startCapture failed', failure);
    expect(controller.calls).toContain('stopCapture');

    controller.startCapture = vi.fn(realStart);
    controller.setDeviceState({ status: 'Live streaming again' });
    expect(controller.startCapture).toHaveBeenCalledTimes(1);
    await flush();
    expect(controller.isCapturing).toBe(true);
  });

  it('does not loop when startCapture throws and stopCapture emits', () => {
    const controller = createFakeDeviceController(LIVE);
    const onError = vi.fn();
    const start = vi.fn(() => {
      throw new Error('sync failure');
    });
    controller.startCapture = start;
    // The real controller's stopCapture publishes state; make the fake do so too.
    controller.stopCapture = () => controller.setDeviceState({ isReconnecting: false });

    attachPageTurnCapture({ controller, engine: createStubCaptureEngine(), onError });

    expect(start).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stops when the pad disconnects while startCapture is still pending', async () => {
    const controller = createFakeDeviceController(LIVE);
    const onError = vi.fn();
    let finishStart: () => void = () => {};
    controller.startCapture = vi.fn(
      () => new Promise<void>((resolve) => {
        finishStart = resolve;
      }),
    );

    attachPageTurnCapture({ controller, engine: createStubCaptureEngine(), onError });
    controller.setDeviceState({ isConnected: false, isStreaming: false });
    await flush();
    expect(lifecycle(controller)).toEqual(['stopCapture']);

    finishStart();
    await flush();
    expect(lifecycle(controller)).toEqual(['stopCapture']);
    expect(controller.startCapture).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a late startCapture failure after detach touches nothing', async () => {
    const controller = createFakeDeviceController(LIVE);
    const onError = vi.fn();
    let failStart: (error: unknown) => void = () => {};
    controller.startCapture = vi.fn(
      () => new Promise<void>((_resolve, reject) => {
        failStart = reject;
      }),
    );

    const detach = attachPageTurnCapture({ controller, engine: createStubCaptureEngine(), onError });
    detach();
    expect(lifecycle(controller)).toEqual(['stopCapture']);

    const failure = new Error('late');
    failStart(failure);
    await flush();

    expect(onError).toHaveBeenCalledWith('startCapture failed', failure);
    expect(lifecycle(controller)).toEqual(['stopCapture']);
    expect(controller.startCapture).toHaveBeenCalledTimes(1);
  });
});
