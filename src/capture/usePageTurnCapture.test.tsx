import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createStubCaptureEngine, type StubCaptureEngine } from '@/capture/pageTurnTestEngine';
import { usePageTurnCapture } from '@/capture/usePageTurnCapture';
import { createFakeDeviceController, type FakeDeviceController } from '@/test/fakeDeviceController';

// TabletProvider always builds a real controller, so the hook's only way to
// the device is mocked to hand out the fake instead.
const device = vi.hoisted(() => ({ controller: null as FakeDeviceController | null }));

vi.mock('@/device/TabletProvider', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useHuionDevice() {
      const controller = device.controller!;
      const state = useSyncExternalStore(controller.subscribeState, controller.getState);
      return { controller, state };
    },
  };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let controller: FakeDeviceController;
let engine: StubCaptureEngine;
let renders = 0;

function Host() {
  renders++;
  usePageTurnCapture();
  return null;
}

function render({ strict = false } = {}) {
  const tree = (
    <CaptureProvider engine={engine}>
      <Host />
    </CaptureProvider>
  );
  act(() => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

function lifecycle(): string[] {
  return controller.calls.filter((c) => c === 'startCapture' || c === 'stopCapture');
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  controller = createFakeDeviceController({
    isConnected: true,
    isStreaming: true,
    status: 'Live streaming',
  });
  device.controller = controller;
  engine = createStubCaptureEngine();
  renders = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('usePageTurnCapture', () => {
  it('starts capture and turns a device page turn into a new page', async () => {
    render();
    await act(async () => {
      await engine.startNote();
    });

    await act(async () => {
      controller.emitPageTurn({ storedPageCount: 2 });
    });

    expect(lifecycle()).toEqual(['startCapture']);
    expect(engine.newPageCalls).toEqual(['device-turn']);
  });

  it('under StrictMode, one turn makes exactly one page and capture is running', async () => {
    render({ strict: true });
    await act(async () => {
      await engine.startNote();
    });

    await act(async () => {
      controller.emitPageTurn();
    });

    expect(engine.newPageCalls).toEqual(['device-turn']);
    expect(controller.isCapturing).toBe(true);
    expect(lifecycle().at(-1)).toBe('startCapture');
  });

  it('stops capture on unmount', () => {
    render();
    act(() => root.unmount());
    expect(lifecycle()).toEqual(['startCapture', 'stopCapture']);
    expect(controller.isCapturing).toBe(false);
    // afterEach unmounts again; give it a fresh root to unmount.
    root = createRoot(container);
  });

  it('does not re-attach when device state re-renders the host', () => {
    render();
    const before = renders;

    act(() => controller.setDeviceState({ storedPageCount: 5 }));
    act(() => controller.setDeviceState({ status: 'Still streaming' }));

    expect(renders).toBeGreaterThan(before);
    expect(lifecycle()).toEqual(['startCapture']);
  });
});
