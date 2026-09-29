import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeviceStatus } from '@/app/DeviceStatus';
import { createFakeDeviceController } from '@/test/fakeDeviceController';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * Re-renders with the controller's current state, which is what `AppShell` does
 * for real through `useHuionDevice()`'s `useSyncExternalStore`.
 */
function renderStatus(fake: ReturnType<typeof createFakeDeviceController>) {
  const draw = () => {
    act(() => {
      root.render(<DeviceStatus controller={fake} state={fake.getState()} />);
    });
  };
  fake.subscribeState(draw);
  draw();
}

function button(): HTMLButtonElement {
  const found = container.querySelector('button');
  if (!found) throw new Error('no button rendered');
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('DeviceStatus', () => {
  it('offers Connect while disconnected', () => {
    renderStatus(createFakeDeviceController());
    expect(button().textContent).toBe('Connect');
    expect(container.textContent).toContain('Not connected');
  });

  it('connects and starts streaming in that order', async () => {
    const fake = createFakeDeviceController();
    renderStatus(fake);

    await click(button());

    // Connecting without streaming looks connected but captures no pen input.
    expect(fake.calls).toEqual(['connect', 'startStreaming']);
    expect(button().textContent).toBe('Disconnect');
    expect(container.textContent).toContain('Fake Huion Note');
  });

  it('shows the stored page count while connected', async () => {
    const fake = createFakeDeviceController();
    fake.setStoredPageCount(7);
    renderStatus(fake);

    await click(button());
    fake.setDeviceState({ storedPageCount: 7 });

    expect(container.textContent).toContain('7 pages on device');
  });

  it('disconnects when connected', async () => {
    const fake = createFakeDeviceController({
      isConnected: true,
      deviceName: 'Huion Note',
      status: 'Live streaming',
    });
    renderStatus(fake);

    await click(button());

    expect(fake.calls).toEqual(['disconnect']);
    expect(button().textContent).toBe('Connect');
  });

  it('reports a reconnect in progress', () => {
    const fake = createFakeDeviceController();
    renderStatus(fake);

    act(() => fake.setDeviceState({ isReconnecting: true, status: 'Reconnect attempt 1' }));

    expect(container.textContent).toContain('Reconnecting...');
    expect(container.textContent).toContain('Reconnect attempt 1');
  });

  it('surfaces a failed connect instead of doing nothing', async () => {
    const fake = createFakeDeviceController();
    // The common case: the user dismisses the browser's Bluetooth chooser.
    fake.connect = () => Promise.reject(new Error('User cancelled the requestDevice() chooser'));
    renderStatus(fake);

    await click(button());

    expect(container.textContent).toContain('User cancelled');
    expect(button().textContent).toBe('Connect');
  });
});
