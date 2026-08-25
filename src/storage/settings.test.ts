import { beforeEach, describe, expect, it } from 'vitest';

import { getSetting, setSetting } from '@/storage/settings';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('settings repository', () => {
  it('returns the fallback for an unset key', async () => {
    expect(await getSetting('visionModel', 'none')).toBe('none');
  });

  it('round-trips a string value', async () => {
    await setSetting('visionModel', 'my-model');
    expect(await getSetting('visionModel', 'none')).toBe('my-model');
  });

  it('round-trips an object value', async () => {
    await setSetting('layout', { columns: 2, dense: true });
    expect(await getSetting('layout', { columns: 1, dense: false })).toEqual({
      columns: 2,
      dense: true,
    });
  });

  it('overwrites an existing value', async () => {
    await setSetting('visionModel', 'first');
    await setSetting('visionModel', 'second');
    expect(await getSetting('visionModel', 'none')).toBe('second');
  });

  it('distinguishes a stored null from an unset key', async () => {
    await setSetting('maybe', null);
    expect(await getSetting<string | null>('maybe', 'fallback')).toBeNull();
  });
});
