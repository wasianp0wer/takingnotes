/**
 * In-memory `LockManager` stand-in. Grants every request at once (no
 * contention modelling) and keeps the lock held until its callback's
 * promise settles, which is all tab-presence counting needs.
 */
export function fakeLockManager(): LockManager {
  const held: LockInfo[] = [];
  const request = ((name: string, ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as (lock: Lock | null) => unknown;
    const options = (rest.length > 1 ? rest[0] : {}) as LockOptions;
    const info: LockInfo = { name, mode: options.mode ?? 'exclusive', clientId: 'fake' };
    held.push(info);
    const release = () => {
      const i = held.indexOf(info);
      if (i >= 0) held.splice(i, 1);
    };
    return Promise.resolve(callback({ name, mode: info.mode! } as Lock)).finally(release);
  }) as LockManager['request'];
  return {
    request,
    query: async () => ({ held: [...held], pending: [] }),
  } as LockManager;
}
