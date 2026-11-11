// The only bridge between the sandboxed renderer and Electron. Keep it narrow
// and typed: the renderer sees `window.takingnotesDesktop` and nothing else.
// Its shape is `DesktopBridge` in ./types, which the renderer also reads
// (src/desktop/bridge.ts), so the two cannot drift apart.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHOOSER_CANCEL, CHOOSER_MESSAGE, CHOOSER_SELECT } from './channels';
import type { ChooserMessage, DesktopBridge } from './types';

const bridge: DesktopBridge = {
  platform: process.platform,
  devices: {
    onChooser(fn) {
      // Wrap the listener so the renderer never sees the IpcRendererEvent
      // (it carries `sender`, i.e. ipcRenderer itself).
      const listener = (_event: IpcRendererEvent, msg: ChooserMessage) => fn(msg);
      ipcRenderer.on(CHOOSER_MESSAGE, listener);
      return () => {
        ipcRenderer.removeListener(CHOOSER_MESSAGE, listener);
      };
    },
    select(requestId, deviceId) {
      ipcRenderer.send(CHOOSER_SELECT, String(requestId), String(deviceId));
    },
    cancel(requestId) {
      ipcRenderer.send(CHOOSER_CANCEL, String(requestId));
    },
  },
};

contextBridge.exposeInMainWorld('takingnotesDesktop', bridge);
