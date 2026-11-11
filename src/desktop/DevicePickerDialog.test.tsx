import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChooserMessage, DesktopBridge } from '@/desktop/bridge';
import { DevicePickerDialog } from '@/desktop/DevicePickerDialog';
import { fakeDesktopBridge, type FakeDesktopBridge } from '@/test/fakeDesktopBridge';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

type FakeBridge = FakeDesktopBridge;
const fakeBridge = fakeDesktopBridge;

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

const dialog = () => document.querySelector('[role="dialog"]');
const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;

async function emit(fake: FakeBridge, msg: ChooserMessage): Promise<void> {
  await act(async () => fake.emit(msg));
}

describe('DevicePickerDialog', () => {
  it('renders nothing in web build', async () => {
    await act(async () => root.render(<DevicePickerDialog bridge={null} />));
    expect(container.innerHTML).toBe('');
    expect(dialog()).toBeNull();
  });

  it('subscribes once on mount and unsubscribes on unmount', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    expect(fake.listeners.size).toBe(1);
    act(() => root.unmount());
    expect(fake.listeners.size).toBe(0);
    root = createRoot(container);
  });

  it('lists devices as they arrive', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    expect(dialog()).toBeNull();

    await emit(fake, { type: 'open', requestId: 'r1', kind: 'bluetooth', devices: [] });
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('Choose a tablet');
    expect(dialog()!.textContent).toContain('Searching…');

    await emit(fake, { type: 'update', requestId: 'r1', devices: [{ id: 'a', name: 'Huion Note' }] });
    expect(dialog()!.textContent).toContain('Huion Note');
    expect(dialog()!.textContent).not.toContain('Searching…');

    await emit(fake, {
      type: 'update',
      requestId: 'r1',
      devices: [
        { id: 'a', name: 'Huion Note' },
        { id: 'b', name: 'Wacom Slate' },
      ],
    });
    expect(dialog()!.textContent).toContain('Wacom Slate');

    // A stale request's update is ignored.
    await emit(fake, { type: 'update', requestId: 'old', devices: [] });
    expect(dialog()!.textContent).toContain('Wacom Slate');
  });

  it('titles a HID request "Choose a USB device"', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    await emit(fake, { type: 'open', requestId: 'h1', kind: 'hid', devices: [{ id: 'u', name: 'Huion H640P' }] });
    expect(dialog()!.textContent).toContain('Choose a USB device');
    expect(dialog()!.textContent).toContain('Huion H640P');
  });

  it('names an unnamed device', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    await emit(fake, { type: 'open', requestId: 'r1', kind: 'bluetooth', devices: [{ id: 'x', name: '' }] });
    expect(buttonByText('Unnamed device')).not.toBeNull();
  });

  it('select sends the id', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    await emit(fake, { type: 'open', requestId: 'r1', kind: 'bluetooth', devices: [{ id: 'a', name: 'Huion Note' }] });
    await act(async () => buttonByText('Huion Note')!.click());
    expect(fake.select).toHaveBeenCalledTimes(1);
    expect(fake.select).toHaveBeenCalledWith('r1', 'a');
    expect(dialog()).toBeNull();
    // Main then confirms with close; still no cancel.
    await emit(fake, { type: 'close', requestId: 'r1' });
    expect(fake.cancel).not.toHaveBeenCalled();
  });

  it('escape cancels', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    await emit(fake, { type: 'open', requestId: 'r1', kind: 'bluetooth', devices: [] });
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(fake.cancel).toHaveBeenCalledWith('r1');
    expect(fake.select).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    await emit(fake, { type: 'close', requestId: 'r1' });
    expect(fake.cancel).toHaveBeenCalledTimes(1);
  });

  it('the Cancel button cancels once', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    await emit(fake, { type: 'open', requestId: 'r1', kind: 'hid', devices: [{ id: 'u', name: 'Pad' }] });
    await act(async () => buttonByText('Cancel')!.click());
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(fake.cancel).toHaveBeenCalledWith('r1');
    expect(dialog()).toBeNull();
  });

  it('an outside click cancels once', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    await emit(fake, { type: 'open', requestId: 'r1', kind: 'bluetooth', devices: [] });
    // Radix's outside-pointer listener is attached on a timeout after opening.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // A real primary-button click on the overlay: Radix defers the dismissal
    // from pointerdown to the click that follows, then a timeout.
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    await act(async () => {
      overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      overlay.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
      overlay.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(fake.cancel).toHaveBeenCalledWith('r1');
    expect(dialog()).toBeNull();
  });

  it('a close from main hides the dialog without cancelling', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    await emit(fake, { type: 'open', requestId: 'r1', kind: 'bluetooth', devices: [] });
    await emit(fake, { type: 'close', requestId: 'r1' });
    expect(dialog()).toBeNull();
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(fake.select).not.toHaveBeenCalled();
  });

  it('a newer open replaces the old request, and a stale close leaves it open', async () => {
    const fake = fakeBridge();
    await act(async () => root.render(<DevicePickerDialog bridge={fake.bridge} />));
    await emit(fake, { type: 'open', requestId: 'r1', kind: 'bluetooth', devices: [] });
    await emit(fake, { type: 'close', requestId: 'r1' });
    await emit(fake, { type: 'open', requestId: 'r2', kind: 'hid', devices: [{ id: 'u', name: 'Pad' }] });
    await emit(fake, { type: 'close', requestId: 'r1' });
    expect(dialog()!.textContent).toContain('Choose a USB device');
    await act(async () => buttonByText('Pad')!.click());
    expect(fake.select).toHaveBeenCalledWith('r2', 'u');
  });

  it('uses the window bridge by default', async () => {
    const fake = fakeBridge();
    (window as Window & { takingnotesDesktop?: DesktopBridge }).takingnotesDesktop = fake.bridge;
    try {
      await act(async () => root.render(<DevicePickerDialog />));
      expect(fake.listeners.size).toBe(1);
    } finally {
      delete (window as Window & { takingnotesDesktop?: DesktopBridge }).takingnotesDesktop;
    }
  });
});
