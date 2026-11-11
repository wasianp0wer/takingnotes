// The only bridge between the sandboxed renderer and Electron. Keep it narrow
// and typed: the renderer sees `window.takingnotesDesktop` and nothing else.
import { contextBridge } from 'electron';

export interface TakingNotesDesktopBridge {
  readonly platform: NodeJS.Platform;
}

const bridge: TakingNotesDesktopBridge = {
  platform: process.platform,
};

contextBridge.exposeInMainWorld('takingnotesDesktop', bridge);
