// Types shared by the main process, the preload and the renderer.
// Types only: `src/desktop/bridge.ts` imports this file with `import type`, so
// nothing here may import Electron or Node, or emit runtime code.

/** `process.platform` values, spelled out so the web build needs no Node types. */
export type DesktopPlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

/** Which browser API asked for a device: `navigator.bluetooth` or `navigator.hid`. */
export type ChooserKind = 'bluetooth' | 'hid';

export interface ChooserDevice {
  /** Electron's device id; the value `select` sends back. */
  id: string;
  /** Human-readable name; may be empty for an unnamed Bluetooth device. */
  name: string;
}

/**
 * Main → renderer. `open` starts a picker for a new request; `update` replaces
 * its device list (Bluetooth keeps scanning); `close` ends it, whether the user
 * picked, cancelled, or the main process gave up on it.
 */
export type ChooserMessage =
  | { type: 'open'; requestId: string; kind: ChooserKind; devices: ChooserDevice[] }
  | { type: 'update'; requestId: string; devices: ChooserDevice[] }
  | { type: 'close'; requestId: string };

/** The device-picker half of the bridge. */
export interface DesktopDevicesBridge {
  /** Subscribes to chooser messages; returns the unsubscribe function. */
  onChooser(fn: (msg: ChooserMessage) => void): () => void;
  /** The user picked `deviceId` for request `requestId`. */
  select(requestId: string, deviceId: string): void;
  /** The user dismissed the picker; `requestDevice()` rejects as in a browser. */
  cancel(requestId: string): void;
}

/** Exactly what `electron/preload.ts` exposes as `window.takingnotesDesktop`. */
export interface DesktopBridge {
  readonly platform: DesktopPlatform;
  readonly devices: DesktopDevicesBridge;
  /**
   * Whether anything answers HTTP at `<baseUrl>/api/tags`, asked from the main
   * process (no CORS). False for a network error, a 2 s timeout, or any URL
   * that isn't `http://localhost` / `http://127.0.0.1`.
   */
  probeOllama(baseUrl: string): Promise<boolean>;
  /**
   * Asks Chromium to start writing DOMStorage (localStorage) to disk, via
   * `session.defaultSession.flushStorageData()`, instead of waiting for its
   * lazy write. It starts the write; it does not guarantee it has landed.
   * Backup import awaits this before reloading, to shrink the window in
   * which a crash loses the new active-db pointer.
   */
  flushStorage(): Promise<void>;
}
