// Electron main process: wiring only. The decisions it acts on (which file a
// request maps to, the CSP, which URLs may load) live in pure modules beside it
// so they can be tested without Electron.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  systemPreferences,
  webContents as allWebContents,
  type HIDDevice,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { APP_ORIGIN, APP_SCHEME, resolveAppRequest } from './appProtocol';
import { CHOOSER_CANCEL, CHOOSER_MESSAGE, CHOOSER_SELECT, OLLAMA_PROBE } from './channels';
import { createDeviceChooser, type DeviceChooser } from './devices';
import { probeOllama } from './ollamaProbe';
import { isDeviceAllowed, isPermissionAllowed, wantsMicrophone } from './permissions';
import { contentSecurityPolicy, navigationAction, originOf } from './security';
import type { ChooserDevice } from './types';

/** Fixed forever: it keys the per-app profile directory, and with it the user's data. */
const APP_ID = 'org.takingnotes.app';
const PRODUCT_NAME = 'TakingNotes';

/** Set by `scripts/electron-dev.mjs`; when present the window loads the Vite dev server. */
const devUrl = process.env.TAKINGNOTES_DEV_URL || null;

/** This file is bundled to `dist-electron/main.cjs`; the renderer build sits beside it in `dist/`. */
const rendererRoot = path.join(__dirname, '..', 'dist');
const preloadPath = path.join(__dirname, 'preload.cjs');

app.setAppUserModelId(APP_ID);
app.setName(PRODUCT_NAME);

// Must run before `ready`. `standard` + `secure` give the scheme a real origin
// that counts as a secure context (IndexedDB, WebGPU, module workers);
// `supportFetchAPI`, `corsEnabled` and `stream` let fetch() and media read it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

function registerAppProtocol(): void {
  const csp = contentSecurityPolicy();
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppRequest(request.url, rendererRoot);
    if (file === null) return notFound();
    let response: Response;
    try {
      response = await net.fetch(pathToFileURL(file).toString());
    } catch {
      return notFound();
    }
    if (!response.ok) return notFound();
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  });
}

/**
 * Keeps a webContents on the app origin (spec §5). Applied to every
 * webContents through `web-contents-created`, so the main window and anything
 * created later get the same rules.
 *
 * - Main-frame navigation (`will-navigate`) to an http(s) URL off the app
 *   opens the system browser instead; anything else off-origin is refused.
 * - Sub-frame navigation (`will-frame-navigate`) and redirects (`will-redirect`)
 *   off the app origin are refused, never opened: they are not a user's click.
 *   `will-frame-navigate` also fires for the main frame, which `will-navigate`
 *   already handles, so it only acts on sub-frames to avoid opening twice.
 * - `window.open` and target=_blank never create a window.
 */
function guardWebContents(contents: WebContents): void {
  contents.on('will-navigate', (event) => {
    const action = navigationAction(event.url, devUrl);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'open-external') void shell.openExternal(event.url);
  });
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (navigationAction(event.url, devUrl) !== 'allow') event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (navigationAction(event.url, devUrl) !== 'allow') event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (navigationAction(url, devUrl) === 'open-external') void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** One device chooser per webContents that has the preload (in practice: the main window). */
const choosers = new Map<number, DeviceChooser>();

/**
 * Gives `contents` an in-app device chooser (spec §5). Electron has no picker
 * of its own: without a `select-bluetooth-device` handler that calls
 * preventDefault, Electron picks the first device found; the HID equivalent
 * cancels. Both now go to the renderer's picker over the bridge.
 */
function attachDeviceChooser(contents: WebContents): DeviceChooser {
  const chooser = createDeviceChooser((msg) => {
    if (!contents.isDestroyed()) contents.send(CHOOSER_MESSAGE, msg);
  });
  choosers.set(contents.id, chooser);

  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    const list: ChooserDevice[] = devices.map((d) => ({ id: d.deviceId, name: d.deviceName }));
    chooser.offer('bluetooth', list, callback);
  });

  // A pending request belongs to the document that made it.
  const dropPending = () => chooser.cancelPending();
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) dropPending();
  });
  contents.on('render-process-gone', dropPending);
  contents.once('destroyed', () => {
    dropPending();
    choosers.delete(contents.id);
  });
  return chooser;
}

function hidToChooser(device: HIDDevice): ChooserDevice {
  return { id: device.deviceId, name: device.name };
}

/** Whether an IPC message came from a frame on the app origin. */
function isAppOriginSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!event.senderFrame && isAppOriginUrl(event.senderFrame.url);
}

/** The chooser for the webContents an IPC message came from, if it has one. */
function chooserForSender(event: IpcMainEvent): DeviceChooser | null {
  if (!isAppOriginSender(event)) return null;
  return choosers.get(event.sender.id) ?? null;
}

