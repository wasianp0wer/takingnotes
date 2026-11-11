// Electron main process: wiring only. The decisions it acts on (which file a
// request maps to, the CSP, which URLs may load) live in pure modules beside it
// so they can be tested without Electron.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { APP_ORIGIN, APP_SCHEME, resolveAppRequest } from './appProtocol';
import { contentSecurityPolicy, isAllowedNavigation, isExternalHttpUrl } from './security';

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

  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, devUrl)) return;
    event.preventDefault();
    if (isExternalHttpUrl(url, devUrl)) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url, devUrl)) void shell.openExternal(url);
    return { action: 'deny' };
  });

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

  void app.whenReady().then(() => {
    registerAppProtocol();
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
