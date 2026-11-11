import path from 'node:path';

/**
 * The privileged custom scheme the production build is served from. A real
 * scheme (not `file://`) gives module workers, WASM, `fetch` and IndexedDB a
 * stable, secure origin, and keeps the renderer's storage keyed to one origin
 * across releases. Changing either value orphans every user's data.
 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'takingnotes';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const INDEX_HTML = 'index.html';

/**
 * Maps an `app://takingnotes/<path>` request to an absolute file under `root`.
 *
 * - `/`, and any path whose last segment has no file extension, maps to
 *   `index.html` (SPA fallback: client routes are not files).
 * - Returns `null` for another scheme or host, for malformed percent-encoding,
 *   a NUL byte or a backslash, and for any path that would leave `root` once
 *   decoded (`..%2f`, `%2e%2e%2f`). The URL parser has already removed literal
 *   and whole-segment `%2e%2e` dot-segments, so what is left to catch is a
 *   separator smuggled inside a segment.
 *
 * It does not check that the file exists: the protocol handler answers 404.
 */
export function resolveAppRequest(url: string, root: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const segments = decoded.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;

  const last = segments.at(-1);
  if (last === undefined || path.extname(last) === '') return path.join(root, INDEX_HTML);

  const base = path.resolve(root);
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}
