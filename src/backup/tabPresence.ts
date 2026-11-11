/**
 * Counts the app's open tabs with Web Locks: each tab holds one exclusive
 * lock under a shared prefix for its whole life, and the browser releases it
 * when the tab goes away. Import uses the count to refuse while another tab
 * could still be writing to the database.
 */

const TAB_LOCK_PREFIX = 'takingnotes:tab:';

function defaultLocks(): LockManager | null {
  try {
    return globalThis.navigator?.locks ?? null;
  } catch {
    return null;
  }
}

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Holds this tab's presence lock until the tab closes. No-op without Web Locks. */
export function registerTabPresence(locks: LockManager | null = defaultLocks()): void {
  if (!locks) return;
  const held = locks.request(`${TAB_LOCK_PREFIX}${randomId()}`, { mode: 'exclusive' }, () =>
    new Promise<void>(() => {}),
  );
  held.catch(() => {
    // Lock refused: this tab simply goes uncounted.
  });
}

/** Number of tabs holding a presence lock, or `null` when Web Locks are missing. */
export async function countOpenTabs(locks: LockManager | null = defaultLocks()): Promise<number | null> {
  if (!locks) return null;
  try {
    const { held = [] } = await locks.query();
    return held.filter((lock) => lock.name?.startsWith(TAB_LOCK_PREFIX)).length;
  } catch {
    return null;
  }
}
