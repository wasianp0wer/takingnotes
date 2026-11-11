// The desktop shell's preload bridge, as the renderer sees it. In the web build
// there is no `window.takingnotesDesktop` and every caller gets null, so the
// browser's own pickers and prompts are used. Type-only import: no Electron
// code reaches the web bundle.
import type { DesktopBridge } from '../../electron/types';

export type {
  ChooserDevice,
  ChooserKind,
  ChooserMessage,
  DesktopBridge,
  DesktopDevicesBridge,
  DesktopPlatform,
} from '../../electron/types';

declare global {
  interface Window {
    /** Set by `electron/preload.ts`; absent in the browser. */
    takingnotesDesktop?: DesktopBridge;
  }
}

/** The desktop bridge, or null when running in a browser. */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.takingnotesDesktop ?? null;
}