function isAppOriginUrl(url: string): boolean {
  const origin = originOf(url);
  return origin === APP_ORIGIN || (devUrl !== null && origin === originOf(devUrl));
}

/**
 * `ollama:probe` (spec §6): lets the Ollama setup check tell "not running"
 * from "running but refusing this origin". Localhost only; see ./ollamaProbe.
 */
function registerOllamaIpc(): void {
  ipcMain.handle(OLLAMA_PROBE, async (event, baseUrl: unknown) => {
    if (!isAppOriginSender(event)) return false;
    return probeOllama(baseUrl, async (url, init) => {
      const response = await net.fetch(url, init);
      // Only the fact of an answer matters; don't keep the body open.
      void response.body?.cancel().catch(() => {});
      return response;
    });
  });
}

function registerChooserIpc(): void {
  ipcMain.on(CHOOSER_SELECT, (event, requestId: unknown, deviceId: unknown) => {
    if (typeof requestId !== 'string' || typeof deviceId !== 'string') return;
    chooserForSender(event)?.select(requestId, deviceId);
  });
  ipcMain.on(CHOOSER_CANCEL, (event, requestId: unknown) => {
    if (typeof requestId !== 'string') return;
    chooserForSender(event)?.cancel(requestId);
  });
}

/**
 * Permission and device handlers on the default session (spec §5): the fixed
 * list in ./permissions, only for the app origin. HID selection goes through
 * the same chooser as Bluetooth.
 */
function configureSessionPermissions(): void {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const origin = ('securityOrigin' in details && details.securityOrigin) || details.requestingUrl;
    if (!isPermissionAllowed(permission, origin, { mediaTypes }, devUrl)) {
      callback(false);
      return;
    }
    // macOS: Chromium also needs the OS-level microphone grant (TCC). This shows
    // the system prompt the first time, and resolves at once after that.
    if (process.platform === 'darwin' && wantsMicrophone(permission, { mediaTypes })) {
      systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
      return;
    }
    callback(true);
  });

  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const mediaTypes = details.mediaType ? [details.mediaType] : undefined;
    const origin = details.securityOrigin || requestingOrigin;
    return isPermissionAllowed(permission, origin, { mediaTypes }, devUrl);
  });

  ses.setDevicePermissionHandler((details) => isDeviceAllowed(details, devUrl));

  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const contents = details.frame ? allWebContents.fromFrame(details.frame) : undefined;
    const chooser = contents ? choosers.get(contents.id) : undefined;
    if (!chooser || !details.frame || !isAppOriginUrl(details.frame.url)) {
      callback();
      return;
    }
    let devices = details.deviceList.map(hidToChooser);
    // Electron reports hot-plugged devices separately while the picker is open.
    const added = (_event: unknown, d: { device: HIDDevice }) => {
      devices = [...devices.filter((x) => x.id !== d.device.deviceId), hidToChooser(d.device)];
      chooser.update(devices);
    };
    const removed = (_event: unknown, d: { device: HIDDevice }) => {
      devices = devices.filter((x) => x.id !== d.device.deviceId);
      chooser.update(devices);
    };
    // The chooser answers every request exactly once (pick, cancel, or
    // superseded), so that is where the hot-plug listeners come off.
    chooser.open('hid', devices, (deviceId) => {
      ses.removeListener('hid-device-added', added);
      ses.removeListener('hid-device-removed', removed);
      if (deviceId) callback(deviceId);
      else callback();
    });
    ses.on('hid-device-added', added);
    ses.on('hid-device-removed', removed);
  });

  // Windows/Linux only (macOS pairs on its own). The brief calls this
  // `bluetooth-pairing-request`; Electron 45's API is this session handler.
  // Untested: no Windows machine. Plain confirmation is accepted; PIN pairing
  // would need UI the app doesn't have, so it is cancelled and logged.
  ses.setBluetoothPairingHandler((details, callback) => {
    if (details.pairingKind === 'confirm') {
      callback({ confirmed: true });
      return;
    }
    console.warn(`[takingnotes] Bluetooth pairing "${details.pairingKind}" for ${details.deviceId} is not supported; cancelled.`);
    callback({ confirmed: false });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  attachDeviceChooser(window.webContents);
  window.on('closed', () => {
    mainWindow = null;
  });
  void window.loadURL(devUrl ?? `${APP_ORIGIN}/`);
  return window;
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

if (!app.requestSingleInstanceLock()) {
  // Another copy already owns the profile; it focuses its window (below).
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);

  app.on('web-contents-created', (_event, contents) => {
    // The app never uses <webview>; refuse any attempt to attach one.
    contents.on('will-attach-webview', (event) => event.preventDefault());
    guardWebContents(contents);
  });

  void app.whenReady().then(() => {
    registerAppProtocol();
    configureSessionPermissions();
    registerChooserIpc();
    registerOllamaIpc();
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
