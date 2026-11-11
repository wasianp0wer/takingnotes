import { APP_ORIGIN } from './appProtocol';

/**
 * Where the renderer may connect. Ollama is supported on this machine only
 * (spec §5), so loopback on any port and nothing else over plain http.
 * transformers.js loads the onnxruntime wasm from jsdelivr and models from the
 * Hugging Face Hub, which redirects file downloads to its CDN and Xet storage
 * hosts (`cdn-lfs*.huggingface.co`, `cdn-lfs*.hf.co`, `cas-bridge.xethub.hf.co`).
 * CSP checks every redirect hop, so those hosts must be listed too.
 */
const CONNECT_SOURCES = [
  "'self'",
  APP_ORIGIN,
  'http://localhost:*',
  'http://127.0.0.1:*',
  'https://cdn.jsdelivr.net',
  'https://huggingface.co',
  'https://*.huggingface.co',
  'https://*.hf.co',
];

const DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['default-src', ["'self'"]],
  // wasm-unsafe-eval lets WebAssembly compile; plain eval stays forbidden.
  // blob: because transformers.js fetches onnxruntime's wasm factory (.mjs)
  // from jsdelivr and import()s it as a blob: URL inside the Whisper worker;
  // without it no ORT backend loads at all (docs/desktop-spike.md). Only code
  // already running in the app can mint a blob: URL.
  ['script-src', ["'self'", "'wasm-unsafe-eval'", 'blob:']],
  ['worker-src', ["'self'", 'blob:']],
  // src/index.css @imports the TASA Orbiter face from Google Fonts.
  ['style-src', ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']],
  ['img-src', ["'self'", 'data:', 'blob:']],
  ['font-src', ["'self'", 'data:', 'https://fonts.gstatic.com']],
  ['media-src', ["'self'", 'blob:']],
  ['connect-src', CONNECT_SOURCES],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
];

/** The Content-Security-Policy header sent with every `app://` response. */
export function contentSecurityPolicy(): string {
  return DIRECTIVES.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

/**
 * `scheme://host[:port]`, or null for an unparseable URL. Computed by hand
 * because WHATWG `URL.origin` is the opaque `"null"` for non-special schemes
 * such as `app:`.
 */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.host) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** True when the main window may navigate to `url`: the app origin, plus the dev server's in dev. */
export function isAllowedNavigation(url: string, devUrl: string | null): boolean {
  const origin = originOf(url);
  if (origin === null) return false;
  if (origin === APP_ORIGIN) return true;
  return devUrl !== null && origin === originOf(devUrl);
}

/**
 * True for an http(s) URL off the app's own origins. Such links are handed to
 * the system browser (`shell.openExternal`); anything else is simply refused.
 */
export function isExternalHttpUrl(url: string, devUrl: string | null = null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !isAllowedNavigation(url, devUrl);
}

export type NavigationAction = 'allow' | 'open-external' | 'deny';

/**
 * What the shell does with a navigation, redirect or window-open to `url`:
 * stay in the app, hand an http(s) link to the system browser, or refuse.
 */
export function navigationAction(url: string, devUrl: string | null): NavigationAction {
  if (isAllowedNavigation(url, devUrl)) return 'allow';
  return isExternalHttpUrl(url, devUrl) ? 'open-external' : 'deny';
}
