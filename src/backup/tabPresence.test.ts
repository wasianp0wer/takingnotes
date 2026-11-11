import { afterEach, describe, expect, it, vi } from 'vitest';

import { countOpenTabs, registerTabPresence } from '@/backup/tabPresence';
import { fakeLockManager } from '@/test/fakeLocks';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tab presence', () => {
  it('two registered tabs count 2', async () => {
    const locks = fakeLockManager();
    // An unrelated lock must not be counted.
    void locks.request('something-else', () => new Promise<void>(() => {}));
    registerTabPresence(locks);
    registerTabPresence(locks);
    expect(await countOpenTabs(locks)).toBe(2);
  });

  it('a single tab counts 1', async () => {
    const locks = fakeLockManager();
    registerTabPresence(locks);
    expect(await countOpenTabs(locks)).toBe(1);
  });

  it('countOpenTabs returns null without navigator.locks', async () => {
    vi.stubGlobal('navigator', {});
    expect(await countOpenTabs()).toBeNull();
  });

  it('registerTabPresence is a no-op without navigator.locks', () => {
    vi.stubGlobal('navigator', {});
    expect(() => registerTabPresence()).not.toThrow();
  });

  it('uses navigator.locks by default', async () => {
    const locks = fakeLockManager();
    vi.stubGlobal('navigator', { locks });
    registerTabPresence();
    expect(await countOpenTabs()).toBe(1);
  });
});
