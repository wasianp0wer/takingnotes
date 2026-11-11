// Which permissions and devices the shell grants (spec §5): a fixed list, and
// only to the app's own origin (plus the Vite dev server in development).
import { APP_ORIGIN } from './appProtocol';
import { originOf } from './security';

export interface PermissionDetails {
  /** For `media`: what is being asked for (`audio` = microphone, `video` = camera). */
  mediaTypes?: readonly string[];
}

/** Granted outright. `media` is handled separately: audio only. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'bluetooth',
  'hid',
  'clipboard-sanitized-write',
  'fullscreen',
]);

const ALLOWED_DEVICE_TYPES: ReadonlySet<string> = new Set(['hid', 'bluetooth']);

/**
 * True when `origin` (a bare origin, an origin with a trailing slash as
 * Chromium sometimes writes it, or a full URL) is the app, or the dev server
 * when `devUrl` is set.
 */
export function isAppOrigin(origin: string, devUrl: string | null = null): boolean {
  const actual = originOf(origin);
  if (actual === null) return false;
  if (actual === APP_ORIGIN) return true;
  return devUrl !== null && actual === originOf(devUrl);
}

/** Microphone only: at least one media type, and every one of them `audio`. */
function isAudioOnly(mediaTypes: readonly string[] | undefined): boolean {
  return mediaTypes !== undefined && mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
}

/** The policy behind `setPermissionRequestHandler` and `setPermissionCheckHandler`. */
export function isPermissionAllowed(
  permission: string,
  requestingOrigin: string,
  details: PermissionDetails = {},
  devUrl: string | null = null,
): boolean {
  if (!isAppOrigin(requestingOrigin, devUrl)) return false;
  if (permission === 'media') return isAudioOnly(details.mediaTypes);
  return ALLOWED_PERMISSIONS.has(permission);
}

/** The policy behind `setDevicePermissionHandler`. */
export function isDeviceAllowed(details: { deviceType: string; origin: string }, devUrl: string | null = null): boolean {
  return ALLOWED_DEVICE_TYPES.has(details.deviceType) && isAppOrigin(details.origin, devUrl);
}

/** True when granting this request means the OS must let the app use the microphone (macOS). */
export function wantsMicrophone(permission: string, details: PermissionDetails): boolean {
  return permission === 'media' && (details.mediaTypes ?? []).includes('audio');
}
