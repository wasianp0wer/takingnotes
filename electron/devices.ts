// The in-app device chooser's state machine. Pure: Electron's
// `select-bluetooth-device` / `select-hid-device` handlers in main.ts feed it,
// and `send` forwards its messages to the renderer's picker dialog.
import { randomUUID } from 'node:crypto';
import type { ChooserDevice, ChooserKind, ChooserMessage } from './types';

/** Electron's chooser callback: a device id, or `''` to cancel the request. */
export type ChooserCallback = (deviceId: string) => void;

export interface DeviceChooser {
  /** Starts a new request. Any request still pending is cancelled first. */
  open(kind: ChooserKind, devices: ChooserDevice[], callback: ChooserCallback): void;
  /** Replaces the pending request's device list. No-op when nothing is pending. */
  update(devices: ChooserDevice[]): void;
  /**
   * One `select-*-device` event. Electron fires `select-bluetooth-device` again
   * and again for one `requestDevice()` while it scans: the first event opens a
   * request, later ones (same kind, still pending) update it and keep the
   * newest callback.
   */
  offer(kind: ChooserKind, devices: ChooserDevice[], callback: ChooserCallback): void;
  /** The user picked `deviceId`. Ignored for a stale request or an unlisted device. */
  select(requestId: string, deviceId: string): void;
  /** The user dismissed the picker: Electron gets `''`. Ignored for a stale request. */
  cancel(requestId: string): void;
  /** Cancels whatever is pending (the window is going away or reloading). */
  cancelPending(): void;
  /** The pending request's kind, or null. */
  pendingKind(): ChooserKind | null;
}

interface PendingRequest {
  requestId: string;
  kind: ChooserKind;
  devices: ChooserDevice[];
  callback: ChooserCallback;
}

export function createDeviceChooser(
  send: (msg: ChooserMessage) => void,
  newId: () => string = randomUUID,
): DeviceChooser {
  let pending: PendingRequest | null = null;

  /** Ends the pending request: answers Electron once and tells the renderer to close. */
  function finish(deviceId: string): void {
    if (!pending) return;
    const { requestId, callback } = pending;
    pending = null;
    callback(deviceId);
    send({ type: 'close', requestId });
  }

  const chooser: DeviceChooser = {
    open(kind, devices, callback) {
      finish('');
      pending = { requestId: newId(), kind, devices: [...devices], callback };
      send({ type: 'open', requestId: pending.requestId, kind, devices: [...devices] });
    },
    update(devices) {
      if (!pending) return;
      pending.devices = [...devices];
      send({ type: 'update', requestId: pending.requestId, devices: [...devices] });
    },
    offer(kind, devices, callback) {
      if (pending && pending.kind === kind) {
        pending.callback = callback;
        chooser.update(devices);
      } else {
        chooser.open(kind, devices, callback);
      }
    },
    select(requestId, deviceId) {
      if (!pending || pending.requestId !== requestId) return;
      if (!pending.devices.some((device) => device.id === deviceId)) return;
      finish(deviceId);
    },
    cancel(requestId) {
      if (!pending || pending.requestId !== requestId) return;
      finish('');
    },
    cancelPending() {
      finish('');
    },
    pendingKind() {
      return pending?.kind ?? null;
    },
  };
  return chooser;
}
