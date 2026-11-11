// Where the desktop app keeps its profile (Electron's `userData`: IndexedDB,
// localStorage, caches, and the single-instance lock). Pure; main.ts applies it
// with `app.setPath('userData', …)` before anything reads the profile.
import path from 'node:path';

/** The packaged app's profile directory name. Fixed forever: it holds the user's data. */
export const PROFILE_DIR = 'TakingNotes';
/** The dev shell's own profile, so `desktop:dev` never shares the installed app's data or lock. */
export const DEV_PROFILE_DIR = 'TakingNotes Dev';

/**
 * The `userData` path to set, or null to leave Electron's choice alone (an
 * explicit `--user-data-dir`, as the spike and packaged-app checks use).
 * Packaged: `<appData>/TakingNotes`, the directory `app.setName('TakingNotes')`
 * already gave, so existing installs need no migration.
 */
export function userDataPath(opts: {
  appData: string;
  devUrl: string | null;
  hasUserDataDirSwitch: boolean;
}): string | null {
  if (opts.hasUserDataDirSwitch) return null;
  return path.join(opts.appData, opts.devUrl ? DEV_PROFILE_DIR : PROFILE_DIR);
}
