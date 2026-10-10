import { describe, expect, it, vi } from 'vitest';

import { createFakeDeviceController } from '@/test/fakeDeviceController';

describe('fake device controller', () => {
  it('starts disconnected and idle', () => {
    const fake = createFakeDeviceController();
    expect(fake.getState()).toEqual({
      isConnected: false,
      isStreaming: false,
      isReconnecting: false,
      deviceName: '',
      status: 'Disconnected',
      storedPageCount: 0,
      batteryPercent: null,
    });
  });

  it('flips state through the connect/stream lifecycle and records the calls', async () => {
    const fake = createFakeDeviceController();

    await fake.connect();
    expect(fake.getState().isConnected).toBe(true);
    expect(fake.getState().deviceName).toBeTruthy();

    await fake.startStreaming();
    expect(fake.getState().isStreaming).toBe(true);

    await fake.stopStreaming();
    expect(fake.getState().isStreaming).toBe(false);

    await fake.disconnect();
    expect(fake.getState()).toMatchObject({ isConnected: false, status: 'Disconnected' });
    expect(fake.calls).toEqual([
      'connect',
      'startStreaming',
      'stopStreaming',
      'disconnect',
    ]);
  });

  it('notifies state subscribers with a fresh object and stops on unsubscribe', async () => {
    const fake = createFakeDeviceController();
    const seen = vi.fn();
    const unsubscribe = fake.subscribeState(seen);

    await fake.connect();
    expect(seen).toHaveBeenCalledTimes(1);
    // useSyncExternalStore needs a *stable* reference between updates and a new
    // one after each change, or the shell either loops or never re-renders.
    expect(seen.mock.calls[0][0]).toBe(fake.getState());

    unsubscribe();
    fake.setDeviceState({ status: 'Anything' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('emits pen points with live-capture defaults', () => {
    const fake = createFakeDeviceController();
    const points = vi.fn();
    fake.subscribePen(points);

    const emitted = fake.emitPen({ x: 0.25, y: 0.75 });

    expect(points).toHaveBeenCalledWith(emitted);
    expect(emitted).toMatchObject({ x: 0.25, y: 0.75, status: 1 });
    expect(emitted.pressure).toBeGreaterThan(0);
    expect(emitted.timestamp).toBeGreaterThan(0);

    const up = fake.emitPen({ x: 0.25, y: 0.75, status: 0, pressure: 0 });
    expect(up.status).toBe(0);
    expect(points).toHaveBeenCalledTimes(2);
  });

  it('emits page turns and log lines to every subscriber', () => {
    const fake = createFakeDeviceController();
    const first = vi.fn();
    const second = vi.fn();
    fake.subscribePageTurn(first);
    fake.subscribePageTurn(second);
    const lines: string[] = [];
    fake.subscribeLog((line) => lines.push(line));

    fake.emitPageTurn();
    fake.emitLog('hello');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['hello']);
  });

  it('reports a settable stored page count', async () => {
    const fake = createFakeDeviceController();
    fake.setStoredPageCount(12);

    expect(await fake.getStoredPageCount()).toBe(12);
    // startCapture publishes the count the same way the real controller does.
    await fake.startCapture();
    expect(fake.getState().storedPageCount).toBe(12);
    expect(fake.isCapturing).toBe(true);

    fake.stopCapture();
    expect(fake.isCapturing).toBe(false);
  });

  it('emits a page turn with the count a turn would have produced', async () => {
    const fake = createFakeDeviceController();
    fake.setStoredPageCount(3);
    const turns = vi.fn();
    fake.subscribePageTurn(turns);

    fake.emitPageTurn({ storedPageCount: 4 });

    expect(turns).toHaveBeenCalledTimes(1);
    expect(fake.getState().storedPageCount).toBe(4);
    expect(await fake.getStoredPageCount()).toBe(4);
  });

  it('hands back an empty page from downloadPage', async () => {
    const fake = createFakeDeviceController();
    expect(await fake.downloadPage(2)).toEqual({ pageNum: 2, strokes: [] });
  });

  it('starts from an overridden state', () => {
    const fake = createFakeDeviceController({ isConnected: true, storedPageCount: 5 });
    expect(fake.getState()).toMatchObject({ isConnected: true, storedPageCount: 5 });
  });
});
